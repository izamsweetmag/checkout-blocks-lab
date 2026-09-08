/**
 * Shared VAT-relief constants and pure helpers.
 *
 * Kept out of the .server module so the admin UI can import them without
 * dragging server-only code into the client bundle.
 *
 * DESIGN: the zero-rated counterpart is a VARIANT of the same product, not a
 * separate clone product. Variants are not indexed as products, so nothing
 * extra appears in search or the catalogue, and image/title/handle are shared
 * by construction. The cost is that provisioning mutates the original product
 * by adding an option to it.
 */

export const VAT_RATE = 0.2;

/**
 * Eligibility is a PRODUCT metafield, not a tag.
 *
 * A tag is a free-text string anybody with product-edit access can typo, and
 * it carries no type. A boolean definition can only be true or false, shows as
 * a checkbox in admin, and can be reported on. This is the metafield ResMed
 * created: `custom.vat_relief_eligible`.
 *
 * Filtering products by it in the Admin API needs the definition to have the
 * `adminFilterable` capability. Without it Shopify does NOT error — it ignores
 * the filter and returns every product. `isEligibleProductValue` therefore
 * re-checks the value on every product we get back; see the note in
 * vat-relief.server.ts.
 */
export const ELIGIBILITY_NAMESPACE = "custom";
export const ELIGIBILITY_KEY = "vat_relief_eligible";
export const ELIGIBILITY_METAFIELD = `${ELIGIBILITY_NAMESPACE}.${ELIGIBILITY_KEY}`;

/**
 * True only for an explicit true. Accepts the string form as well as the
 * boolean type, because a definition typed `single_line_text_field` holding
 * "true" is a mistake we would rather tolerate than silently skip.
 */
export function isEligibleProductValue(raw: string | null | undefined): boolean {
  if (raw == null) return false;
  return raw.trim().toLowerCase() === "true";
}

/**
 * The option added to every eligible product.
 *
 * The VALUES are what the buyer sees: Shopify prints the variant title on the
 * checkout summary, the order confirmation and the invoice, and for a
 * single-option product the variant title is just the option value. "Yes" on
 * its own is meaningless there, so the values spell themselves out.
 */
/**
 * Shopify's hard ceiling: a product can carry at most 3 options
 * (`OPTIONS_OVER_LIMIT` from productOptionsCreate).
 *
 * Provisioning spends one of them. A product already using three — Size,
 * Colour, Length — cannot take the VAT relief option at all, and there is no
 * way around it: the swap needs a second variant, a second variant needs an
 * option to distinguish it, and there is no fourth option slot.
 *
 * Such a product needs a different answer (a separate relief product, or
 * collapsing two real options into one). Provisioning reports it and moves on
 * rather than failing the whole run.
 */
export const MAX_PRODUCT_OPTIONS = 3;

export const RELIEF_OPTION_NAME = "VAT relief";
export const RELIEF_OPTION_NO = "Standard VAT";
export const RELIEF_OPTION_YES = "VAT relief applied";

/* ---------------------------------------------------------------------------
 * Audit trail (Betsy's step 7)
 *
 * Three layers, written at three different moments, all landing on the order:
 *
 *   line item property   "VAT relief declaration"  cart page, per line
 *   cart attribute       "VAT relief declaration"  cart page, order-level mirror
 *   order metafield      custom.vat_eligibility_*  orders/create webhook
 *
 * The metafields are the HMRC-facing record: typed, queryable, and on the order
 * itself rather than on a free-text attribute anybody could have written.
 * ------------------------------------------------------------------------- */

/** Visible line property AND cart attribute. Same key on purpose. */
export const DECLARATION_ATTRIBUTE = "VAT relief declaration";
export const DECLARATION_VALUE = "Customer declared eligibility";
/** Hidden. Written on the cart page, when the box is first ticked. */
export const DECLARED_AT_ATTRIBUTE = "_vat_relief_declared_at";
/** Hidden. Written at checkout by the confirmation block, if enabled. */
export const CONFIRMED_AT_ATTRIBUTE = "_vat_relief_confirmed_at";

export const ORDER_METAFIELD_NAMESPACE = "custom";
export const ORDER_DECLARATION_KEY = "vat_eligibility_declaration";
export const ORDER_DECLARED_AT_KEY = "vat_eligibility_declaration_timestamp";

export interface NameValue {
  name?: string | null;
  value?: string | null;
}

export interface DeclarationRecord {
  declared: boolean;
  /** Earliest cart-page tick found, normalised to ISO-8601 with no ms. */
  declaredAt: string | null;
  /** Moment the buyer ticked the declaration at checkout. */
  confirmedAt: string | null;
  /**
   * The one that goes on the order metafield.
   *
   * The checkout tick when there is one, because that is the moment the buyer
   * agreed to the declaration WORDING — the cart-page tick is a price change
   * with a short label next to it, and the two can be days apart. Falls back to
   * the cart-page tick when the confirmation checkbox is switched off, so the
   * metafield still carries a real moment rather than nothing.
   */
  timestamp: string | null;
}

/**
 * Shopify's date_time metafield wants ISO-8601. `Date.toISOString()` includes
 * milliseconds, which it rejects, so they are trimmed here rather than at the
 * three call sites that could produce one.
 */
