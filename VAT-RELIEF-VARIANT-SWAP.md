# VAT relief — zero-rated variant swap

This is Betsy's proposal, built. The discount function in
`extensions/vat-relief-discount` is the other approach and is untouched; the two
do not interfere (the discount only fires on lines carrying the declaration
attribute, and here the relieved line is a different, non-taxable variant, so
the discount is a no-op on it).

Betsy's seven steps and where each one lives:

| # | Step | Where |
|---|---|---|
| 1 | Two variants per qualifying SKU, swapped by the checkbox | `app/lib/vat-relief.server.ts` provisions them |
| 2 | Product metafield `custom.vat_relief_eligible` = true/false | eligibility gate, see below |
| 3 | Variant A: standard price, VAT inclusive | the existing variant, left alone |
| 4 | Variant B: VAT relief price, zero-rated | provisioned: `taxable: false`, price = gross ÷ 1.2 |
| 5 | Cart page theme + JS | `theme/snippets/vat-relief-checkbox.liquid`, `theme/assets/vat-relief.js` |
| 6 | Checkout UI extension confirmation banner | `extensions/vat-relief-banner` — banner, or banner + a checkbox that blocks checkout until ticked |
| 7 | Audit trail on the order | line properties + cart attributes from the theme JS, copied to order metafields by `webhooks.orders.create.tsx` |

Plus one thing not on Betsy's list, `extensions/vat-relief-validation`, which is
what stops the whole scheme being bypassable. See "The hole the theme cannot
close".

## The idea

Shopify has no tax API, but it does have a per-variant `taxable` flag. So make
the *merchandise* non-taxable rather than trying to make the tax go away:

| | taxed line | relieved line |
|---|---|---|
| variant | "VAT relief: Standard VAT" | "VAT relief: VAT relief applied" |
| `taxable` | `true` | `false` |
| price | £159.00 (gross) | £132.50 (net) |
| order tax line | £26.50 | **£0.00** |

Both variants live on the **same product**. Provisioning adds a `VAT relief`
option to the product and creates the second value; it does not create a second
product. Variants are not indexed as products, so nothing extra appears in
search or the catalogue, and title, handle and images are shared by
construction.

Ticking the cart checkbox swaps the line from the first column to the second.

## The detail that breaks the naive version

Setting `taxable: false` is **not enough**. From the Shopify Help Center:

> "If you set a customer to be tax exempt, but you use tax-included pricing,
> then the customer is still charged the full listed product price."

Your store is tax-inclusive. So a non-taxable variant at £159.00 means the buyer
pays £159.00 and ResMed records £0.00 VAT — pocketing the VAT instead of passing
the relief on. Worse than doing nothing.

The relief variant must therefore carry the **net** price: `gross ÷ 1.20`. The
app computes it, and the Drift panel re-checks it.

## Eligibility: `custom.vat_relief_eligible`

Step 2. Eligibility is a **product metafield**, not a tag:

```
namespace  custom
key        vat_relief_eligible
type       boolean
owner      PRODUCT
```

A tag is free text that anyone with product-edit access can typo and that
carries no type; a boolean definition can only be true or false, renders as a
checkbox in admin, and can be reported on.

### The trap, and it is a bad one

Filtering products by a metafield in the Admin API —
`query: "metafields.custom.vat_relief_eligible:true"` — requires the definition
to have the **`adminFilterable` capability**. Without it Shopify **does not
error**. It ignores the filter and returns every product in the store.

Provisioning off that result would add a `VAT relief` option and a zero-rated
variant to the entire catalogue.

Two defences, both in the code:

1. **Step 1 in the app** (`ensureEligibilityFilterable`) enables `adminFilterable`
   on the existing definition, creating it first if the store doesn't have one.
2. **Every product is re-checked in code** after the query
   (`isEligibleProductValue`), and `provisionReliefVariants` throws on any
   product that isn't flagged. If Shopify ignored the filter, the Plan panel
   shows a warning saying so, and the numbers below it are still right.

Do not remove the second defence because the first one worked once.

## What's in this repo

```
app/lib/vat-relief.ts            constants + pure helpers (shared with the UI)
app/lib/vat-relief.server.ts     provisioning + drift detection
app/routes/app.vat-relief.tsx    admin UI at /app/vat-relief
theme/snippets/vat-relief-checkbox.liquid    the cart-page checkbox
theme/snippets/vat-relief-reset.liquid       expires the checkout declaration
theme/snippets/product-variant-picker.liquid hides the relief option on the PDP
theme/snippets/buy-now-to-cart.liquid        replaces "Buy it now"
theme/assets/vat-relief.js                   the swap + the audit trail
theme/FORCE-CART-PAGE.md                     closing the routes that skip /cart
app/routes/webhooks.orders.create.tsx        declaration -> order metafields
extensions/vat-relief-banner/                checkout confirmation banner
extensions/vat-relief-validation/            blocks undeclared relief lines
```

### Running it

