/**
 * VAT relief via a zero-rated variant on the SAME product.
 *
 * Why this exists: Shopify has no tax API. A discount can change what the buyer
 * pays but not whether the line is taxable, so a discount-based VAT relief still
 * produces an order with a non-zero VAT line. The only way to get a genuinely
 * zero-rated line is for the merchandise itself to be non-taxable.
 *
 * Critical detail (Shopify Help Center, "Include taxes in product prices"):
 *
 *   "If you set a customer to be tax exempt, but you use tax-included pricing,
 *    then the customer is still charged the full listed product price."
 *
 * The same holds for a non-taxable variant. So it is NOT enough to set
 * `taxable: false` — the relief variant must also carry the net price, or the
 * buyer pays the VAT-inclusive price with no VAT recorded, which is the worst
 * of both worlds.
 *
 *   relief price = gross / (1 + VAT_RATE)
 *
 * Provisioning adds a "VAT relief: No / Yes" option to each eligible product
 * (variantStrategy LEAVE_AS_IS, so existing variants are updated in place and
 * no variants are created), then creates the Yes counterparts explicitly so we
 * control price, taxability and inventory.
 */

import {
  ELIGIBILITY_TAG,
  METAFIELD_NAMESPACE,
  ORIGINAL_VARIANT_KEY,
  PAIRED_VARIANT_KEY,
  RELIEF_OPTION_NAME,
  RELIEF_OPTION_NO,
  RELIEF_OPTION_YES,
  netPrice,
  reliefValueOf,
  type DriftRow,
  type EligibleProduct,
  type SelectedOption,
} from "./vat-relief";

export * from "./vat-relief";

type Admin = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

async function gql<T>(
  admin: Admin,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const response = await admin.graphql(query, { variables });
  const body = (await response.json()) as {
    data?: T;
    errors?: { message: string }[];
  };
  if (body.errors?.length) {
    throw new Error(body.errors.map((e) => e.message).join("; "));
  }
  if (!body.data) {
    throw new Error("No data returned from Admin API");
  }
  return body.data;
}

function userErrors(payload: unknown): string[] {
  const errors = (payload as { userErrors?: { message: string }[] })?.userErrors;
  return errors?.map((e) => e.message) ?? [];
}

// ---------------------------------------------------------------------------
// Metafield definitions
// ---------------------------------------------------------------------------

const METAFIELD_DEFINITION_CREATE = `#graphql
  mutation CreateVatReliefDefinition($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition { id key }
      userErrors { code message }
    }
  }
`;

/**
 * The theme needs to read the pairing from Liquid, so the definition must be
 * storefront-readable. Re-running this is safe: a TAKEN code is ignored.
 */
