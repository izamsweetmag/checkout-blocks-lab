# checkout-blocks-lab

Shopify app scaffold for testing per-line VAT relief at checkout (ResMed UK pattern).

Base: [Shopify/shopify-app-template-react-router](https://github.com/Shopify/shopify-app-template-react-router)
(the Remix template is in maintenance mode — Remix v7 *is* React Router v7).

## Setup

```bash
npm install -g @shopify/cli@latest   # if you don't have it
npm install
shopify app config link              # fills in client_id in shopify.app.toml
shopify app dev
```

Node must be `>=20.19 <22 || >=22.12` (enforced, `.npmrc` has `engine-strict=true`).

Your dev store needs **Plus features enabled** in the Partner dashboard
(Stores → your dev store → edit → Developer preview / Plus), otherwise the
checkout-page extension targets will not appear in the checkout editor.

## What's in here

### `extensions/checkout-block` — checkout UI extension
API version `2026-07`, Preact + Polaris web components (`s-banner`, `s-stack`…).
Not React: `@shopify/ui-extensions-react` stopped at the `2025-07` line and has
no `2025-10`/`2026-*` release. If you write checkout extensions in React today
you are building on a frozen package.

Two targets:

| Target | Kind | Where it renders |
|---|---|---|
| `purchase.checkout.block.render` | dynamic | wherever the merchant drops it in the checkout editor |
| `purchase.checkout.delivery-address.render-after` | static | pinned under the address form |

Component JSX types come from the per-target import, e.g.
`import '@shopify/ui-extensions/purchase.checkout.block.render'`.
Without it, `s-banner` etc. are not in `JSX.IntrinsicElements`.

Typechecks clean: `cd extensions/checkout-block && npx tsc --noEmit`.

### `extensions/vat-relief-discount` — discount function
This is Betsy's suggestion, implemented so you can run it and look at the result.

- Reads the cart line property `VAT relief` (written by the cart-page checkbox).
- Cross-checks the product carries the tag `VAT Exempt Opt` — the line property
  is buyer-editable, so it can't be the only gate.
- Applies a **fixed-amount** product discount equal to the VAT element of that
  line: `gross / 6`, i.e. 16.667% of a VAT-inclusive price.

Register it in the admin as an **automatic product discount** after
`shopify app deploy`, then it runs on every cart.

> This extension still gates on the **tag** `VAT Exempt Opt`. The variant-swap
> approach moved to the product metafield `custom.vat_relief_eligible`; this one
> was left as it was because it is the comparison exhibit, not the candidate.
> If you demo both on the same store, the eligible products need the tag *and*
> the metafield.

### `extensions/vat-relief-banner` — checkout confirmation banner
Betsy's step 6. A dynamic block (`purchase.checkout.block.render`) that reads the
`VAT relief declaration` attribute off the cart lines and reads the declaration
back to the buyer, naming the lines it applies to and the time it was made.
Renders nothing when no line carries a declaration. No input, nothing the buyer
can change: by checkout the price is already net and the merchandise is already
non-taxable.

### `extensions/vat-relief-validation` — checkout validation function
Not on Betsy's list, and the reason the scheme is enforceable rather than merely
inconvenient to bypass. Blocks checkout on any line whose variant is a
zero-rated counterpart but which carries no `VAT relief declaration` attribute —
i.e. someone who reached the net-priced variant without ticking the box.

## Before you run it: the two things this test will show

**1. "20% VAT deduction" is the wrong number.**
Your prices are VAT-inclusive — the cart screenshot proves it: subtotal £191.00,
total £191.00, "VAT 20% £31.83" sitting *inside* the £191.00. The VAT element of
a gross price is `gross × 20/120 = gross / 6 = 16.667%`, not 20%.

| Line (gross) | True VAT element | Naive "20% off" | Over-refund |
|---|---|---|---|
| £159.00 | £26.50 | £31.80 | £5.30 |
| £129.00 | £21.50 | £25.80 | £4.30 |
| £32.00 | £5.33 | £6.40 | £1.07 |

**2. Even at the right number, the order is still not zero-rated.**
Shopify recalculates tax on the *discounted* price. Discount £159.00 down to
£132.50 and Shopify treats that £132.50 as £110.42 net + **£22.08 VAT**. So:

- the buyer pays the right total,
- the order and invoice still show a non-zero VAT line,
- ResMed remits £22.08 of VAT out of margin on a supply that HMRC says is zero-rated.

A discount reduces price. It cannot change taxability. That distinction is the
whole ballgame for a VAT-relief feature, and it is what the demo will make visible.

### Suggested demo script for Betsy

1. Cart: AirTouch N30i (tagged `VAT Exempt Opt`) + REMZZZ liner (not tagged).
2. Tick the box on the mask only.
3. Go to checkout → screenshot the order summary.
4. Place the order → open the order in admin → **look at the tax lines**.
5. Compare against the paper invoice, which needs `VAT 20.0% £0.00` for the
   relieved line.

Step 4 is the actual result. Steps 1–3 will look like it works.

## Why there is no clean way to do this in Shopify

- There is **no tax Shopify Function**. The function APIs are: cart & checkout
  validation, cart transform, delivery customization, discount, fulfillment
  constraints, order routing, payment customization, pickup/local-pickup
  generators. No tax target.
- Checkout UI extensions have no tax mutation. `useApplyCartLinesChange`,
  `useApplyAttributeChange`, `useApplyDiscountCodeChange` — that's the surface.
- Shopify's own **Tax Platform** (the thing that could zero-rate a line) is
  invitation-only for tax software vendors. Not open to merchant apps.
- Built-in tax exemption is either **customer-level** (`taxExempt`, whole order)
  or **product-level** (`taxable: false`, always). Neither is per-line and
  per-buyer-declaration.

### The one approach that produces a genuinely correct invoice

Duplicate each eligible variant as a non-taxable variant (`taxable: false`), and
have the cart checkbox swap the line to it. Real £0.00 VAT, mixed carts fine,
invoice correct. The cost is variant/inventory duplication — the two variants
have separate inventory items, so stock has to be synced. That trade is worth
putting in front of ResMed alongside the discount demo.

**This is now built too, and it is what ResMed asked to evaluate** — see
[VAT-RELIEF-VARIANT-SWAP.md](./VAT-RELIEF-VARIANT-SWAP.md). Admin UI at
`/app/vat-relief`, theme files in `theme/`. Eligibility is the product metafield
`custom.vat_relief_eligible`. Both variants live on the same product, so nothing
extra appears in the catalogue. It does not touch
`extensions/vat-relief-discount`, so both can be tested independently.
