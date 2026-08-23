import '@shopify/ui-extensions/preact';
import '@shopify/ui-extensions/purchase.checkout.delivery-address.render-after';
import {render} from 'preact';
import {useShippingAddress} from '@shopify/ui-extensions/checkout/preact';

export default function extension() {
  render(<DeliveryAddressAfter />, document.body);
}

function DeliveryAddressAfter() {
  const address = useShippingAddress();

  if (!address?.countryCode) {
    return null;
  }

  return (
    <s-banner tone="info" heading="Static target">
      <s-paragraph>
        Pinned under the address form. Shipping to {address.countryCode}.
      </s-paragraph>
    </s-banner>
  );
}