1. Mark the test products: admin → the product → Metafields →
   **VAT relief eligible** → true. (Betsy's sample is *ResMed Mirage FX Frame*.)
2. `shopify app dev`, open the app, go to **/app/vat-relief**.
3. **Create definitions** — the storefront-readable variant-pairing metafields,
   and `adminFilterable` on `custom.vat_relief_eligible`. Safe to re-run.
4. Read the **Plan** table. It shows gross, computed net and VAT removed per
   variant. Check the arithmetic against a real product before you continue.
   If the warning banner about the ignored filter is showing, step 3 did not
   take — fix that before provisioning.
5. **Provision relief variants** — adds the `VAT relief` option to each eligible
   product, creates the zero-rated net-priced counterpart, and links the pair in
   both directions by metafield.
6. Copy `theme/` into the theme, add
   `{{ 'vat-relief.js' | asset_url | script_tag }}` to the cart page, and render
   the snippet in the cart line loop:
   ```liquid
   {% render 'vat-relief-checkbox', line_item: item, line_index: forloop.index %}
   ```
   Change `CART_SECTION_ID` in `vat-relief.js` to your theme's cart section.

   Then render the reset snippet once in `layout/theme.liquid`, just before
   `</body>`:
   ```liquid
   {% render 'vat-relief-reset' %}
   ```
   Then work through `theme/FORCE-CART-PAGE.md`.
7. `shopify app deploy`, then in the checkout editor drop the **VAT relief
   confirmation** block under the order summary, and enable the **VAT relief
   declaration required** validation. If you want the buyer to re-attest at
   checkout, turn on **Show a confirmation checkbox** in the block's settings —
   and grant the extension permission to block progress when the editor asks,
   or the checkbox will show an error but let the buyer through anyway.
8. Test cart: one eligible product + one ineligible. Tick the eligible one,
   place the order, open it in admin, **read the tax lines**.

Scopes needed: `write_products`, `write_validations` for the validation
function, and `write_orders` for the order metafields. The last one is protected
customer data — grant it in the Partner dashboard, or `orders/create` will never
deliver and the metafields will silently never be written.

### The audit trail (step 7)

Written by `theme/assets/vat-relief.js` on every toggle:

| Where | Key | Value |
|---|---|---|
| line property (visible) | `VAT relief declaration` | `Customer declared eligibility` |
| line property (hidden) | `_vat_relief_declared_at` | ISO timestamp |
| cart attribute | `VAT relief declaration` | `Customer declared eligibility` |
| cart attribute (hidden) | `_vat_relief_declared_at` | earliest declaration in the cart |
| cart attribute (hidden) | `_vat_relief_lines` | how many lines are relieved |
| cart attribute (hidden) | `_vat_relief_confirmed_at` | checkout tick, written by the confirmation block |

`_vat_relief_confirmed_at` is deliberately short-lived. It is cleared on every
cart toggle, and again by `vat-relief-reset.liquid` on any storefront page view
— so a buyer who ticks the declaration, leaves checkout and comes back has to
tick it again. Carrying it across visits would mean an order attested to by a
checkout the buyer never re-read. It is the timestamp that lands on the order
metafield, because it is the moment they agreed to the declaration wording.

Line properties become line item properties on the order; cart attributes become
the order's custom attributes. Both survive into the order record and the order
export. The cart attributes are **derived from the cart on every toggle**, never
incremented — an attribute claiming a declaration that no line carries is worse
than no attribute at all.

Then `app/routes/webhooks.orders.create.tsx` copies the whole thing onto typed
order metafields:

| Metafield | Type | Written |
|---|---|---|
| `custom.vat_eligibility_declaration` | boolean | **every order**, true or false |
| `custom.vat_eligibility_declaration_timestamp` | date_time | only when declared |

The boolean is written on every order on purpose. "We asked and the answer was
no" is a materially different record from "we have no record", and only the
first is worth anything when someone comes asking.

The webhook reads the order's cart attributes first and falls back to the line
item properties. That fallback is not belt-and-braces — the cart attributes are
rewritten wholesale on every toggle, so a cart edited through a route that never
ran the theme JS can arrive with per-line evidence and no order-level mirror.
The line properties are the primary record; the attributes are the summary.

Timestamps are normalised to ISO-8601 **without milliseconds**, because
Shopify's `date_time` metafield rejects what `Date.toISOString()` produces.

This needs `write_orders`, which is **protected customer data**. The app needs
that access granted in the Partner dashboard or the subscription will not
deliver, and the metafields will silently never appear.

### The hole the theme cannot close

The relief variant is purchasable by anyone who can name its ID: "Buy it now",
the cart drawer's checkout button, a saved `/checkout` link, or un-hiding the
variant picker in devtools. Every one of those produces a net-priced line with
**no declaration on it**, which is exactly the record HMRC would ask for.

Nothing in the theme can fix that — it all runs in the browser.
`extensions/vat-relief-validation` does, because it runs on Shopify's side. It
enforces two things:

- a line on a relief variant with no `VAT relief declaration` attribute cannot
  reach checkout;
- an order carrying a relief line cannot be **completed** without
  `_vat_relief_confirmed_at`, the checkout re-attestation.

The second is gated on `buyerJourney.step === CHECKOUT_COMPLETION`, because the
same target also runs on cart writes and would otherwise reject the cart for
missing a box that only exists at checkout.

`theme/FORCE-CART-PAGE.md` closes the routes; the validation function is the
thing that makes it enforced rather than merely difficult. Its behaviour is
pinned by seven committed fixtures — `cd extensions/vat-relief-validation &&
npm run cases`. Note what it does
NOT depend on: the checkout extension's `block_progress` capability, which a
merchant can decline, and `useBuyerJourneyIntercept`, which Shopify has
deprecated.

## What this costs — say all of this out loud to ResMed

**Inventory is duplicated.** Two variants cannot share an inventory item.
Provisioning sets the relief variant to `tracked: false`, which means it never
blocks a sale — a buyer claiming VAT relief can order stock you don't have. The
alternatives are an `inventory_levels/update` webhook mirroring quantities
(eventually consistent, so still oversellable in a race) or accepting the
untracked behaviour and reconciling at fulfilment. There is no clean answer.

**Prices drift.** Edit a price in admin and the relief variant is instantly
wrong. The **Drift** panel detects it; wire a `products/update` webhook to
re-sync if this goes anywhere near production. Until then it is a manual check.

**Provisioning mutates the original product.** It adds a `VAT relief` option.
Existing variants are updated in place (`variantStrategy: LEAVE_AS_IS`, so no
variants are created) and take the value "Standard VAT". The option is visible
in the admin variant editor and would be visible on the product page — hence
`theme/snippets/product-variant-picker.liquid`, which hides it.

**Products with real options are fine — until they have three.** Size and
Colour are untouched: `theme/snippets/product-variant-picker.liquid` branches on
the option *name* and special-cases only `VAT relief`, so every other option
renders as Dawn ships it. Provisioning mirrors each taxed variant's real option
values onto its relief counterpart, so Small/Blue pairs with Small/Blue.

The ceiling is Shopify's: **three options per product**, and the swap spends one
of them. A product already on Size + Colour + Length cannot take a `VAT relief`
option at all — `productOptionsCreate` answers `OPTIONS_OVER_LIMIT`. There is no
way around it inside this design: the swap needs a second variant, a second
variant needs an option to tell it apart, and there is no fourth slot. Those
products need a separate relief product, or two real options collapsed into one.

The Plan table flags them before you provision, and provisioning skips them and
finishes the rest rather than aborting the run.

Variant count doubles either way. Size(3) × Colour(2) = 6 becomes 12, each with
its own inventory item. The 2048-variant limit is not the problem; the inventory
duplication above is, multiplied by the variant count.

**The option value shows on the invoice.** For a single-option product the
variant title *is* the option value, and Shopify prints it on the checkout
summary, the confirmation email and the invoice. That is why the values read
"Standard VAT" and "VAT relief applied" rather than "No" and "Yes".

**Reporting splits at variant level, not at SKU level.** Product-level reporting
is unaffected — same product — and so is anything grouping by SKU, because the
pair shares one. Only variant-level reports see two rows.

**The pair carries ONE SKU, deliberately.** The relief variant is given the
taxed variant's SKU verbatim, because that code is what reaches ResMed's ERP: a
suffixed variant SKU would arrive as a line the ERP has never seen. Shopify does
not require SKUs to be unique — admin shows a duplicate warning and nothing
more.

Two things this does *not* do. It does not merge stock: inventory is keyed on
the inventory item, one per variant, whatever the SKU says. And it does not make
the two lines indistinguishable — the variant title ("VAT relief applied") and
the `vat_relief.original_variant` metafield both identify the relief line, and
the metafield is what the validation function actually gates on.

Sizes still need their own SKUs. The pair sharing a code is defensible because
it is one physical item under two tax treatments; S and L sharing a code is not,
because they are different things on the shelf.

The Drift panel checks this alongside price and taxability — a hand-edited SKU
that no longer matches its twin fails at fulfilment, not at checkout, so it
needs catching before it ships.

**Discounts mostly carry across, and this is the one thing the same-product
design fixes.** A discount entitled to specific *products* or *collections*
matches every variant of those products, so it matches the relief variant too.
Only discounts scoped to specific *variants* need extending. A separate clone
product would have failed all three.

## How this compares to the discount approach

| | discount function | variant swap |
|---|---|---|
| buyer pays the right total | yes (at 16.667%, not 20%) | yes |
| order shows £0.00 VAT | **no** | **yes** |
| invoice is HMRC-correct | no | yes |
| mixed cart | yes | yes |
| inventory impact | none | duplicated, unsyncable |
| price maintenance | none | relief variant must track gross ÷ 1.2 |
| discount code interaction | stacks/conflicts with other discounts | product- and collection-scoped discounts carry; variant-scoped ones don't |
| catalogue impact | none | one extra option and variant per eligible product |
| bypassable | n/a | yes, without the validation function |

Neither is free. The discount version keeps the catalogue clean and gets the tax
wrong; the swap version gets the tax right and makes the catalogue and inventory
someone's ongoing job. That is the actual decision in front of ResMed, and it is
a commercial one, not a technical one.
