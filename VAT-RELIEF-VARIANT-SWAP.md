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
| 6 | Checkout UI extension confirmation banner | `extensions/vat-relief-banner` |
| 7 | Audit trail on the order | line properties + cart attributes, written by the same JS |

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
theme/snippets/product-variant-picker.liquid hides the relief option on the PDP
theme/snippets/buy-now-to-cart.liquid        replaces "Buy it now"
theme/assets/vat-relief.js                   the swap + the audit trail
theme/FORCE-CART-PAGE.md                     closing the routes that skip /cart
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
   Then work through `theme/FORCE-CART-PAGE.md`.
7. `shopify app deploy`, then in the checkout editor drop the **VAT relief
   confirmation** block under the order summary, and enable the **VAT relief
   declaration required** validation.
8. Test cart: one eligible product + one ineligible. Tick the eligible one,
   place the order, open it in admin, **read the tax lines**.

Scopes needed: `write_products` (already set), plus `write_validations` for the
validation function.

### The audit trail (step 7)

Written by `theme/assets/vat-relief.js` on every toggle:

| Where | Key | Value |
|---|---|---|
| line property (visible) | `VAT relief declaration` | `Customer declared eligibility` |
| line property (hidden) | `_vat_relief_declared_at` | ISO timestamp |
| cart attribute | `VAT relief declaration` | `Customer declared eligibility` |
| cart attribute (hidden) | `_vat_relief_declared_at` | earliest declaration in the cart |
| cart attribute (hidden) | `_vat_relief_lines` | how many lines are relieved |

Line properties become line item properties on the order; cart attributes become
the order's custom attributes. Both survive into the order record and the order
export. The cart attributes are **derived from the cart on every toggle**, never
incremented — an attribute claiming a declaration that no line carries is worse
than no attribute at all.

Order metafields would be the tidier home for this, but nothing in the theme can
write one; that needs an `orders/create` webhook copying the attributes across.
Worth doing before production, not needed to evaluate the approach.

### The hole the theme cannot close

The relief variant is purchasable by anyone who can name its ID: "Buy it now",
the cart drawer's checkout button, a saved `/checkout` link, or un-hiding the
variant picker in devtools. Every one of those produces a net-priced line with
**no declaration on it**, which is exactly the record HMRC would ask for.

Nothing in the theme can fix that — it all runs in the browser.
`extensions/vat-relief-validation` does, because it runs on Shopify's side: a
line on a relief variant with no `VAT relief declaration` attribute cannot reach
checkout. `theme/FORCE-CART-PAGE.md` closes the routes; the validation function
is the thing that makes it enforced rather than merely difficult.

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

**The option value shows on the invoice.** For a single-option product the
variant title *is* the option value, and Shopify prints it on the checkout
summary, the confirmation email and the invoice. That is why the values read
"Standard VAT" and "VAT relief applied" rather than "No" and "Yes".

**Reporting splits at variant level.** Product-level reporting is unaffected —
same product — but anything grouping by variant or SKU now sees two rows per
qualifying SKU (the relief SKU is suffixed `-VATFREE`).

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
