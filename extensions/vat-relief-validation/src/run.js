// @ts-check

/**
 * VAT relief declaration gate.
 *
 * Two rules, enforced at two different stages of the buyer journey.
 *
 * ## Rule 1 — every relief line carries a cart-page declaration
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
 * The attribute name is deliberately distinct from the "VAT relief" variant
 * OPTION — both render on the cart and the invoice, and identical labels there
 * read as a duplicate.
 *
 * ## Rule 2 — the buyer re-attests at checkout
 *
 * The cart-page declaration is made two pages before payment, and it is made by
 * ticking a box next to a price change. The checkout confirmation is the one
 * that puts the responsibility on the customer: an affirmative act, at the
 * moment of paying, against the full declaration wording.
 *
 * The checkout UI extension renders that checkbox and writes
 * `_vat_relief_confirmed_at` when it is ticked. That extension can also block
 * progress itself, via useBuyerJourneyIntercept — but that is deprecated, and
 * it only works if the merchant has granted the block_progress capability in
 * the checkout editor. A merchant who declines it, or an API version that drops
 * the hook, silently turns the gate off.
 *
 * This is the gate that actually holds: server-side, on every checkout surface,
 * with no merchant toggle.
 *
 * `buyerJourney.step` is what makes it possible. This target runs on cart
 * writes as well as at checkout, so requiring the confirmation unconditionally
 * would reject the CART for missing a box that only exists at checkout. Gating
 * on CHECKOUT_COMPLETION requires it at exactly one moment: the buyer
 * finalising the purchase.
 *
 * @typedef {import("../generated/api").RunInput} RunInput
 * @typedef {import("../generated/api").FunctionRunResult} FunctionRunResult
 * @typedef {import("../generated/api").FunctionError} FunctionError
 */

const NO_ERRORS = { errors: [] };

/**
 * The buyer is finalising the purchase — reviewing the order before paying.
 *
 * Deliberately NOT CHECKOUT_INTERACTION. That fires while they are typing an
 * address, and blocking then puts an error on screen before they have had any
 * chance to reach the checkbox. Widen this to include CHECKOUT_INTERACTION if
 * you want the error to appear earlier, at the cost of that.
 */
const CONFIRMATION_REQUIRED_AT = 'CHECKOUT_COMPLETION';

/**
 * @param {RunInput} input
 * @returns {FunctionRunResult}
 */
export function run(input) {
  const lines = input?.cart?.lines ?? [];

  /** @type {FunctionError[]} */
  const errors = [];

  let reliefLineCount = 0;

  for (const line of lines) {
    const merchandise = line.merchandise;

    // Custom (non-variant) merchandise can't be a relief variant.
    if (!merchandise || merchandise.__typename !== 'ProductVariant') continue;

    // Not a relief variant — nothing to check.
    if (!merchandise.reliefPair?.value) continue;

    reliefLineCount += 1;

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

  /* Rule 2. Only at the final step, and only when there is something to
   * declare — a cart with no relief lines never sees this. */
  if (
    reliefLineCount > 0 &&
    input?.buyerJourney?.step === CONFIRMATION_REQUIRED_AT
  ) {
    const confirmedAt = input?.cart?.checkoutConfirmation?.value;
    if (!confirmedAt || confirmedAt.trim() === '') {
      errors.push({
        localizedMessage:
          'Please tick the VAT relief declaration to confirm you are eligible ' +
          'before completing your order. If you are not eligible, return to ' +
          'your cart and untick VAT relief.',
        target: '$.cart',
      });
    }
  }

  if (!errors.length) {
    return NO_ERRORS;
  }

  return { errors };
}
