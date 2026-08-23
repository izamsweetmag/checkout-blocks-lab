import '@shopify/ui-extensions/preact';
// Pulls in the JSX types for the components this target is allowed to render.
import '@shopify/ui-extensions/purchase.checkout.block.render';
import {render} from 'preact';
import {
  useApi,
  useSettings,
  useCartLines,
  useTranslate,
} from '@shopify/ui-extensions/checkout/preact';

export default function extension() {
  render(<CheckoutBlock />, document.body);
}

interface BlockSettings {
  [key: string]: string | number | boolean | undefined;
  banner_title?: string;
  banner_body?: string;
}

function CheckoutBlock() {
  // Merchant-configured values from the checkout editor sidebar.
  const settings = useSettings<BlockSettings>();
  const title = settings.banner_title || 'Checkout block lab';
  const body = settings.banner_body || 'Edit this copy in the checkout editor.';

  // Live checkout state — re-renders when the cart changes.
  const lines = useCartLines();
  const totalQuantity = lines.reduce((sum, line) => sum + line.quantity, 0);

  // Full extension API, if you need something the hooks don't cover.
  const api = useApi();
  const t = useTranslate();

  return (
    <s-stack direction="block" gap="base">
      <s-banner heading={title} tone="info">
        <s-paragraph>{body}</s-paragraph>
      </s-banner>

      <s-text>
        {t('itemsInCart', {count: totalQuantity})} · extension target:{' '}
        {api.extension.target}
      </s-text>

      <s-button
        onClick={() => {
          // eslint-disable-next-line no-console
          console.log('[checkout-block] cart lines', lines);
        }}
      >
        Log cart lines to console
      </s-button>
    </s-stack>
  );
}
