/**
 * VAT relief line swap.
 *
 * Ticking the box replaces the cart line with its paired variant:
 *   taxed variant (gross price, taxable)  <->  clone variant (net price, taxable: false)
 *
 * Uses /cart/change.js so the line's other properties survive the swap. The
 * The declaration is written as the VISIBLE line property "VAT relief", so it
 * shows on the order in admin and on the confirmation email without anyone
 * having to go digging. The timestamp beside it is hidden (leading underscore)
 * because it is for audit, not for the buyer to read.
 *
 * Deliberately does a full re-render of the cart section afterwards rather than
 * patching the DOM — the totals, the VAT line and the checkbox state all move
 * together and getting that wrong is how you ship a cart that lies about tax.
 */
(function () {
  const DECLARATION_PROPERTY = 'VAT relief';
  const DECLARATION_VALUE = 'Customer declared eligibility';
  const DECLARED_AT_PROPERTY = '_vat_relief_declared_at';
  const CART_SECTION_ID = 'main-cart-items'; // rename to your theme's cart section

  async function postJSON(url, body) {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`${url} failed: ${response.status} ${text}`);
    }

    return response.json();
  }

  async function getLine(lineKey) {
    const response = await fetch('/cart.js', {headers: {Accept: 'application/json'}});
    const cart = await response.json();
    return cart.items.find((item) => item.key === lineKey) || null;
  }

  async function swapLine(input) {
    const lineKey = input.dataset.lineKey;
    const swapTo = Number(input.dataset.swapTo);
    const relieving = input.checked;

    const current = await getLine(lineKey);
    if (!current) {
      throw new Error('Cart line disappeared before the swap');
    }

    const properties = Object.assign({}, current.properties || {});
    if (relieving) {
      properties[DECLARATION_PROPERTY] = DECLARATION_VALUE;
      // Timestamp the declaration — this is the audit trail, keep it.
      properties[DECLARED_AT_PROPERTY] = new Date().toISOString();
    } else {
      delete properties[DECLARATION_PROPERTY];
      delete properties[DECLARED_AT_PROPERTY];
    }

    // Remove first, then add. Doing it in this order avoids briefly holding
    // both the taxed and the zero-rated line, which looks alarming in an
    // open cart drawer.
    await postJSON('/cart/change.js', {id: lineKey, quantity: 0});

    await postJSON('/cart/add.js', {
      items: [
        {
          id: swapTo,
          quantity: current.quantity,
          properties,
        },
      ],
      sections: CART_SECTION_ID,
    });
  }

  function setBusy(container, busy) {
    const status = container.querySelector('[data-vat-relief-status]');
    if (status) status.hidden = !busy;
    container
      .querySelectorAll('input[data-vat-relief-toggle]')
      .forEach((input) => {
        input.disabled = busy;
      });
  }

  document.addEventListener('change', async (event) => {
    const input = event.target.closest('input[data-vat-relief-toggle]');
    if (!input) return;

    const container = input.closest('[data-vat-relief]');
    setBusy(container, true);

    try {
      await swapLine(input);
      // Simplest correct thing. Swap for a section re-render once you have
      // confirmed the totals and the VAT line behave.
      window.location.reload();
    } catch (error) {
      console.error('[vat-relief]', error);
      input.checked = !input.checked;
      setBusy(container, false);
      window.alert('Sorry, we could not update VAT relief on that item. Please try again.');
    }
  });
})();
