import '@shopify/ui-extensions/preact';
// Brings the JSX types for the components this target may render.
import '@shopify/ui-extensions/purchase.checkout.block.render';
import {render} from 'preact';
import {
  useCartLines,
  useSettings,
} from '@shopify/ui-extensions/checkout/preact';

export default function extension() {
  render(<VatReliefConfirmation />, document.body);
}

/**
 * Read-back of the buyer's VAT relief declaration at checkout.
 *
 * Betsy's item 6. It is deliberately inert: no input, no toggle, nothing the
 * buyer can change here. The declaration is made once, on the cart page, where
 * ticking the box swaps the line to the zero-rated variant. By checkout the
 * price is already net and the merchandise is already non-taxable, so a control
 * at this point would have to unwind a cart change to mean anything.
 *
 * What it is actually for: the buyer sees, immediately before paying, exactly
 * which lines they claimed relief on and what they declared. That is the
 * compliance value — an unmissable last look at the declaration — and it costs
 * nothing in the tax engine, which is the only thing checkout extensions
 * cannot touch.
 */

// The visible line property written by theme/assets/vat-relief.js. Same key the
// validation function gates on.
const DECLARATION_ATTRIBUTE = 'VAT relief declaration';
// Hidden (leading underscore) sibling. Treated as optional throughout: if the
// checkout surface filters underscore-prefixed attributes out of line.attributes
// the banner still renders, just without the "Declared <time>" line.
const DECLARED_AT_ATTRIBUTE = '_vat_relief_declared_at';

interface BannerSettings {
  [key: string]: string | number | boolean | undefined;
  heading?: string;
  body?: string;
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

  const declared = lines.filter(
    (line) => attributeValue(line.attributes, DECLARATION_ATTRIBUTE) !== null,
  );

  // No declaration in this cart — render nothing at all rather than an empty
  // block. A merchant-placed block that always occupies space is worse than one
  // that appears only when it has something to say.
  if (!declared.length) {
    return null;
  }

  // Every line is declared at the same time in practice, but a buyer can tick
  // one box, carry on shopping and tick another later. The earliest stamp is
  // the one that belongs on the record.
  const declaredAt = formatDeclaredAt(
    declared
      .map((line) => attributeValue(line.attributes, DECLARED_AT_ATTRIBUTE))
      .filter((value): value is string => Boolean(value))
      .sort()[0] ?? null,
  );

  const heading = settings.heading || 'VAT relief declared';
  const body =
    settings.body ||
    'You have declared that you are chronically sick or disabled and that these ' +
      'goods are for your personal or domestic use. VAT has been removed from the ' +
      'items listed below.';

  return (
    <s-banner heading={heading} tone="info">
      <s-stack direction="block" gap="base">
        <s-paragraph>{body}</s-paragraph>

        <s-stack direction="block" gap="small-500">
          {declared.map((line) => (
            <s-text key={line.id}>
              {line.merchandise.title} × {line.quantity}
            </s-text>
          ))}
        </s-stack>

        {/* No `type` on these two. The root tsconfig typechecks every .tsx in
            the repo against @shopify/polaris-types (the ADMIN component types),
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
