# Forcing every buyer through the cart page

Goal: no route from a product page to checkout that skips `/cart`. Needed
because the VAT relief declaration checkbox only exists on the cart page — skip
the cart and you get a net-priced line with no declaration on it.

Do steps 1-4. Step 5 is the part the theme cannot do.

---

## 1. Cart type → Page

Theme editor → **Theme settings → Cart → Cart type: Page**.

Kills the cart drawer and the "added to cart" popup, both of which carry their
own **Check out** button. After this, *Add to cart* navigates to `/cart`.

This one setting does most of the work. Do it first.

## 2. Turn off dynamic checkout buttons — everywhere

Theme editor → product template → **Buy buttons** block → untick
**Show dynamic checkout buttons**.

That removes *Buy it now* **and** the accelerated wallet buttons (Shop Pay,
Apple Pay, Google Pay, PayPal) from that block.

**Check every other place a product form is rendered.** The setting is
per-block, not global:

- Featured product sections (home page, landing pages)
- Quick add / quick buy in collection grids
- Any app block with a sticky add-to-cart bar

## 3. Remove it in Liquid too

Step 2 is a setting a merchandiser can re-tick without telling anyone. To make
it stick, delete the render call.

Find every occurrence:

```bash
grep -rn "payment_button" .
```

In Dawn this is `snippets/buy-buttons.liquid`:

```liquid
{%- if show_dynamic_checkout -%}
  {{ form | payment_button }}
{%- endif -%}
```

Either delete the block, or — if you want to keep a fast-path button — swap it
for the replacement:

```liquid
{% render 'buy-now-to-cart' %}
```

and load the script on the product page:

```liquid
{{ 'buy-now-to-cart.js' | asset_url | script_tag }}
```

The replacement adds the line via `/cart/add.js` and then navigates to `/cart`.
Same one-click feel, lands where the declaration checkbox is.

> Do **not** try to intercept Shopify's own Buy it now with a click handler.
> The wallet buttons inside it render in a cross-origin iframe, so your handler
> never fires for them. Removal is the only reliable option.

---

## 4. Hide the "VAT relief" option on the product page

Forcing the cart page is pointless if the buyer can pick the relief variant
before they get there.

Right now the PDP renders a **VAT relief: No / Yes** option picker (see step 2
of the test evidence PDF). Selecting *Yes* drops the price to the net figure and
adds a relief-variant line — with **no declaration property on it**, because the
declaration is written by the cart checkbox, not by the variant picker.

Worse: that line arrives on the cart page with the checkbox already **ticked**,
because the snippet ticks it based on which variant the line is. The buyer never
touches it, so `VAT relief` is never written, and the order looks compliant
while carrying no declaration at all.

### 4a. Drop the option from the picker

In `snippets/product-variant-picker.liquid`, skip it:

```liquid
{%- for option in product.options_with_values -%}
  {%- if option.name == 'VAT relief' -%}{%- continue -%}{%- endif -%}
  ...
{%- endfor -%}
```

### 4b. Force the taxed variant when one is requested by URL

Hiding the picker does not stop `?variant=<relief_variant_id>`. Guard the
product form:

```liquid
{%- liquid
  assign chosen = product.selected_or_first_available_variant
  assign taxed_twin = chosen.metafields.vat_relief.original_variant.value
  if taxed_twin
    assign chosen = taxed_twin
  endif
-%}
<input type="hidden" name="id" value="{{ chosen.id }}">
```

A buyer who lands on a relief-variant URL now adds the taxed variant, at the
taxed price, and gets the declaration checkbox on the cart page like everyone
else.

After 4a and 4b the relief variant is only reachable by ticking the box.

---

## 5. What the theme cannot close

These reach `/checkout` without loading a single line of your Liquid. No theme
setting, no snippet and no URL redirect touches them — Shopify does not allow
`/checkout` to be redirected.

| Route | Why it bypasses |
|---|---|
| `/cart/{variant_id}:{qty}?checkout` | Cart permalink, jumps straight to checkout |
| Abandoned checkout recovery email | Shopify-generated link, lands on `/checkout` |
| Bookmarked or resumed checkout URL | Session resumes past the cart |
| Shop app | Its own cart and checkout surface |
| Draft order invoice | Merchant-generated checkout link |
| POS | Never touches the storefront |

For VAT relief the risk is not "buyer skipped a page" — it is **a net-priced
line reaching an order with no declaration attached to it**. Steps 1–3 remove
the routes buyers actually stumble into; they do not make that impossible.

The only thing that does is the checkout validation function in
`extensions/vat-relief-validation`, which runs on Shopify's side and rejects both
a relief-variant line missing its cart declaration and an order being completed
without the checkout re-attestation — regardless of how checkout was reached.

Every case below is a committed fixture. Run them against the built wasm:

```bash
nvm use 22.23.2                       # the CLI needs Node >= 22.12
cd extensions/vat-relief-validation
npm run build                         # only if you edited src/run.js
npm run cases
```

`npm run cases` exits non-zero on any mismatch, so it works in CI. Then deploy:

```bash
# from the repo root
shopify app deploy
```

| Cart | Buyer journey step | Result |
|---|---|---|
| Relief line **with** declaration | cart interaction | passes |
| Relief line **without** declaration | cart interaction | blocked, error names the product |
| Taxed line without declaration + relief line with a blank declaration | cart interaction | taxed line ignored, relief line blocked |
| Relief line, checkout declaration **not** ticked | checkout completion | blocked |
| Relief line, checkout declaration ticked | checkout completion | passes |
| Relief line, checkout declaration not ticked | cart interaction | passes — the cart must not break over a box that only exists at checkout |
| Relief line, checkout declaration not ticked | checkout interaction | passes — no error while the buyer is still typing an address |
| No relief line at all | checkout completion | passes |

Treat steps 1-4 as UX and the validation function as the control.

---

## Test it

After the changes, confirm each of these lands on `/cart`, not `/checkout`:

1. Product page → Add to cart
2. Product page → Buy it now (if you kept the replacement button)
3. Collection page → quick add
4. Home page featured product → add to cart
5. Cart icon in the header

Then confirm these still reach checkout directly, so nobody is surprised later:

6. Paste `/cart/{variant_id}:1?checkout` into the address bar
7. Start a checkout, abandon it, open the recovery email

And confirm the relief variant is no longer reachable from the product page:

8. Product page shows no **VAT relief** option, only the taxed price
9. `/products/<handle>?variant=<relief_variant_id>` still adds the **taxed**
   variant at the gross price
10. Ticking the cart checkbox is the only thing that produces a relief line, and
    that line carries `VAT relief` — check the order's line item properties in
    admin, not just the price
