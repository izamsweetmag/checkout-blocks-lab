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
  ELIGIBILITY_METAFIELD,
  VAT_RATE,
  buildProvisionPlan,
  type DriftRow,
  type ProvisionPlanRow,
} from "../lib/vat-relief";
import {
  checkDrift,
  ensureMetafieldDefinitions,
  listEligibleProducts,
  provisionReliefVariants,
} from "../lib/vat-relief.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const { products, scanned, filterHonored } = await listEligibleProducts(admin);
  const plan = buildProvisionPlan(products);
  const drift = await checkDrift(admin);

  return { plan, drift, eligibleCount: products.length, scanned, filterHonored };
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
      const { products } = await listEligibleProducts(admin);
      const created = await provisionReliefVariants(admin, products);
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
  const { plan, drift, eligibleCount, scanned, filterHonored } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";

  const problems = drift.filter((row: DriftRow) => row.problem);

  return (
    <s-page heading="VAT relief — zero-rated variant swap">
      <s-section heading="What this does">
        <s-paragraph>
          For every product with the metafield{" "}
          <s-text type="strong">{ELIGIBILITY_METAFIELD}</s-text> set to{" "}
          <s-text type="strong">true</s-text>, this adds a
          “VAT relief: No / Yes” option and creates the Yes variant non-taxable and
          priced ex-VAT (gross ÷ {(1 + VAT_RATE).toFixed(2)}). The cart-page checkbox swaps the line
          between the two, so the order carries a genuine £0.00 VAT line instead
          of a discounted but still-taxed one.
        </s-paragraph>
        <s-paragraph>
          Setting <s-text type="strong">taxable: false</s-text> on its own is not enough. With
          tax-included pricing Shopify still charges the full listed price to an
          exempt buyer, so the relief variant has to carry the net price as well.
        </s-paragraph>
      </s-section>

      <s-section heading="1. Metafield definitions">
        <s-paragraph>
          Creates the storefront-readable variant pairing metafields, and makes{" "}
          <s-text type="strong">{ELIGIBILITY_METAFIELD}</s-text> filterable in the
          Admin API. Safe to re-run.
        </s-paragraph>
        <s-paragraph>
          The filterable part is not cosmetic. Shopify does not reject a query
          filtering on a metafield definition that lacks the{" "}
          <s-text type="strong">adminFilterable</s-text> capability — it ignores the
          filter and returns every product. This page re-checks the metafield on
          each product it gets back, so provisioning cannot run away with the
          catalogue either way.
        </s-paragraph>
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="definitions" />
          <s-button type="submit" {...(busy ? { disabled: true } : {})}>
            Create definitions
          </s-button>
        </fetcher.Form>
      </s-section>

      <s-section heading="2. Plan">
        {filterHonored ? null : (
          <s-banner tone="warning">
            <s-paragraph>
              Shopify ignored the metafield filter: it returned {scanned}{" "}
              product(s), only {eligibleCount} of which are marked eligible. The
              definition is not admin-filterable — run step 1. The plan below is
              still correct; it was filtered here rather than by Shopify.
            </s-paragraph>
          </s-banner>
        )}
        <s-paragraph>
          {eligibleCount} eligible product(s), {plan.length} eligible variant(s).
          Review the numbers before provisioning.
        </s-paragraph>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={cell}>Product</th>
              <th style={cell}>Variant</th>
              <th style={cell}>Gross</th>
              <th style={cell}>Relief (net)</th>
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
                <td style={cell}>{row.reliefPrice}</td>
                <td style={cell}>{row.vatRemoved}</td>
                <td style={cell}>{row.alreadyPaired ? "yes" : "no"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </s-section>

      <s-section heading="3. Provision">
        <s-paragraph>
          This <s-text type="strong">modifies the original products</s-text>: it adds an option to each
          one (existing variants keep their current values and are set to “No”).
          Nothing new appears in search or the catalogue. The relief variant will
          show in the product page selector until you hide it in the theme.
        </s-paragraph>
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="provision" />
          <s-button type="submit" variant="primary" {...(busy ? { disabled: true } : {})}>
            Provision relief variants
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
          <s-paragraph>No drift. Every relief variant is non-taxable and correctly priced.</s-paragraph>
        ) : (
          <s-stack direction="block" gap="base">
            <s-banner tone="warning">
              <s-paragraph>
                {problems.length} relief variant(s) are out of step with their taxed counterpart.
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
