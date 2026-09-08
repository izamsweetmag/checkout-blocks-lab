import type { ActionFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import {
  ORDER_DECLARATION_KEY,
  ORDER_DECLARED_AT_KEY,
  ORDER_METAFIELD_NAMESPACE,
  readDeclaration,
  type NameValue,
} from "../lib/vat-relief";

/**
 * Copies the VAT relief declaration onto the order as metafields.
 *
 * Betsy's step 7. The cart page already writes the declaration twice — as a
 * line item property and as a cart attribute — and both survive into the order.
 * Neither is a good audit record on its own:
 *
 *   - a cart attribute is untyped free text that anything can write,
 *   - a line property is per-line, so an order-level question ("did this
 *     customer declare?") means walking every line,
 *   - and neither is queryable.
 *
 * The metafields are typed (`boolean`, `date_time`), sit on the order itself,
 * and can be filtered on. That is what an HMRC audit or an export wants.
 *
 * The boolean is written on EVERY order, not only relieved ones. "We asked and
 * the answer was no" is a materially different record from "we have no record",
 * and only the first one is worth anything when someone comes asking.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload, admin } = await authenticate.webhook(request);

  // Shopify retries on a non-2xx. An order we cannot write to is not going to
  // become writable on the retry, so every failure below still answers 200 and
  // logs instead.
  if (!admin) {
    console.log(`[${topic}] ${shop}: no admin context (app uninstalled?)`);
    return new Response();
  }

  const order = payload as {
    id?: number | string;
    admin_graphql_api_id?: string;
    name?: string;
    note_attributes?: NameValue[];
    line_items?: { properties?: NameValue[] }[];
  };

  const orderId =
    order.admin_graphql_api_id ??
    (order.id ? `gid://shopify/Order/${order.id}` : null);
  if (!orderId) {
    console.log(`[${topic}] ${shop}: order payload carried no id`);
    return new Response();
  }

  const declaration = readDeclaration(
    order.note_attributes ?? [],
    (order.line_items ?? []).map((line) => line.properties ?? []),
  );

  const metafields: Record<string, string>[] = [
    {
      ownerId: orderId,
      namespace: ORDER_METAFIELD_NAMESPACE,
      key: ORDER_DECLARATION_KEY,
      type: "boolean",
      value: declaration.declared ? "true" : "false",
    },
  ];

  // Only when there is one. Writing an empty date_time is rejected, and a
  // placeholder timestamp on an order with no declaration would be a fabricated
  // audit record.
  //
  // `timestamp` is the checkout tick where there is one — the moment the buyer
  // agreed to the declaration wording — not the cart-page tick. See
  // DeclarationRecord.
  if (declaration.timestamp) {
    metafields.push({
      ownerId: orderId,
      namespace: ORDER_METAFIELD_NAMESPACE,
      key: ORDER_DECLARED_AT_KEY,
      type: "date_time",
      value: declaration.timestamp,
    });
  }

  try {
    const response = await admin.graphql(
      `#graphql
        mutation SetVatReliefOrderMetafields($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields { key value }
            userErrors { field message }
          }
        }
      `,
      { variables: { metafields } },
    );

    const body = (await response.json()) as {
      data?: { metafieldsSet?: { userErrors?: { message: string }[] } };
      errors?: { message: string }[];
    };

    const errors = [
      ...(body.errors ?? []).map((e) => e.message),
      ...(body.data?.metafieldsSet?.userErrors ?? []).map((e) => e.message),
    ];

    if (errors.length) {
      console.log(
        `[${topic}] ${order.name ?? orderId}: metafield write failed — ${errors.join("; ")}`,
      );
    } else {
      console.log(
        `[${topic}] ${order.name ?? orderId}: declared=${declaration.declared}` +
          (declaration.timestamp ? ` at ${declaration.timestamp}` : "") +
          ` (cart ${declaration.declaredAt ?? "none"},` +
          ` checkout ${declaration.confirmedAt ?? "none"})`,
      );
    }
  } catch (error) {
    console.log(
      `[${topic}] ${order.name ?? orderId}: metafield write threw — ${(error as Error).message}`,
    );
  }

  return new Response();
};
