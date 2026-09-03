#!/usr/bin/env python3
"""
Patch Shopify's Order confirmation notification template to show VAT relief
the way a discount is shown: struck-through gross price, a VAT RELIEF tag with
the amount removed, and the buyer's declaration text.

There is no discount on these orders — the buyer bought a zero-rated variant at
the net price — so the "was" figure is derived from the net price rather than
read from discount data:

    gross = net * 6 / 5        (integer cents, exact for a 20% VAT rate)
    vat   = gross - net

Integer arithmetic deliberately: `times: 1.2` in Liquid goes through a float and
can land a penny out.

Usage:
    python3 patch-order-email.py order-confirmation.original.liquid

Writes order-confirmation.patched.liquid next to it. Idempotent — running it
twice changes nothing the second time.
"""

import re
import sys
import pathlib

MARKER = "VAT RELIEF (-"

TAG_BLOCK = """{{%- assign vat_relief_note = {var}.properties['VAT relief'] -%}}
          {{%- if vat_relief_note != blank -%}}
            {{%- assign vat_gross = {var}.final_line_price | times: 6 | divided_by: 5 -%}}
            {{%- assign vat_removed = vat_gross | minus: {var}.final_line_price -%}}
            <p>
              <span class="order-list__item-discount-allocation">
                <img src="{{{{ 'notifications/discounttag.png' | shopify_asset_url }}}}" width="18" height="18" class="discount-tag-icon" />
                <span>VAT RELIEF (-{{{{ vat_removed | money }}}})</span>
              </span>
            </p>
            <div class="order-list__item-property">
              <dt>VAT relief:</dt>
              <dd>{{{{ vat_relief_note }}}}</dd>
            </div>
          {{%- endif -%}}
          """

PRICE_BLOCK = """{{% if {var}.original_line_price != {var}.final_line_price %}}
            <del class="order-list__item-original-price">{{{{ {var}.original_line_price | money }}}}</del>
          {{% elsif {var}.properties['VAT relief'] != blank %}}
            {{%- assign vat_gross = {var}.final_line_price | times: 6 | divided_by: 5 -%}}
            <del class="order-list__item-original-price">{{{{ vat_gross | money }}}}</del>
          {{% endif %}}"""


def patch(source: str) -> tuple[str, int, int]:
    # 1. Tag + declaration, inserted immediately before the "Refunded" marker
    #    that every line-item block carries.
    tag_pattern = re.compile(r"\{% if (line|component)\.refunded_quantity > 0 %\}")

    def add_tag(match: "re.Match[str]") -> str:
        return TAG_BLOCK.format(var=match.group(1)) + match.group(0)

    patched, tags = tag_pattern.subn(add_tag, source)

    # 2. Struck-through gross price in the price cell.
    price_pattern = re.compile(
        r"\{% if (line|component)\.original_line_price != \1\.final_line_price %\}\s*\n"
        r"\s*<del class=\"order-list__item-original-price\">\{\{ \1\.original_line_price \| money \}\}</del>\s*\n"
        r"\s*\{% endif %\}"
    )

    def add_price(match: "re.Match[str]") -> str:
        return PRICE_BLOCK.format(var=match.group(1))

    patched, prices = price_pattern.subn(add_price, patched)
    return patched, tags, prices


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2

    path = pathlib.Path(sys.argv[1])
    if not path.exists():
        print(f"No such file: {path}")
        return 1

    source = path.read_text()

    if MARKER in source:
        print("Already patched — nothing to do.")
        return 0

    patched, tags, prices = patch(source)

    if tags == 0 and prices == 0:
        print(
            "Nothing matched. This does not look like Shopify's stock Order\n"
            "confirmation template — the anchors are:\n"
            "  {% if line.refunded_quantity > 0 %}\n"
            "  {% if line.original_line_price != line.final_line_price %}\n"
            "Check the file, or paste it back to me and I'll adjust the anchors."
        )
        return 1

    out = path.with_name("order-confirmation.patched.liquid")
    out.write_text(patched)

    print(f"Patched {tags} line-item block(s) and {prices} price cell(s).")
    print(f"Wrote {out}")
    print("\nOpen it, select all, and paste over the template in")
    print("Settings -> Notifications -> Order confirmation.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
