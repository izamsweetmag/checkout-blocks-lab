# Order confirmation email — VAT relief display

Makes a zero-rated line render like the discount version does: struck-through
gross price, a `VAT RELIEF (-£26.50)` tag, and the buyer's declaration text.

There is no discount on these orders. The buyer bought a zero-rated variant at
the net price, so the "was" figure is derived:

    gross = net * 6 / 5      (integer cents — exact at 20% VAT)
    vat   = gross - net

£132.50 becomes a struck-through £159.00 with -£26.50 shown.

## Why a patcher instead of a ready-made file

Shopify's Order confirmation template is ~2,000 lines and repeats the same
line-item block four times (delivery agreements, line item groups, the legacy
branch, and the subtotal fallback). Retyping it by hand invites a silent
one-line mistake somewhere in the middle that only shows up in a customer's
inbox. This script rewrites two precise regions and leaves every other byte of
your file untouched.

## Steps

1. Shopify admin → Settings → Notifications → Order confirmation → Edit code.
2. Select all, copy, and paste into `order-confirmation.original.liquid` in
   this folder.
3. Run:

       python3 patch-order-email.py order-confirmation.original.liquid

4. Open `order-confirmation.patched.liquid`, select all, and paste it back over
   the template in the admin. Save.
5. Send yourself a test notification, or place a test order with the relief
   checkbox ticked.

Re-running the script on an already-patched file is a no-op.

## What it anchors to

    {% if line.refunded_quantity > 0 %}                             (tag block)
    {% if line.original_line_price != line.final_line_price %}      (price cell)

Both appear in every copy of the line-item block, for the `line` and
`component` variable names. If Shopify changes the stock template these anchors
may stop matching — the script says so rather than writing a broken file.

## Known limits

- **20% is hardcoded** in the generated Liquid. If the VAT rate ever changes,
  this display silently reports the wrong figure. It reads the rate from
  nowhere.
- **"You saved £26.50" will not appear** at the bottom. That comes from
  `total_discounts`, which is genuinely zero. Synthesising it would assert a
  discount that did not happen on a document a customer may forward to their
  accountant.
- **This framing is a presentation choice, not an accounting one.** The order
  is zero-rated, not discounted. Showing it as money-off is friendlier but less
  accurate; confirm with ResMed's finance team before carrying the same
  treatment onto the VAT invoice.
