import '@shopify/ui-extensions/preact';
// Brings the JSX types for the components this target may render.
import '@shopify/ui-extensions/purchase.checkout.block.render';
import {render} from 'preact';
import {useState} from 'preact/hooks';
import {
  useApplyAttributeChange,
  useAttributeValues,
  useBuyerJourneyIntercept,
  useCartLines,
  useSettings,
} from '@shopify/ui-extensions/checkout/preact';

export default function extension() {
  render(<VatReliefConfirmation />, document.body);
}

/**
 * Read-back of the buyer's VAT relief declaration at checkout.
 *
 * Betsy's item 6. The relief itself is claimed on the cart page, where ticking
 * the box swaps the line to the zero-rated variant. By checkout the price is
 * already net and the merchandise is already non-taxable, so nothing here can
 * change the tax — this block exists to put the declaration in front of the
 * buyer one last time, immediately before they pay.
 *
 * Two shapes, chosen by the merchant in the checkout editor:
 *
 *   require_confirmation = false   Betsy's spec exactly: an inert banner.
 *   require_confirmation = true    the same banner plus a checkbox the buyer
 *                                  MUST tick before checkout will proceed.
 *
 * ## Where the enforcement actually lives
 *
 * NOT here. `extensions/vat-relief-validation` requires
 * `_vat_relief_confirmed_at` at `buyerJourney.step === CHECKOUT_COMPLETION`,
 * server-side, on every checkout surface, with no merchant toggle. That is the
 * gate.
 *
 * The intercept below is a second layer kept for one reason: feedback. A
 * validation function error surfaces as a generic checkout message; the
 * intercept puts the error directly under the checkbox the buyer needs to tick.
 * It is also deprecated (`@deprecated` in this API version) and only fires when
 * the merchant has granted `block_progress` in the checkout editor — a
 * declined permission silently turns every `behavior: 'block'` into an `allow`.
 *
 * So it is allowed to fail. When it does, or when the API drops it, the
 * validation function still stops the order.
 */

/* Mirrors app/lib/vat-relief.ts. Duplicated because an extension is its own
 * package and cannot import from the app. Change both. */
const DECLARATION_ATTRIBUTE = 'VAT relief declaration';
// Hidden (leading underscore) sibling written on the cart page. Optional
// throughout: if the surface filters underscore-prefixed keys out of
// line.attributes, the banner still renders, just without "Declared <time>".
const DECLARED_AT_ATTRIBUTE = '_vat_relief_declared_at';
// Written here, at checkout. The orders/create webhook reads it back.
const CONFIRMED_AT_ATTRIBUTE = '_vat_relief_confirmed_at';

interface BannerSettings {
  [key: string]: string | number | boolean | undefined;
  heading?: string;
  body?: string;
  require_confirmation?: boolean;
}

function attributeValue(
  attributes: readonly {key: string; value?: string | null}[] | undefined,
  key: string,
): string | null {
  const match = attributes?.find((attribute) => attribute.key === key);
  return match?.value ?? null;
}

