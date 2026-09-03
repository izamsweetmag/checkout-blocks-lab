# VAT relief — zero-rated variant swap

The second of the two approaches. The discount function in
`extensions/vat-relief-discount` is untouched; run whichever you want, they do
not interfere (the discount only fires on lines carrying `VAT relief`, and in
this approach the relieved line is a different, non-taxable variant, so the
discount is a no-op on it).

## The idea

Shopify has no tax API, but it does have a per-variant `taxable` flag. So make
the *merchandise* non-taxable rather than trying to make the tax go away:

| | taxed line | relieved line |
|---|---|---|
| variant | original | hidden clone |
| `taxable` | `true` | `false` |
| price | £159.00 (gross) | £132.50 (net) |
| order tax line | £26.50 | **£0.00** |

Ticking the cart checkbox swaps the line from the first column to the second.

## The detail that breaks the naive version

Setting `taxable: false` is **not enough**. From the Shopify Help Center:

> "If you set a customer to be tax exempt, but you use tax-included pricing,
> then the customer is still charged the full listed product price."

Your store is tax-inclusive. So a non-taxable variant at £159.00 means the buyer
pays £159.00 and ResMed records £0.00 VAT — pocketing the VAT instead of passing
the relief on. Worse than doing nothing.

The clone must therefore carry the **net** price: `gross ÷ 1.20`. The app
computes and enforces this.

## What's in this repo

```
app/lib/vat-relief.server.ts     provisioning + drift detection
app/routes/app.vat-relief.tsx    admin UI at /app/vat-relief
theme/snippets/vat-relief-checkbox.liquid
theme/assets/vat-relief.js
```

### Running it

1. `shopify app dev`, open the app, go to **/app/vat-relief**.
2. **Create definitions** — storefront-readable variant-pairing metafields.
3. Read the **Plan** table. It shows gross, computed net, and VAT removed per
   variant. Check the arithmetic against a real product before you continue.
4. **Provision clones** — creates one hidden draft product per eligible product,
   variants non-taxable and net-priced, linked to the originals in both
   directions by metafield.
5. Publish the clones to the Online Store channel (they cannot be added to a
   cart otherwise).
6. Copy `theme/` into the theme, add `{{ 'vat-relief.js' | asset_url | script_tag }}`
   to the cart page, and render the snippet in the cart line loop:
   ```liquid
   {% render 'vat-relief-checkbox', line_item: item, line_index: forloop.index %}
   ```
   Change `CART_SECTION_ID` in `vat-relief.js` to your theme's cart section.
7. Test cart: one tagged product + one untagged. Tick the tagged one, place the
   order, open it in admin, read the tax lines.

Scopes needed: `write_products,read_products` (add `write_publications` if you
want the app to publish the clones for you rather than doing it by hand).

## What this costs — say all of this out loud to ResMed

**Inventory is duplicated.** Two variants cannot share an inventory item. The
provisioning code sets the clone to `tracked: false`, which means the clone will
never block a sale — a buyer claiming VAT relief can order stock you don't have.
The alternatives are a `inventory_levels/update` webhook mirroring quantities
(eventually consistent, so still oversellable in a race) or accepting the
untracked behaviour and reconciling at fulfilment. There is no clean answer here.

**Prices drift.** Edit a price in admin and the clone is instantly wrong. The
**Drift** panel in the app detects it; wire a `products/update` webhook to
re-sync if this goes anywhere near production. Until then it is a manual check.

**Discounts do not carry across.** Your invoice sample has a `sleep-club` 5% off
code. A discount entitled to specific products or collections will not match the
clone. Every discount that should apply to an eligible product has to be
extended to its clone, or scoped to "all products". This is the failure mode
that will bite in UAT, not in dev.

**Reporting splits.** Sales for one product land under two product records.
Anything grouping by product needs to merge the pair.

**The clone is reachable by URL.** It must be published to be purchasable, so a
determined buyer can find and buy the net-priced variant without ever ticking
the declaration box. Mitigations: exclude the clone tag from search and
collections in the theme, and treat `VAT relief` on the line as the compliance
record. It reduces the risk, it does not remove it.

**The declaration lives in a line property, not in the tax engine.** Shopify has
no concept of "this line is zero-rated because the buyer declared eligibility".
The visible property `VAT relief` plus the hidden `_vat_relief_declared_at`
timestamp is your audit trail.
Keep it on the order and make sure it reaches whatever produces the paper
invoice.

## How this compares to the discount approach

| | discount function | variant swap |
|---|---|---|
| buyer pays the right total | yes (at 16.667%, not 20%) | yes |
| order shows £0.00 VAT | **no** | **yes** |
| invoice is HMRC-correct | no | yes |
| mixed cart | yes | yes |
| inventory impact | none | duplicated, unsyncable |
| price maintenance | none | clone must track gross ÷ 1.2 |
| discount code interaction | stacks/conflicts with other discounts | clone excluded from product-scoped discounts |
| catalogue impact | none | one hidden product per eligible product |

Neither is free. The discount version keeps the catalogue clean and gets the tax
wrong; the swap version gets the tax right and makes the catalogue and inventory
someone's ongoing job. That is the actual decision in front of ResMed, and it is
a commercial one, not a technical one — which is the useful thing to put in
front of Betsy after she has seen the discount demo's tax lines.
