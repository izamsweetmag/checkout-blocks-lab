/**
 * VAT relief via zero-rated variant swap.
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
 * `taxable: false` — the clone must also be priced at the net amount, or the
 * buyer pays the VAT-inclusive price with no VAT recorded, which is the worst
 * of both worlds.
 *
 *   clone price = gross / (1 + VAT_RATE)
 */

import {
  CLONE_TAG,
  ELIGIBILITY_TAG,
  METAFIELD_NAMESPACE,
  ORIGINAL_VARIANT_KEY,
  PAIRED_VARIANT_KEY,
  netPrice,
  type DriftRow,
  type EligibleProduct,
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

const ELIGIBLE_PRODUCTS_QUERY = `#graphql
  query EligibleProducts($query: String!, $first: Int!) {
    products(first: $first, query: $query) {
      nodes {
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
          }
        }
      }
    }
  }
`;

export async function listEligibleProducts(
  admin: Admin,
  first = 50,
): Promise<EligibleProduct[]> {
  const data = await gql<{ products: { nodes: any[] } }>(
    admin,
    ELIGIBLE_PRODUCTS_QUERY,
    { query: `tag:'${ELIGIBILITY_TAG}' AND -tag:'${CLONE_TAG}'`, first },
  );

  return data.products.nodes.map((product) => ({
    id: product.id,
    title: product.title,
    handle: product.handle,
    status: product.status,
    options: product.options,
    variants: product.variants.nodes.map((variant: any) => ({
      id: variant.id,
      title: variant.title,
      sku: variant.sku,
      price: variant.price,
      taxable: variant.taxable,
      selectedOptions: variant.selectedOptions,
      pairedVariantId: variant.paired?.value ?? null,
      expectedClonePrice: netPrice(variant.price),
    })),
  }));
}

// ---------------------------------------------------------------------------
// Provisioning clones
// ---------------------------------------------------------------------------

const PRODUCT_CREATE = `#graphql
  mutation CreateVatReliefClone($product: ProductCreateInput!) {
    productCreate(product: $product) {
      product { id title handle }
      userErrors { field message }
    }
  }
`;

const VARIANTS_BULK_CREATE = `#graphql
  mutation CreateCloneVariants(
    $productId: ID!
    $variants: [ProductVariantsBulkInput!]!
  ) {
    productVariantsBulkCreate(
      productId: $productId
      variants: $variants
      strategy: REMOVE_STANDALONE_VARIANT
    ) {
      productVariants { id title price taxable selectedOptions { name value } }
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

export async function provisionClones(
  admin: Admin,
  products: EligibleProduct[],
) {
  const created: { product: string; variants: number }[] = [];

  for (const product of products) {
    const unpaired = product.variants.filter((v) => !v.pairedVariantId);
    if (!unpaired.length) continue;

    // The clone carries the same option structure so the variant titles match
    // what the buyer saw on the product page.
    const createData = await gql<{ productCreate: any }>(admin, PRODUCT_CREATE, {
      product: {
        title: product.title,
        // Draft keeps it out of the Online Store until you publish it
        // deliberately. It has to be published before a buyer can add it to a
        // cart — see the README for the visibility trade-off.
        status: "DRAFT",
        tags: [CLONE_TAG, ELIGIBILITY_TAG],
        productOptions: product.options.map((option) => ({
          name: option.name,
          values: option.values.map((value) => ({ name: value })),
        })),
      },
    });

    const createErrors = userErrors(createData.productCreate);
    if (createErrors.length) {
      throw new Error(`${product.title}: ${createErrors.join("; ")}`);
    }

    const cloneProductId = createData.productCreate.product.id as string;

    const variantsData = await gql<{ productVariantsBulkCreate: any }>(
      admin,
      VARIANTS_BULK_CREATE,
      {
        productId: cloneProductId,
        variants: unpaired.map((variant) => ({
          price: variant.expectedClonePrice,
          taxable: false,
          optionValues: variant.selectedOptions.map((option) => ({
            optionName: option.name,
            name: option.value,
          })),
          inventoryItem: {
            sku: variant.sku ? `${variant.sku}-VATFREE` : undefined,
            // Not tracked: the clone has its own inventory item and cannot
            // share stock with the original. See the README.
            tracked: false,
          },
        })),
      },
    );

    const variantErrors = userErrors(variantsData.productVariantsBulkCreate);
    if (variantErrors.length) {
      throw new Error(`${product.title}: ${variantErrors.join("; ")}`);
    }

    const cloneVariants =
      variantsData.productVariantsBulkCreate.productVariants ?? [];

    // Match clones back to originals by their option values.
    const metafields: Record<string, string>[] = [];
    for (const original of unpaired) {
      const key = original.selectedOptions
        .map((o) => `${o.name}:${o.value}`)
        .join("|");
      const clone = cloneVariants.find(
        (c: any) =>
          c.selectedOptions
            .map((o: any) => `${o.name}:${o.value}`)
            .join("|") === key,
      );
      if (!clone) continue;

      metafields.push({
        ownerId: original.id,
        namespace: METAFIELD_NAMESPACE,
        key: PAIRED_VARIANT_KEY,
        type: "variant_reference",
        value: clone.id,
      });
      metafields.push({
        ownerId: clone.id,
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

    created.push({ product: product.title, variants: cloneVariants.length });
  }

  return created;
}

// ---------------------------------------------------------------------------
// Drift check
// ---------------------------------------------------------------------------

const CLONE_VARIANTS_QUERY = `#graphql
  query CloneVariants($query: String!, $first: Int!) {
    products(first: $first, query: $query) {
      nodes {
        id
        title
        variants(first: 100) {
          nodes {
            id
            title
            price
            taxable
            original: metafield(namespace: "${METAFIELD_NAMESPACE}", key: "${ORIGINAL_VARIANT_KEY}") {
              reference {
                ... on ProductVariant { id price }
              }
            }
          }
        }
      }
    }
  }
`;

export async function checkDrift(admin: Admin, first = 50): Promise<DriftRow[]> {
  const data = await gql<{ products: { nodes: any[] } }>(
    admin,
    CLONE_VARIANTS_QUERY,
    { query: `tag:'${CLONE_TAG}'`, first },
  );

  const rows: DriftRow[] = [];

  for (const product of data.products.nodes) {
    for (const variant of product.variants.nodes) {
      const original = variant.original?.reference ?? null;
      const expected = original ? netPrice(original.price) : null;

      let problem: string | null = null;
      if (!original) {
        problem = "clone variant has no link back to an original";
      } else if (variant.taxable) {
        problem = "clone variant is still taxable — VAT will be charged";
      } else if (expected !== variant.price) {
        problem = `price drift: clone is ${variant.price}, should be ${expected}`;
      }

      rows.push({
        productTitle: product.title,
        variantTitle: variant.title,
        originalPrice: original?.price ?? null,
        clonePrice: variant.price,
        expectedClonePrice: expected,
        taxable: variant.taxable,
        problem,
      });
    }
  }

  return rows;
}
