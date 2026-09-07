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
export const RELIEF_OPTION_NAME = "VAT relief";
export const RELIEF_OPTION_NO = "Standard VAT";
export const RELIEF_OPTION_YES = "VAT relief applied";

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
}

export interface DriftRow {
  productTitle: string;
  variantTitle: string;
  originalPrice: string | null;
  reliefPrice: string;
  expectedReliefPrice: string | null;
  taxable: boolean;
  problem: string | null;
}

export function reliefValueOf(options: SelectedOption[]): string | null {
  const option = options.find((o) => o.name === RELIEF_OPTION_NAME);
  return option ? option.value : null;
}

/** What provisioning WOULD do. Run this first and read it. */
export function buildProvisionPlan(
  products: EligibleProduct[],
): ProvisionPlanRow[] {
  return products.flatMap((product) =>
    product.variants
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
      })),
  );
}