export async function ensureMetafieldDefinitions(admin: Admin) {
  const definitions = [
    { key: PAIRED_VARIANT_KEY, name: "VAT relief: paired zero-rated variant" },
    { key: ORIGINAL_VARIANT_KEY, name: "VAT relief: original taxed variant" },
  ];

  const results: string[] = [];

  for (const definition of definitions) {
    const data = await gql<{
      metafieldDefinitionCreate: {
        userErrors: { code: string; message: string }[];
      };
    }>(admin, METAFIELD_DEFINITION_CREATE, {
      definition: {
        name: definition.name,
        namespace: METAFIELD_NAMESPACE,
        key: definition.key,
        ownerType: "PRODUCTVARIANT",
        type: "variant_reference",
        access: { storefront: "PUBLIC_READ" },
      },
    });

    const errors = data.metafieldDefinitionCreate.userErrors.filter(
      (e) => e.code !== "TAKEN",
    );
    if (errors.length) {
      throw new Error(
        `${definition.key}: ${errors.map((e) => e.message).join("; ")}`,
      );
    }
    results.push(definition.key);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Reading eligible products
// ---------------------------------------------------------------------------

const PRODUCT_FIELDS = `
  id
  title
  handle
  status
  options { name values }
  variants(first: 100) {
    nodes {
      id
      title
      sku
      price
      taxable
      selectedOptions { name value }
      paired: metafield(namespace: "${METAFIELD_NAMESPACE}", key: "${PAIRED_VARIANT_KEY}") {
        value
      }
      original: metafield(namespace: "${METAFIELD_NAMESPACE}", key: "${ORIGINAL_VARIANT_KEY}") {
        reference {
          ... on ProductVariant { id price }
        }
      }
    }
  }
`;

const ELIGIBLE_PRODUCTS_QUERY = `#graphql
  query EligibleProducts($query: String!, $first: Int!) {
    products(first: $first, query: $query) {
      nodes { ${PRODUCT_FIELDS} }
    }
  }
`;

const SINGLE_PRODUCT_QUERY = `#graphql
  query VatReliefProduct($id: ID!) {
    product(id: $id) { ${PRODUCT_FIELDS} }
  }
`;

function mapProduct(product: any): EligibleProduct {
  return {
    id: product.id,
    title: product.title,
    handle: product.handle,
    status: product.status,
    options: product.options,
    hasReliefOption: (product.options ?? []).some(
      (option: any) => option.name === RELIEF_OPTION_NAME,
    ),
    variants: product.variants.nodes.map((variant: any) => ({
      id: variant.id,
      title: variant.title,
      sku: variant.sku,
      price: variant.price,
      taxable: variant.taxable,
      selectedOptions: variant.selectedOptions,
      isReliefVariant:
        reliefValueOf(variant.selectedOptions) === RELIEF_OPTION_YES,
      pairedVariantId: variant.paired?.value ?? null,
      expectedReliefPrice: netPrice(variant.price),
    })),
  };
}

export async function listEligibleProducts(
  admin: Admin,
  first = 50,
): Promise<EligibleProduct[]> {
  const data = await gql<{ products: { nodes: any[] } }>(
    admin,
    ELIGIBLE_PRODUCTS_QUERY,
    { query: `tag:'${ELIGIBILITY_TAG}'`, first },
  );

  return data.products.nodes.map(mapProduct);
}

async function readProduct(admin: Admin, id: string): Promise<EligibleProduct> {
  const data = await gql<{ product: any }>(admin, SINGLE_PRODUCT_QUERY, { id });
  if (!data.product) {
    throw new Error(`Product not found: ${id}`);
  }
  return mapProduct(data.product);
}

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

const PRODUCT_OPTIONS_CREATE = `#graphql
  mutation AddVatReliefOption(
    $productId: ID!
    $options: [OptionCreateInput!]!
  ) {
    productOptionsCreate(
      productId: $productId
      options: $options
      variantStrategy: LEAVE_AS_IS
    ) {
      product { id options { name values } }
      userErrors { field message code }
    }
  }
`;

const VARIANTS_BULK_CREATE = `#graphql
  mutation CreateReliefVariants(
    $productId: ID!
    $variants: [ProductVariantsBulkInput!]!
  ) {
    productVariantsBulkCreate(productId: $productId, variants: $variants) {
      productVariants {
        id
        title
        price
        taxable
        selectedOptions { name value }
      }
      userErrors { field message }
    }
  }
`;

const METAFIELDS_SET = `#graphql
  mutation SetVatReliefPairing($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id key }
      userErrors { field message }
    }
  }
`;

function optionKey(options: SelectedOption[]): string {
  return options
    .filter((o) => o.name !== RELIEF_OPTION_NAME)
    .map((o) => `${o.name}:${o.value}`)
    .sort()
    .join("|");
}

/**
 * Adds the relief option where missing, then creates the zero-rated,
 * net-priced counterpart for every taxed variant that lacks one.
 *
 * Safe to re-run: variants already carrying a pairing metafield are skipped.
 */
export async function provisionReliefVariants(
  admin: Admin,
  products: EligibleProduct[],
) {
  const created: { product: string; variants: number }[] = [];

  for (const initial of products) {
    // 1. Add the option if the product doesn't have it yet. LEAVE_AS_IS updates
    //    existing variants to carry the first value ("No") without creating any.
    if (!initial.hasReliefOption) {
      const optionData = await gql<{ productOptionsCreate: any }>(
        admin,
        PRODUCT_OPTIONS_CREATE,
        {
          productId: initial.id,
          options: [
            {
              name: RELIEF_OPTION_NAME,
              values: [{ name: RELIEF_OPTION_NO }, { name: RELIEF_OPTION_YES }],
            },
          ],
        },
      );

      const optionErrors = userErrors(optionData.productOptionsCreate);
      if (optionErrors.length) {
        throw new Error(`${initial.title}: ${optionErrors.join("; ")}`);
      }
    }

    // 2. Re-read rather than predicting what the option change did to each
    //    variant's selectedOptions. Guessing here is how you create variants
    //    with the wrong option combination.
    const product = await readProduct(admin, initial.id);

    const taxed = product.variants.filter(
      (variant) => !variant.isReliefVariant && !variant.pairedVariantId,
    );
    if (!taxed.length) continue;

    // 3. Build the relief counterparts from the variant's real current options.
    const variantsInput = taxed.map((variant) => {
      const optionValues = variant.selectedOptions.map((option) => ({
        optionName: option.name,
        name:
          option.name === RELIEF_OPTION_NAME ? RELIEF_OPTION_YES : option.value,
      }));

      if (!optionValues.some((o) => o.optionName === RELIEF_OPTION_NAME)) {
        optionValues.push({
          optionName: RELIEF_OPTION_NAME,
          name: RELIEF_OPTION_YES,
        });
      }

      return {
        price: variant.expectedReliefPrice,
        taxable: false,
        optionValues,
        inventoryItem: {
          sku: variant.sku ? `${variant.sku}-VATFREE` : undefined,
          // Two variants cannot share an inventory item. Untracked means the
          // relief variant never blocks a sale — see VAT-RELIEF-VARIANT-SWAP.md.
          tracked: false,
        },
      };
    });

    const variantsData = await gql<{ productVariantsBulkCreate: any }>(
      admin,
      VARIANTS_BULK_CREATE,
      { productId: product.id, variants: variantsInput },
    );

    const variantErrors = userErrors(variantsData.productVariantsBulkCreate);
    if (variantErrors.length) {
      throw new Error(`${product.title}: ${variantErrors.join("; ")}`);
    }

    const reliefVariants =
      variantsData.productVariantsBulkCreate.productVariants ?? [];

    // 4. Link the pairs in both directions, matching on the non-relief options.
    const metafields: Record<string, string>[] = [];
    for (const original of taxed) {
      const key = optionKey(original.selectedOptions);
      const relief = reliefVariants.find(
        (candidate: any) => optionKey(candidate.selectedOptions) === key,
      );
      if (!relief) continue;

      metafields.push({
        ownerId: original.id,
        namespace: METAFIELD_NAMESPACE,
        key: PAIRED_VARIANT_KEY,
        type: "variant_reference",
        value: relief.id,
      });
      metafields.push({
        ownerId: relief.id,
        namespace: METAFIELD_NAMESPACE,
        key: ORIGINAL_VARIANT_KEY,
        type: "variant_reference",
        value: original.id,
      });
    }

    if (metafields.length) {
      const metafieldData = await gql<{ metafieldsSet: any }>(
        admin,
        METAFIELDS_SET,
        { metafields },
      );
      const metafieldErrors = userErrors(metafieldData.metafieldsSet);
      if (metafieldErrors.length) {
        throw new Error(`${product.title}: ${metafieldErrors.join("; ")}`);
      }
    }

    created.push({ product: product.title, variants: reliefVariants.length });
  }

  return created;
}

// ---------------------------------------------------------------------------
// Drift check
// ---------------------------------------------------------------------------

/**
 * Prices drift the moment somebody edits the original in admin. Nothing keeps
 * the pair in step automatically — wire a products/update webhook to re-run
 * this, or accept manual reconciliation.
 */
export async function checkDrift(admin: Admin, first = 50): Promise<DriftRow[]> {
  const data = await gql<{ products: { nodes: any[] } }>(
    admin,
    ELIGIBLE_PRODUCTS_QUERY,
    { query: `tag:'${ELIGIBILITY_TAG}'`, first },
  );

  const rows: DriftRow[] = [];

  for (const product of data.products.nodes) {
    for (const variant of product.variants.nodes) {
      const isRelief =
        reliefValueOf(variant.selectedOptions) === RELIEF_OPTION_YES;
      if (!isRelief) continue;

      const original = variant.original?.reference ?? null;
      const expected = original ? netPrice(original.price) : null;

      let problem: string | null = null;
      if (!original) {
        problem = "relief variant has no link back to a taxed variant";
      } else if (variant.taxable) {
        problem = "relief variant is still taxable — VAT will be charged";
      } else if (expected !== variant.price) {
        problem = `price drift: relief variant is ${variant.price}, should be ${expected}`;
      }

      rows.push({
        productTitle: product.title,
        variantTitle: variant.title,
        originalPrice: original?.price ?? null,
        reliefPrice: variant.price,
        expectedReliefPrice: expected,
        taxable: variant.taxable,
        problem,
      });
    }
  }

  return rows;
}