export function normaliseTimestamp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.toISOString().split(".")[0]}Z`;
}

function pick(attributes: NameValue[], name: string): string | null {
  const match = attributes.find((a) => a.name === name);
  const value = match?.value;
  return value && value.trim() !== "" ? value : null;
}

/**
 * What the buyer declared, read off an order.
 *
 * Reads the order's cart attributes first, then falls back to the line item
 * properties. The fallback is not belt-and-braces: the cart attributes are
 * rewritten wholesale on every toggle, so a cart edited through a route that
 * does not run our JS can arrive with per-line evidence and no order-level
 * mirror. The line properties are the primary record; the attributes are the
 * summary.
 */
export function readDeclaration(
  cartAttributes: NameValue[],
  lineProperties: NameValue[][],
): DeclarationRecord {
  const stamps: string[] = [];
  let declared = false;

  if (pick(cartAttributes, DECLARATION_ATTRIBUTE)) declared = true;
  const cartStamp = pick(cartAttributes, DECLARED_AT_ATTRIBUTE);
  if (cartStamp) stamps.push(cartStamp);

  for (const properties of lineProperties) {
    if (!pick(properties, DECLARATION_ATTRIBUTE)) continue;
    declared = true;
    const lineStamp = pick(properties, DECLARED_AT_ATTRIBUTE);
    if (lineStamp) stamps.push(lineStamp);
  }

  const declaredAt = stamps
    .map(normaliseTimestamp)
    .filter((s): s is string => Boolean(s))
    .sort()[0];

  const confirmedAt = normaliseTimestamp(
    pick(cartAttributes, CONFIRMED_AT_ATTRIBUTE),
  );
  // A declaration with no usable timestamp is still a declaration. Reporting it
  // as false because the clock was unreadable would be the wrong lie.
  const firstDeclaredAt = declared ? (declaredAt ?? null) : null;

  return {
    declared,
    declaredAt: firstDeclaredAt,
    confirmedAt,
    timestamp: declared ? (confirmedAt ?? firstDeclaredAt) : null,
  };
}

export const METAFIELD_NAMESPACE = "vat_relief";
export const PAIRED_VARIANT_KEY = "paired_variant"; // taxed -> relief
export const ORIGINAL_VARIANT_KEY = "original_variant"; // relief -> taxed

/** Net (ex-VAT) price for a VAT-inclusive gross price, rounded to 2dp. */
export function netPrice(gross: string | number): string {
  const value = typeof gross === "string" ? Number(gross) : gross;
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid price: ${gross}`);
  }
  return (Math.round((value / (1 + VAT_RATE)) * 100) / 100).toFixed(2);
}

export interface SelectedOption {
  name: string;
  value: string;
}

export interface EligibleVariant {
  id: string;
  title: string;
  sku: string | null;
  price: string;
  taxable: boolean;
  selectedOptions: SelectedOption[];
  /** True when this variant IS the zero-rated counterpart. */
  isReliefVariant: boolean;
  pairedVariantId: string | null;
  expectedReliefPrice: string;
}

export interface EligibleProduct {
  id: string;
  title: string;
  handle: string;
  status: string;
  options: { name: string; values: string[] }[];
  hasReliefOption: boolean;
  /** Raw value of custom.vat_relief_eligible, for display. */
  eligibilityValue: string | null;
  eligible: boolean;
  variants: EligibleVariant[];
}

/**
 * The result of asking for eligible products.
 *
 * `filterHonored` is false when Shopify ignored the metafield filter — the
 * symptom of a definition without the adminFilterable capability. The products
 * are still correct (we re-filter in code); the flag exists so the admin UI can
 * say why the query scanned the whole catalogue.
 */
export interface EligibleProductsResult {
  products: EligibleProduct[];
  scanned: number;
  filterHonored: boolean;
}

export interface ProvisionPlanRow {
  productTitle: string;
  variantTitle: string;
  grossPrice: string;
  reliefPrice: string;
  vatRemoved: string;
  alreadyPaired: boolean;
  needsOption: boolean;
  /** Why this row cannot be provisioned, or null if it can. */
  blocked: string | null;
}

export interface DriftRow {
  productTitle: string;
  variantTitle: string;
  originalPrice: string | null;
  reliefPrice: string;
  expectedReliefPrice: string | null;
  /** The pair shares one SKU on purpose — it is what the ERP recognises. */
  originalSku: string | null;
  reliefSku: string | null;
  taxable: boolean;
  problem: string | null;
}

/**
 * Why this product cannot take the relief option, or null if it can.
 *
 * Checked before provisioning rather than after, because the failure arrives
 * from Shopify as a bare OPTIONS_OVER_LIMIT and by then the run is already
 * part-done.
 */
export function optionCapacityProblem(product: EligibleProduct): string | null {
  if (product.hasReliefOption) return null;
  if (product.options.length < MAX_PRODUCT_OPTIONS) return null;

  const names = product.options.map((option) => option.name).join(", ");
  return (
    `already uses all ${MAX_PRODUCT_OPTIONS} option slots (${names}) — ` +
    `no room for a "${RELIEF_OPTION_NAME}" option`
  );
}

export function reliefValueOf(options: SelectedOption[]): string | null {
  const option = options.find((o) => o.name === RELIEF_OPTION_NAME);
  return option ? option.value : null;
}

/** What provisioning WOULD do. Run this first and read it. */
export function buildProvisionPlan(
  products: EligibleProduct[],
): ProvisionPlanRow[] {
  return products.flatMap((product) => {
    const blocked = optionCapacityProblem(product);

    return product.variants
      .filter((variant) => !variant.isReliefVariant)
      .map((variant) => ({
        productTitle: product.title,
        variantTitle: variant.title,
        grossPrice: variant.price,
        reliefPrice: variant.expectedReliefPrice,
        vatRemoved: (
          Math.round(
            (Number(variant.price) - Number(variant.expectedReliefPrice)) * 100,
          ) / 100
        ).toFixed(2),
        alreadyPaired: Boolean(variant.pairedVariantId),
        needsOption: !product.hasReliefOption,
        blocked,
      }));
  });
}
