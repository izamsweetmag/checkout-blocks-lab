/**
 * "Buy it now" that lands on the cart page instead of jumping to checkout.
 *
 * Shopify's own Buy it now is `{{ form | payment_button }}`. It cannot be
 * reliably intercepted from JS — the wallet buttons inside it (Shop Pay,
 * Apple Pay, Google Pay, PayPal) are rendered in a cross-origin iframe, so a
 * click handler on the container will not fire for them. The only dependable
 * way to stop it is to REMOVE it and render this button in its place.
 *
 * See theme/FORCE-CART-PAGE.md for the removal steps. This file only powers
 * the replacement button.
 */
(function () {
  // buy-buttons.liquid can render more than once on a page (quick add, a
  // featured product section, a sticky ATC bar), and each copy loads this
  // file. The listener below is delegated to `document`, so a second copy
  // would add the line twice per click.
  if (window.__buyNowToCartBound) return;
  window.__buyNowToCartBound = true;

  const BUTTON = '[data-buy-now-to-cart]';
  const CART_URL = '/cart';

  function setBusy(button, busy) {
    button.disabled = busy;
    button.setAttribute('aria-busy', busy ? 'true' : 'false');
    const label = button.querySelector('[data-buy-now-label]');
    const spinner = button.querySelector('[data-buy-now-busy]');
    if (label) label.hidden = busy;
    if (spinner) spinner.hidden = !busy;
  }

  async function addThenGoToCart(button) {
    const form = button.closest('form[action*="/cart/add"]');
    if (!form) {
      throw new Error('data-buy-now-to-cart must sit inside the product form');
    }

    const response = await fetch('/cart/add.js', {
      method: 'POST',
      headers: { Accept: 'application/json' },
      body: new FormData(form),
    });

    if (!response.ok) {
      // Shopify returns a JSON body with `description` on stock errors.
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.description || `add.js failed: ${response.status}`);
    }

    // Full navigation, not a section re-render. The buyer is meant to land on
    // the cart page and read it — that is the entire point of this button.
    window.location.href = CART_URL;
  }

  document.addEventListener('click', async (event) => {
    const button = event.target.closest(BUTTON);
    if (!button || button.disabled) return;

    event.preventDefault();
    setBusy(button, true);

    try {
      await addThenGoToCart(button);
      // No un-busy on success: the page is navigating away.
    } catch (error) {
      console.error('[buy-now-to-cart]', error);
      setBusy(button, false);
      window.alert(error.message || 'Sorry, we could not add that to your cart.');
    }
  });
})();
