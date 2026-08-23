import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
// Values used by the component come from the shared module; anything that
// talks to the Admin API stays in the .server module so it never reaches the
// client bundle.
import {
  ELIGIBILITY_TAG,
  VAT_RATE,
  buildProvisionPlan,
  type DriftRow,
  type ProvisionPlanRow,
} from "../lib/vat-relief";
import {
  checkDrift,
  ensureMetafieldDefinitions,
  listEligibleProducts,
  provisionClones,
} from "../lib/vat-relief.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const products = await listEligibleProducts(admin);
  const plan = buildProvisionPlan(products);
  const drift = await checkDrift(admin);

  return { plan, drift };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent"));

  try {
    if (intent === "definitions") {
      const keys = await ensureMetafieldDefinitions(admin);
      return { ok: true, message: `Metafield definitions ready: ${keys.join(", ")}` };
    }

    if (intent === "provision") {
      const products = await listEligibleProducts(admin);
      const created = await provisionClones(admin, products);
      if (!created.length) {
        return { ok: true, message: "Nothing to do — every eligible variant is already paired." };
      }
      return {
        ok: true,
        message: created
          .map((c) => `${c.product}: ${c.variants} zero-rated variant(s)`)
          .join(" · "),
      };
    }

    return { ok: false, message: `Unknown intent: ${intent}` };
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
};

export default function VatRelief() {
  const { plan, drift } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";

  const problems = drift.filter((row: DriftRow) => row.problem);

  return (
    <s-page heading="VAT relief — zero-rated variant swap">
      <s-section heading="What this does">
        <s-paragraph>
          For every product tagged <s-text type="strong">{ELIGIBILITY_TAG}</s-text>, this creates a
          hidden clone product whose variants are non-taxable and priced ex-VAT
          (gross ÷ {(1 + VAT_RATE).toFixed(2)}). The cart-page checkbox swaps the line to the clone,
          so the order carries a genuine £0.00 VAT line instead of a discounted
          but still-taxed one.
        </s-paragraph>
        <s-paragraph>
          Setting <s-text type="strong">taxable: false</s-text> on its own is not enough. With
          tax-included pricing Shopify still charges the full listed price to an
          exempt buyer, so the clone has to carry the net price as well.
        </s-paragraph>
      </s-section>

      <s-section heading="1. Metafield definitions">
        <s-paragraph>
          Creates the storefront-readable variant pairing metafields. Safe to re-run.
        </s-paragraph>
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="definitions" />
          <s-button type="submit" {...(busy ? { disabled: true } : {})}>
            Create definitions
          </s-button>
        </fetcher.Form>
      </s-section>

      <s-section heading="2. Plan">
        <s-paragraph>
          {plan.length} eligible variant(s). Review the numbers before provisioning.
        </s-paragraph>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={cell}>Product</th>
              <th style={cell}>Variant</th>
              <th style={cell}>Gross</th>
              <th style={cell}>Clone (net)</th>
              <th style={cell}>VAT removed</th>
              <th style={cell}>Paired</th>
            </tr>
          </thead>
          <tbody>
            {plan.map((row: ProvisionPlanRow, index: number) => (
              <tr key={index}>
                <td style={cell}>{row.productTitle}</td>
                <td style={cell}>{row.variantTitle}</td>
                <td style={cell}>{row.grossPrice}</td>
                <td style={cell}>{row.clonePrice}</td>
                <td style={cell}>{row.vatRemoved}</td>
                <td style={cell}>{row.alreadyPaired ? "yes" : "no"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </s-section>

      <s-section heading="3. Provision">
        <s-paragraph>
          Creates the clones as <s-text type="strong">draft</s-text> products. They must be published
          to the Online Store channel before a buyer can add one to a cart —
          which also makes them reachable by URL. Read the trade-off in
          VAT-RELIEF-VARIANT-SWAP.md before you publish.
        </s-paragraph>
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="provision" />
          <s-button type="submit" variant="primary" {...(busy ? { disabled: true } : {})}>
            Provision clones
          </s-button>
        </fetcher.Form>
        {fetcher.data ? (
          <s-banner tone={fetcher.data.ok ? "success" : "critical"}>
            <s-paragraph>{fetcher.data.message}</s-paragraph>
          </s-banner>
        ) : null}
      </s-section>

      <s-section heading="4. Drift">
        {problems.length === 0 ? (
          <s-paragraph>No drift. Every clone is non-taxable and correctly priced.</s-paragraph>
        ) : (
          <s-stack direction="block" gap="base">
            <s-banner tone="warning">
              <s-paragraph>
                {problems.length} clone variant(s) are out of step with their original.
                Nothing keeps them in sync automatically.
              </s-paragraph>
            </s-banner>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={cell}>Product</th>
                  <th style={cell}>Variant</th>
                  <th style={cell}>Problem</th>
                </tr>
              </thead>
              <tbody>
                {problems.map((row: DriftRow, index: number) => (
                  <tr key={index}>
                    <td style={cell}>{row.productTitle}</td>
                    <td style={cell}>{row.variantTitle}</td>
                    <td style={cell}>{row.problem}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </s-stack>
        )}
      </s-section>
    </s-page>
  );
}

const cell = {
  borderBottom: "1px solid #e1e3e5",
  padding: "0.5rem",
  textAlign: "left" as const,
};

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
