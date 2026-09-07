/**
 * VAT relief line swap.
 *
 * Ticking the box replaces the cart line with its paired variant on the SAME
 * product:
 *   taxed variant (gross, taxable: true)  <->  relief variant (net, taxable: false)
 *
 * Uses /cart/change.js so the line's other properties survive the swap. The
 * The declaration is written as the VISIBLE line property "VAT relief declaration",
 * so it
 * shows on the order in admin and on the confirmation email without anyone
 * having to go digging. The timestamp beside it is hidden (leading underscore)
 * because it is for audit, not for the buyer to read.
 *
 * Deliberately does a full re-render of the cart section afterwards rather than
 * patching the DOM — the totals, the VAT line and the checkbox state all move
 * together and getting that wrong is how you ship a cart that lies about tax.
 */
(function () {
  const DECLARATION_PROPERTY = 'VAT relief declaration';
  // Names this property has had before. A cart line created under an older name
  // keeps it forever, because the swap below copies existing properties
  // forward — so the line ends up showing two declarations at once. Strip these
  // on every swap and stale carts heal themselves on the next toggle.
  const LEGACY_DECLARATION_PROPERTIES = ['VAT relief', '_vat_relief'];
  const DECLARATION_VALUE = 'Customer declared eligibility';
  const DECLARED_AT_PROPERTY = '_vat_relief_declared_at';
  // Cart-level mirror of the same declaration. Line properties become line item
  // properties on the order; cart attributes become the order's custom
  // attributes, which is the summary an order-level audit or an export reads
  // without having to walk every line.
  const CART_DECLARATION_ATTRIBUTE = 'VAT relief declaration';
  const CART_DECLARED_AT_ATTRIBUTE = '_vat_relief_declared_at';
  const CART_DECLARED_LINES_ATTRIBUTE = '_vat_relief_lines';
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

  async function getCart() {
    const response = await fetch('/cart.js', {headers: {Accept: 'application/json'}});
    return response.json();
  }

  async function getLine(lineKey) {
    const cart = await getCart();
    return cart.items.find((item) => item.key === lineKey) || null;
  }

  /**
   * Rebuilds the cart-level attributes from what is actually in the cart.
   *
   * Derived, never incremented: the buyer can empty the cart, remove the only
   * relieved line, or have a stale attribute left over from an earlier session,
   * and an attribute claiming a declaration that no line carries is worse than
   * no attribute at all. Shopify deletes an attribute set to the empty string,
   * so the no-declaration case clears rather than writing 'none'.
   *
   * The timestamp is the EARLIEST declaration in the cart — the moment the
   * buyer first declared, which is the one that belongs on the record.
   */
  async function syncCartAttributes() {
    const cart = await getCart();

    const timestamps = cart.items
      .filter((item) => item.properties && item.properties[DECLARATION_PROPERTY])
      .map((item) => item.properties[DECLARED_AT_PROPERTY])
      .filter(Boolean)
      .sort();

    const declaredLines = cart.items.filter(
      (item) => item.properties && item.properties[DECLARATION_PROPERTY]
    ).length;

    const attributes = {};
    attributes[CART_DECLARATION_ATTRIBUTE] = declaredLines
      ? DECLARATION_VALUE
      : '';
    attributes[CART_DECLARED_AT_ATTRIBUTE] = timestamps[0] || '';
    attributes[CART_DECLARED_LINES_ATTRIBUTE] = declaredLines
      ? String(declaredLines)
      : '';

    await postJSON('/cart/update.js', {attributes});
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
    LEGACY_DECLARATION_PROPERTIES.forEach((key) => delete properties[key]);

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

    await syncCartAttributes();
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

  // Bound in the CAPTURE phase, and it stops the event there.
  //
  // Dawn's <cart-items> element listens for any `change` that bubbles up from
  // inside it and reads it as a quantity change:
  //
  //   onChange(event) {
  //     this.updateQuantity(event.target.dataset.index, event.target.value, ...)
  //   }
  //
  // This checkbox lives inside that element, so ticking it had Dawn POST
  // /cart/change.js with line: undefined and quantity: "on". Shopify rejects
  // that, Dawn's catch writes its generic failure string into #cart-errors —
  // directly under the checkout button — and the reload below then wiped it.
  // Harmless, but the buyer saw an error flash every time they ticked the box.
  //
  // Capture runs root-down, so this fires before <cart-items> sees the event.
  // The work has to happen in THIS listener rather than a separate bubble one:
  // stopPropagation() halts the bubble phase entirely, so a bubble-phase
  // listener on document would never run.
  document.addEventListener('change', async (event) => {
    const input =
      event.target.closest && event.target.closest('input[data-vat-relief-toggle]');
    if (!input) return;

    event.stopPropagation();

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
  }, true);
})();