/** ISO timestamp -> something a human can read. Falls back to the raw string. */
function formatDeclaredAt(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function VatReliefConfirmation() {
  const settings = useSettings<BannerSettings>();
  const lines = useCartLines();
  // State lives in the cart attribute, not in the component. A checkout that
  // re-renders, or a buyer who navigates back a step, then still reads the
  // truth rather than a stale local boolean.
  const [confirmedAt] = useAttributeValues([CONFIRMED_AT_ATTRIBUTE]);
  const applyAttributeChange = useApplyAttributeChange();
  // Only surfaced after the buyer actually tries to proceed. Nagging before
  // they have done anything wrong is how a compliance control starts getting
  // ignored.
  const [showError, setShowError] = useState(false);

  const declared = lines.filter(
    (line) => attributeValue(line.attributes, DECLARATION_ATTRIBUTE) !== null,
  );

  const confirmed = Boolean(confirmedAt);
  const mustConfirm = Boolean(settings.require_confirmation) && declared.length > 0;

  /* Registered unconditionally and at the top level of the extension's root
   * component, per the hook's contract — it must not sit inside something that
   * can unmount. Everything it reads is captured fresh on each render. */
  useBuyerJourneyIntercept(({canBlockProgress}) => {
    if (!mustConfirm || confirmed) {
      return {behavior: 'allow'};
    }

    if (!canBlockProgress) {
      // The merchant did not grant block_progress. Cannot stop them; still say
      // why, so a misconfigured checkout is visible rather than silently inert.
      return {behavior: 'allow', perform: () => setShowError(true)};
    }

    return {
      behavior: 'block',
      // Not shown to the buyer — Shopify's own debugging and metrics only.
      reason: 'VAT relief declaration not confirmed',
      errors: [
        {
          message:
            'Please confirm the VAT relief declaration before continuing, or ' +
            'return to your cart and untick VAT relief.',
        },
      ],
      perform: () => setShowError(true),
    };
  });

  // No declaration in this cart — render nothing at all rather than an empty
  // block. A merchant-placed block that always occupies space is worse than one
  // that appears only when it has something to say.
  if (!declared.length) {
    return null;
  }

  /* Which moment to show.
   *
   * With the checkbox on, the declaration is made HERE, and showing the
   * cart-page time next to an unticked box reads as "already declared" when
   * nothing has been declared yet. So: the confirmation time, and nothing at
   * all until they tick.
   *
   * With the checkbox off the banner is a read-back of the cart-page tick, so
   * that is the time worth showing. Earliest across lines — a buyer can tick
   * one box, carry on shopping and tick another later, and the first one is
   * what belongs on the record. */
  const cartDeclaredAt =
    declared
      .map((line) => attributeValue(line.attributes, DECLARED_AT_ATTRIBUTE))
      .filter((value): value is string => Boolean(value))
      .sort()[0] ?? null;

  const declaredAt = formatDeclaredAt(
    mustConfirm ? (confirmed ? (confirmedAt ?? null) : null) : cartDeclaredAt,
  );

  const heading = settings.heading || 'VAT relief declared';
  const body =
    settings.body ||
    'You have declared that you are chronically sick or disabled and that these ' +
      'goods are for your personal or domestic use. VAT has been removed from the ' +
      'items listed below.';
  const onConfirmationChange = (event: Event) => {
    const checked = (event.currentTarget as {checked?: boolean} | null)?.checked;
    // Fire and forget. A failed write leaves the attribute as it was, and the
    // checkbox re-reads from it on the next render, so the UI cannot drift away
    // from what was actually recorded.
    void applyAttributeChange(
      checked
        ? {
            type: 'updateAttribute',
            key: CONFIRMED_AT_ATTRIBUTE,
            value: new Date().toISOString(),
          }
        : {type: 'removeAttribute', key: CONFIRMED_AT_ATTRIBUTE},
    );
  };

  return (
    <s-banner heading={heading} tone="info">
      <s-stack direction="block" gap="base">
        {/* The declaration IS the checkbox label — one piece of copy, ticked or
            not ticked. Splitting it into a paragraph plus a shorter "I confirm
            the above" label gives legal two strings that can drift apart, and
            leaves the buyer agreeing to a sentence that only points at the real
            one. s-checkbox takes no children, so it goes in `label`. */}
        {mustConfirm ? (
          <s-stack direction="block" gap="small-500">
            <s-checkbox
              label={body}
              checked={confirmed}
              onChange={onConfirmationChange}
            />
            {showError && !confirmed ? (
              <s-text>
                You must tick the declaration before you can continue.
              </s-text>
            ) : null}
          </s-stack>
        ) : (
          <s-paragraph>{body}</s-paragraph>
        )}

        <s-stack direction="block" gap="small-500">
          {declared.map((line) => (
            <s-text key={line.id}>
              {line.merchandise.title} × {line.quantity}
            </s-text>
          ))}
        </s-stack>

        {/* No `type` on these. The root tsconfig typechecks every .tsx in the
            repo against @shopify/polaris-types (the ADMIN component types),
            where s-text's type union is a different, narrower set than the
            checkout one — so anything valid here but not there breaks
            `npm run typecheck` at the root. */}
        {declaredAt ? <s-text>Declared {declaredAt}</s-text> : null}

        <s-text>
          This declaration is recorded against your order. To change it, go back
          to your cart and untick the VAT relief box.
        </s-text>
      </s-stack>
    </s-banner>
  );
}
