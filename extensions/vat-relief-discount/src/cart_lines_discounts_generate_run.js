import {DiscountClass, ProductDiscountSelectionStrategy} from '../generated/api';

/**
 * UK standard VAT rate. Prices in this store are assumed to be TAX-INCLUSIVE
 * (that is how shop.resmed.com/GB displays them: £191.00 total, "VAT 20% £31.83"
 * of which is already inside that £191.00).
 *
 * The VAT element of a gross amount is therefore:
 *
 *   vat = gross - (gross / 1.20) = gross * 20/120 = gross / 6
 *
 * which is 16.667% of the gross price, NOT 20%.
 * Discounting 20% off a VAT-inclusive price over-refunds the buyer.
 */
const VAT_RATE = 0.2;
const VAT_ELEMENT_OF_GROSS = VAT_RATE / (1 + VAT_RATE); // 0.166666…

const ELIGIBILITY_TAG = 'VAT Exempt Opt';
const DECLARATION_ATTRIBUTE = '_vat_relief';

/**
 * @typedef {import("../generated/api").CartInput} RunInput
 * @typedef {import("../generated/api").CartLinesDiscountsGenerateRunResult} CartLinesDiscountsGenerateRunResult
 */

/**
 * @param {RunInput} input
 * @returns {CartLinesDiscountsGenerateRunResult}
 */
export function cartLinesDiscountsGenerateRun(input) {
  const lines = input?.cart?.lines ?? [];

  if (!lines.length) {
    return {operations: []};
  }

  // This has to be registered as a PRODUCT discount class for per-line targeting.
  if (!input.discount.discountClasses.includes(DiscountClass.Product)) {
    return {operations: []};
  }

  const candidates = [];

  for (const line of lines) {
    // 1. Buyer ticked the box on the cart page.
    const declared = line.vatRelief?.value === 'true';
    if (!declared) continue;

    // 2. The product is actually tagged as VAT-relief eligible.
    //    Never trust the line property on its own — it is buyer-editable.
    const tagged = line.merchandise?.product?.hasTags?.some(
      (entry) => entry.tag === ELIGIBILITY_TAG && entry.hasTag,
    );
    if (!tagged) continue;

    const gross = Number(line.cost.subtotalAmount.amount);
    if (!Number.isFinite(gross) || gross <= 0) continue;

    // Round to 2dp the way an invoice would.
    const vatElement = Math.round(gross * VAT_ELEMENT_OF_GROSS * 100) / 100;
    if (vatElement <= 0) continue;

    candidates.push({
      message: 'VAT relief',
      targets: [{cartLine: {id: line.id}}],
      value: {
        fixedAmount: {
          amount: vatElement,
          appliesToEachItem: false,
        },
      },
    });
  }

  if (!candidates.length) {
    return {operations: []};
  }

  return {
    operations: [
      {
        productDiscountsAdd: {
          candidates,
          selectionStrategy: ProductDiscountSelectionStrategy.All,
        },
      },
    ],
  };
}
