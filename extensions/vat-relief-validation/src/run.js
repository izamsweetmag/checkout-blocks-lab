// @ts-check

/**
 * VAT relief declaration gate.
 *
 * The zero-rated variant can be reached without ever seeing the cart-page
 * checkbox — Buy it now, the cart drawer's checkout button, a saved /checkout
 * link, or by un-hiding the variant picker in devtools. Every one of those
 * produces a line that is priced net and carries NO record of the buyer
 * declaring eligibility, which is the one thing HMRC actually cares about.
 *
 * Nothing in the theme can close that: it all runs in the browser. This does,
 * because it runs on Shopify's side of the checkout.
 *
 * The rule: a line on a relief variant must carry the "VAT relief declaration"
 * attribute. The name is deliberately distinct from the "VAT relief" variant
 * OPTION — both render on the cart and the invoice, and identical labels there
 * read as a duplicate.
 * No attribute, no checkout.
 *
 * @typedef {import("../generated/api").RunInput} RunInput
 * @typedef {import("../generated/api").FunctionRunResult} FunctionRunResult
 * @typedef {import("../generated/api").FunctionError} FunctionError
 */

const NO_ERRORS = { errors: [] };

/**
 * @param {RunInput} input
 * @returns {FunctionRunResult}
 */
export function run(input) {
  const lines = input?.cart?.lines ?? [];

  /** @type {FunctionError[]} */
  const errors = [];

  for (const line of lines) {
    const merchandise = line.merchandise;

    // Custom (non-variant) merchandise can't be a relief variant.
    if (!merchandise || merchandise.__typename !== 'ProductVariant') continue;

    // Not a relief variant — nothing to check.
    if (!merchandise.reliefPair?.value) continue;

    // Relief variant WITH a declaration — this is the happy path.
    const declared = line.declaration?.value;
    if (declared && declared.trim() !== '') continue;

    // Relief variant, no declaration. Block, and name the product so the
    // buyer knows which line to go and fix.
    const productTitle = merchandise.product?.title ?? 'this item';

    // NOTE: this target runs on cart writes as well as at checkout, so the
    // wording has to make sense when the buyer has not reached checkout yet —
    // e.g. when they pick the relief variant on the product page and hit
    // Add to cart.
    errors.push({
      localizedMessage:
        `VAT relief for ${productTitle} must be confirmed in your cart. ` +
        `Please tick the VAT relief box on the cart page.`,
      target: '$.cart',
    });
  }

  if (!errors.length) {
    return NO_ERRORS;
  }

  return { errors };
}
