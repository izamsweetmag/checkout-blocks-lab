/**
 * Shared VAT-relief constants and pure helpers.
 *
 * Kept out of the .server module so the admin UI can import them without
 * dragging server-only code into the client bundle.
 */

export const VAT_RATE = 0.2;

export const ELIGIBILITY_TAG = "VAT Exempt Opt";
export const CLONE_TAG = "vat-relief-clone";

export const METAFIELD_NAMESPACE = "vat_relief";
export const PAIRED_VARIANT_KEY = "paired_variant"; // original -> clone
export const ORIGINAL_VARIANT_KEY = "original_variant"; // clone -> original

/** Net (ex-VAT) price for a VAT-inclusive gross price, rounded to 2dp. */
export function netPrice(gross: string | number): string {
  const value = typeof gross === "string" ? Number(gross) : gross;
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid price: ${gross}`);
  }
  return (Math.round((value / (1 + VAT_RATE)) * 100) / 100).toFixed(2);
}

export interface EligibleVariant {
  id: string;
  title: string;
  sku: string | null;
  price: string;
  taxable: boolean;
  selectedOptions: { name: string; value: string }[];
  pairedVariantId: string | null;
  expectedClonePrice: string;
}

export interface EligibleProduct {
  id: string;
  title: string;
  handle: string;
  status: string;
  options: { name: string; values: string[] }[];
  variants: EligibleVariant[];
}

export interface ProvisionPlanRow {
  productTitle: string;
  variantTitle: string;
  grossPrice: string;
  clonePrice: string;
  vatRemoved: string;
  alreadyPaired: boolean;
}

export interface DriftRow {
  productTitle: string;
  variantTitle: string;
  originalPrice: string | null;
  clonePrice: string;
  expectedClonePrice: string | null;
  taxable: boolean;
  problem: string | null;
}

/** What provisioning WOULD do. Run this first and read it. */
export function buildProvisionPlan(
  products: EligibleProduct[],
): ProvisionPlanRow[] {
  return products.flatMap((product) =>
    product.variants.map((variant) => ({
      productTitle: product.title,
      variantTitle: variant.title,
      grossPrice: variant.price,
      clonePrice: variant.expectedClonePrice,
      vatRemoved: (
        Math.round(
          (Number(variant.price) - Number(variant.expectedClonePrice)) * 100,
        ) / 100
      ).toFixed(2),
      alreadyPaired: Boolean(variant.pairedVariantId),
    })),
  );
}
