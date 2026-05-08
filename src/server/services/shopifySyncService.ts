/**
 * Shopify Sync Engine — SyncFlow
 *
 * Three execution pathways:
 *  1. Turbo Mode        → parallelBatch GraphQL mutations (price/stock/meta)
 *  2. Bulk Operations   → Shopify Bulk API via JSONL upload (large catalogs)
 *  3. Individual Mutations → parallel batched for full field syncs
 */

import { query } from '../db.js';

interface Channel {
  id: string;
  shopify_store_url: string;
  shopify_access_token: string;
  shopify_api_version: string;
  settings?: { stock_location_id?: string };
}

interface SyncJobConfig {
  jobId: string;
  channel: Channel;
  feedId: string;
  preset: 'price_stock_meta' | 'sync_all_no_images' | 'sync_all' | 'custom';
  fields?: string[];
  filterRules?: Array<{ field: string; operator: string; value: string; logic?: string }>;
  skus?: string[]; // If provided, only sync these SKUs
  priceAdjustmentPercent?: number;
  priceRoundingMode?: 'none' | 'up' | 'down';
}

interface ProductRow {
  sku: string;
  raw_data: Record<string, string | number | null>;
  [key: string]: unknown;
}

interface GroupedProduct {
  handle: string;
  rows: ProductRow[];
}

interface AttributeMapping {
  feed_column: string;
  target_field: string;
}

const BATCH_SIZE = 10; // Turbo mode parallel batch
const INDIVIDUAL_PARALLEL_SIZE = 12; // Individual sync parallel products
const MAX_RETRIES = 8;
const RETRY_DELAY_MS = 2000;

// ── Cancellation tracking ──────────────────────────────────────────────────
const cancelledJobs = new Set<string>();

export function cancelJob(jobId: string) {
  cancelledJobs.add(jobId);
}

async function isJobCancelled(jobId: string): Promise<boolean> {
  if (cancelledJobs.has(jobId)) return true;
  const result = await query("SELECT status FROM sync_jobs WHERE id = $1", [jobId]);
  if (result.rows[0]?.status === 'cancelled') {
    cancelledJobs.add(jobId);
    return true;
  }
  return false;
}

// ── Rate-limited fetch with retry ──────────────────────────────────────────
async function shopifyFetchWithRetry(url: string, options: RequestInit, retries = 0): Promise<Response> {
  const res = await fetch(url, options);
  if (res.status === 429) {
    const retryAfter = parseFloat(res.headers.get('Retry-After') || '2') * 1000;
    const backoff = Math.max(retryAfter, RETRY_DELAY_MS * Math.pow(1.5, retries));
    if (retries >= MAX_RETRIES) throw new Error(`Shopify rate limit exceeded after ${MAX_RETRIES} retries`);
    console.log(`[SyncFlow] 429 Rate limited, waiting ${Math.round(backoff)}ms (retry ${retries + 1})`);
    await sleep(backoff);
    return shopifyFetchWithRetry(url, options, retries + 1);
  }
  return res;
}

// ── GraphQL Helper with rate limit handling ────────────────────────────────
async function shopifyGraphQL(channel: Channel, gqlQuery: string, variables = {}, retries = 0): Promise<unknown> {
  const url = `https://${channel.shopify_store_url}/admin/api/${channel.shopify_api_version}/graphql.json`;
  const res = await shopifyFetchWithRetry(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': channel.shopify_access_token,
    },
    body: JSON.stringify({ query: gqlQuery, variables }),
  });

  const json = await res.json() as {
    errors?: Array<{ message?: string }>;
    data?: unknown;
    extensions?: { cost?: { throttleStatus?: { currentlyAvailable?: number; restoreRate?: number } } }
  };

  // Handle throttled errors in response body
  if (json.errors) {
    const throttled = json.errors.some(e => e.message?.includes('Throttled'));
    if (throttled && retries < MAX_RETRIES) {
      const backoff = RETRY_DELAY_MS * Math.pow(1.5, retries);
      console.log(`[SyncFlow] GraphQL throttled, waiting ${Math.round(backoff)}ms (retry ${retries + 1})`);
      await sleep(backoff);
      return shopifyGraphQL(channel, gqlQuery, variables, retries + 1);
    }
    throw new Error(JSON.stringify(json.errors));
  }

  // Proactive throttle: if available cost drops low, pause to let it restore
  const cost = json.extensions?.cost?.throttleStatus;
  if (cost && cost.currentlyAvailable !== undefined && cost.currentlyAvailable < 200) {
    const restoreRate = cost.restoreRate || 50;
    const waitTime = Math.ceil((200 - cost.currentlyAvailable) / restoreRate) * 1000;
    console.log(`[SyncFlow] Low cost budget (${cost.currentlyAvailable}), pausing ${waitTime}ms`);
    await sleep(waitTime);
  }

  return json.data;
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── SKU → Shopify ID lookup via GraphQL ────────────────────────────────────
async function getShopifyProductMap(channel: Channel): Promise<Map<string, { productId: string; variantId: string; inventoryItemId: string }>> {
  const map = new Map();
  let cursor: string | null = null;
  let hasMore = true;

  const gqlQuery = `
    query getProducts($cursor: String) {
      products(first: 250, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id
            variants(first: 100) {
              edges {
                node {
                  id
                  sku
                  barcode
                  inventoryItem { id }
                }
              }
            }
          }
        }
      }
    }`;

  while (hasMore) {
    const data = await shopifyGraphQL(channel, gqlQuery, { cursor }) as {
      products: {
        pageInfo: { hasNextPage: boolean; endCursor: string };
        edges: Array<{
          node: {
            id: string;
            variants: { edges: Array<{ node: { id: string; sku: string; barcode: string; inventoryItem: { id: string } } }> };
          };
        }>;
      };
    };

    for (const productEdge of data.products.edges) {
      for (const variantEdge of productEdge.node.variants.edges) {
        const v = variantEdge.node;
        const entry = {
          productId: productEdge.node.id,
          variantId: v.id,
          inventoryItemId: v.inventoryItem.id,
        };
        if (v.sku) {
          map.set(v.sku, entry);
        }
        // Also index by barcode so EAN-based feeds can match
        if (v.barcode && !map.has(v.barcode)) {
          map.set(v.barcode, entry);
        }
      }
    }

    hasMore = data.products.pageInfo.hasNextPage;
    cursor = data.products.pageInfo.endCursor;
  }

  console.log(`[SyncFlow] Product map loaded: ${map.size} SKUs`);
  return map;
}

// ── Turbo Mode: parallel price/stock updates ──────────────────────────────
async function turboSync(
  channel: Channel,
  products: ProductRow[],
  mappings: AttributeMapping[],
  jobId: string,
  priceAdjustmentPercent = 0,
  priceRoundingMode: 'none' | 'up' | 'down' = 'none'
) {
  const shopifyMap = await getShopifyProductMap(channel);

  // Pre-resolve location once
  let locationId = channel.settings?.stock_location_id;
  if (!locationId) {
    const locQuery = `{ locations(first: 1) { edges { node { id } } } }`;
    const locData = await shopifyGraphQL(channel, locQuery) as { locations: { edges: Array<{ node: { id: string } }> } };
    locationId = locData.locations.edges[0]?.node?.id;
  }

  // Pre-compute metafield mappings
  const metafieldMappings = mappings.filter(m => m.target_field.startsWith('metafield:'));

  for (let i = 0; i < products.length; i += BATCH_SIZE) {
    if (await isJobCancelled(jobId)) {
      console.log(`[SyncFlow] Job ${jobId} cancelled at product ${i}/${products.length}`);
      return;
    }

    const batch = products.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(p => syncProductTurbo(channel, p, mappings, metafieldMappings, shopifyMap, jobId, locationId, 0, priceAdjustmentPercent, priceRoundingMode)));
    await query('UPDATE sync_jobs SET processed_count = $1 WHERE id = $2', [Math.min(i + BATCH_SIZE, products.length), jobId]);
  }
}

async function syncProductTurbo(
  channel: Channel,
  product: ProductRow,
  mappings: AttributeMapping[],
  metafieldMappings: AttributeMapping[],
  shopifyMap: Map<string, { productId: string; variantId: string; inventoryItemId: string }>,
  jobId: string,
  locationId?: string,
  retries = 0,
  priceAdjustmentPercent = 0,
  priceRoundingMode: 'none' | 'up' | 'down' = 'none'
): Promise<void> {
  const shopifyIds = shopifyMap.get(product.sku);

  if (!shopifyIds) {
    await logSyncEntry(jobId, product.sku, 'skipped', 'SKU not found in Shopify — use Sync All to create it');
    await query('UPDATE sync_jobs SET skipped_count = skipped_count + 1 WHERE id = $1', [jobId]);
    return;
  }

  try {
    const mapped = applyPriceAdjustment(applyMappings(product.raw_data, mappings), priceAdjustmentPercent, priceRoundingMode);

    // Combined: Price + Metafields in minimal API calls
    // 1. Product update with metafields (single call)
    if (metafieldMappings.length > 0) {
      const metafields = metafieldMappings
        .filter(m => product.raw_data[m.feed_column] !== undefined && product.raw_data[m.feed_column] !== null && product.raw_data[m.feed_column] !== '')
        .map(m => {
          const parts = m.target_field.replace('metafield:', '').split(':');
          return {
            namespace: parts[0],
            key: parts[1],
            type: parts[2] || 'single_line_text_field',
            value: String(product.raw_data[m.feed_column]),
          };
        });
      if (metafields.length > 0) {
        const updateMutation = `
          mutation productUpdate($input: ProductInput!) {
            productUpdate(input: $input) {
              product { id }
              userErrors { field message }
            }
          }`;
        await shopifyGraphQL(channel, updateMutation, {
          input: { id: shopifyIds.productId, metafields },
        });
      }
    }

    // 2. Price update via productVariantsBulkUpdate
    if (mapped.price || mapped.compare_at_price) {
      const priceQuery = `
        mutation variantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkUpdate(productId: $productId, variants: $variants) {
            productVariants { id }
            userErrors { field message }
          }
        }`;
      await shopifyGraphQL(channel, priceQuery, {
        productId: shopifyIds.productId,
        variants: [{
          id: shopifyIds.variantId,
          price: mapped.price ? String(mapped.price) : undefined,
          compareAtPrice: mapped.compare_at_price ? String(mapped.compare_at_price) : undefined,
        }],
      });
    }

    // 3. Stock update
    if (mapped.inventory_quantity !== undefined && locationId) {
      const stockQuery = `
        mutation inventorySetQuantities($input: InventorySetQuantitiesInput!) {
          inventorySetQuantities(input: $input) {
            inventoryAdjustmentGroup { reason }
            userErrors { field message }
          }
        }`;
      await shopifyGraphQL(channel, stockQuery, {
        input: {
          name: "available",
          reason: "correction",
          quantities: [{
            inventoryItemId: shopifyIds.inventoryItemId,
            locationId,
            quantity: parseInt(String(mapped.inventory_quantity)),
          }],
        },
      });
    }

    await logSyncEntry(jobId, product.sku, 'updated', 'Turbo sync succeeded');
    await query('UPDATE sync_jobs SET updated_count = updated_count + 1 WHERE id = $1', [jobId]);
  } catch (err: unknown) {
    const errMsg = String(err);
    if (errMsg.includes('Throttled') && retries < MAX_RETRIES) {
      await sleep(RETRY_DELAY_MS * (retries + 1));
      return syncProductTurbo(channel, product, mappings, metafieldMappings, shopifyMap, jobId, locationId, retries + 1, priceAdjustmentPercent, priceRoundingMode);
    }
    await logSyncEntry(jobId, product.sku, 'failed', errMsg);
    await query('UPDATE sync_jobs SET failed_count = failed_count + 1 WHERE id = $1', [jobId]);
  }
}

// ── Individual Sync: create new + update all fields (PARALLEL) ────────────
async function individualSync(
  channel: Channel,
  products: ProductRow[],
  mappings: AttributeMapping[],
  jobId: string,
  withImages: boolean,
  priceAdjustmentPercent = 0,
  priceRoundingMode: 'none' | 'up' | 'down' = 'none'
) {
  const shopifyMap = await getShopifyProductMap(channel);

  // Pre-resolve location once
  let locationId = channel.settings?.stock_location_id;
  if (!locationId) {
    const locQuery = `{ locations(first: 1) { edges { node { id } } } }`;
    const locData = await shopifyGraphQL(channel, locQuery) as { locations: { edges: Array<{ node: { id: string } }> } };
    locationId = locData.locations.edges[0]?.node?.id;
  }

  // Pre-compute metafield mappings once
  const metafieldMappings = mappings.filter(m => m.target_field.startsWith('metafield:'));

  const groupedProducts = groupRowsByHandle(products, mappings);

  let processed = 0;

  // Process in parallel batches (6 products at a time)
  for (let i = 0; i < groupedProducts.length; i += INDIVIDUAL_PARALLEL_SIZE) {
    if (await isJobCancelled(jobId)) {
      console.log(`[SyncFlow] Job ${jobId} cancelled at product group ${i}/${groupedProducts.length}`);
      return;
    }

    const batch = groupedProducts.slice(i, i + INDIVIDUAL_PARALLEL_SIZE);
    await Promise.all(batch.map(group => syncGroupedProduct(channel, group, mappings, metafieldMappings, jobId, withImages, shopifyMap, locationId, priceAdjustmentPercent, priceRoundingMode)));

    processed += batch.reduce((sum, group) => sum + group.rows.length, 0);
    await query('UPDATE sync_jobs SET processed_count = $1 WHERE id = $2', [processed, jobId]);
  }
}

async function syncGroupedProduct(
  channel: Channel,
  group: GroupedProduct,
  mappings: AttributeMapping[],
  metafieldMappings: AttributeMapping[],
  jobId: string,
  withImages: boolean,
  shopifyMap: Map<string, { productId: string; variantId: string; inventoryItemId: string }>,
  locationId?: string,
  priceAdjustmentPercent = 0,
  priceRoundingMode: 'none' | 'up' | 'down' = 'none',
) {
  const firstRow = group.rows[0];

  if (group.rows.length > 1) {
    // Multiple rows share the same handle → variant group
    try {
      validateVariantSKUs(group.rows);
      await syncVariantGroup(channel, group, mappings, metafieldMappings, withImages, shopifyMap, locationId, priceAdjustmentPercent, priceRoundingMode);
      await logSyncEntry(jobId, firstRow.sku, 'updated', `Variant group synced (${group.rows.length} rows, handle: ${group.handle})`);
      await query('UPDATE sync_jobs SET updated_count = updated_count + $1 WHERE id = $2', [group.rows.length, jobId]);
    } catch (err) {
      const message = String(err);
      for (const row of group.rows) {
        await logSyncEntry(jobId, row.sku, 'failed', message);
      }
      await query('UPDATE sync_jobs SET failed_count = failed_count + $1 WHERE id = $2', [group.rows.length, jobId]);
    }
    return;
  }

  await Promise.all(group.rows.map(async (product) => {
    const shopifyIds = shopifyMap.get(product.sku);
    const mapped = applyPriceAdjustment(applyMappings(product.raw_data, mappings), priceAdjustmentPercent, priceRoundingMode);

    try {
      if (!shopifyIds) {
        await createShopifyProduct(channel, product.sku, mapped, withImages, mappings, product.raw_data);
        await logSyncEntry(jobId, product.sku, 'created', 'New product created in Shopify');
        await query('UPDATE sync_jobs SET created_count = created_count + 1 WHERE id = $1', [jobId]);
      } else {
        const updatePromises: Promise<unknown>[] = [];
        const updateMutation = `
          mutation productUpdate($input: ProductInput!) {
            productUpdate(input: $input) {
              product { id }
              userErrors { field message }
            }
          }`;
        const input: Record<string, unknown> = { id: shopifyIds.productId };
        if (mapped.title) input.title = mapped.title;
        if (mapped.body_html) input.descriptionHtml = mapped.body_html;
        if (mapped.tags) input.tags = String(mapped.tags).split(',').map(t => t.trim());
        if (mapped.vendor) input.vendor = mapped.vendor;
        if (mapped.status) input.status = String(mapped.status).toUpperCase();

        if (metafieldMappings.length > 0) {
          const metafields = metafieldMappings
            .filter(m => product.raw_data[m.feed_column] !== undefined && product.raw_data[m.feed_column] !== null && product.raw_data[m.feed_column] !== '')
            .map(m => {
              const parts = m.target_field.replace('metafield:', '').split(':');
              return {
                namespace: parts[0],
                key: parts[1],
                type: parts[2] || 'single_line_text_field',
                value: String(product.raw_data[m.feed_column]),
              };
            });
          if (metafields.length > 0) {
            input.metafields = metafields;
          }
        }

        if (Object.keys(input).length > 1) {
          updatePromises.push(shopifyGraphQL(channel, updateMutation, { input }));
        }

        if (mapped.price || mapped.compare_at_price) {
          const variantMutation = `
            mutation variantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
              productVariantsBulkUpdate(productId: $productId, variants: $variants) {
                productVariants { id }
                userErrors { field message }
              }
            }`;
          const variantInput: Record<string, unknown> = { id: shopifyIds.variantId };
          if (mapped.price) variantInput.price = String(mapped.price);
          if (mapped.compare_at_price) variantInput.compareAtPrice = String(mapped.compare_at_price);
          updatePromises.push(shopifyGraphQL(channel, variantMutation, {
            productId: shopifyIds.productId,
            variants: [variantInput],
          }));
        }

        if (mapped.inventory_quantity !== undefined && locationId) {
          const stockQuery = `
            mutation inventorySetQuantities($input: InventorySetQuantitiesInput!) {
              inventorySetQuantities(input: $input) {
                inventoryAdjustmentGroup { reason }
                userErrors { field message }
              }
            }`;
          updatePromises.push(shopifyGraphQL(channel, stockQuery, {
            input: {
              name: "available",
              reason: "correction",
              quantities: [{
                inventoryItemId: shopifyIds.inventoryItemId,
                locationId,
                quantity: parseInt(String(mapped.inventory_quantity)),
              }],
            },
          }));
        }

        if (withImages && mapped.image_url) {
          const urls = String(mapped.image_url).split(',').map(u => u.trim()).filter(Boolean);
          if (urls.length > 0) {
            const mediaMutation = `
              mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
                productCreateMedia(productId: $productId, media: $media) {
                  media { id }
                  mediaUserErrors { field message }
                }
              }`;
            updatePromises.push(shopifyGraphQL(channel, mediaMutation, {
              productId: shopifyIds.productId,
              media: urls.map(url => ({ originalSource: url, mediaContentType: 'IMAGE' })),
            }));
          }
        }

        await Promise.all(updatePromises);

        await logSyncEntry(jobId, product.sku, 'updated', 'Full sync succeeded');
        await query('UPDATE sync_jobs SET updated_count = updated_count + 1 WHERE id = $1', [jobId]);
      }
    } catch (err) {
      await logSyncEntry(jobId, product.sku, 'failed', String(err));
      await query('UPDATE sync_jobs SET failed_count = failed_count + 1 WHERE id = $1', [jobId]);
    }
  }));
}

async function createShopifyProduct(channel: Channel, sku: string, mapped: Record<string, unknown>, withImages: boolean, mappings?: AttributeMapping[], rawData?: Record<string, unknown>) {
  const createMutation = `
    mutation productCreate($product: ProductCreateInput!, $media: [CreateMediaInput!]) {
      productCreate(product: $product, media: $media) {
        product { id variants(first: 1) { edges { node { id } } } }
        userErrors { field message }
      }
    }`;

  const product: Record<string, unknown> = {
    title: mapped.title || sku,
    descriptionHtml: mapped.body_html || '',
    vendor: mapped.vendor || '',
    tags: mapped.tags ? String(mapped.tags).split(',').map(t => t.trim()) : [],
    status: mapped.status ? String(mapped.status).toUpperCase() : 'DRAFT',
  };

  // Add metafields to create input
  if (mappings && rawData) {
    const metafieldMappings = mappings.filter(m => m.target_field.startsWith('metafield:'));
    const metafields = metafieldMappings
      .filter(m => rawData[m.feed_column] !== undefined && rawData[m.feed_column] !== null && rawData[m.feed_column] !== '')
      .map(m => {
        const parts = m.target_field.replace('metafield:', '').split(':');
        return {
          namespace: parts[0],
          key: parts[1],
          type: parts[2] || 'single_line_text_field',
          value: String(rawData[m.feed_column]),
        };
      });
    if (metafields.length > 0) {
      product.metafields = metafields;
    }
  }

  // Media (images) — handles comma-separated URLs
  const media: Array<{ originalSource: string; mediaContentType: string }> = [];
  if (withImages && mapped.image_url) {
    const urls = String(mapped.image_url).split(',').map(u => u.trim()).filter(Boolean);
    for (const url of urls) {
      media.push({ originalSource: url, mediaContentType: 'IMAGE' });
    }
  }

  const result = await shopifyGraphQL(channel, createMutation, {
    product,
    media: media.length > 0 ? media : undefined,
  }) as { productCreate: { product: { id: string; variants: { edges: Array<{ node: { id: string } }> } }; userErrors: Array<{ field: string; message: string }> } };

  if (result.productCreate.userErrors?.length > 0) {
    throw new Error(JSON.stringify(result.productCreate.userErrors));
  }

  const productId = result.productCreate.product?.id;
  const variantId = result.productCreate.product?.variants?.edges?.[0]?.node?.id;

  // Update default variant with SKU + price
  if (variantId && productId) {
    const variantMutation = `
      mutation variantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          productVariants { id sku }
          userErrors { field message }
        }
      }`;
    const inventoryItem: Record<string, unknown> = { sku, tracked: mapped.inventory_quantity !== undefined };
    if (mapped.weight !== undefined && mapped.weight !== '' && mapped.weight !== null) {
      const weightVal = parseFloat(String(mapped.weight));
      if (!isNaN(weightVal)) {
        const unit = String(mapped.variant_weight_unit || 'GRAMS').toUpperCase();
        const validUnits = ['GRAMS', 'KILOGRAMS', 'OUNCES', 'POUNDS'];
        inventoryItem.measurement = {
          weight: { value: weightVal, unit: validUnits.includes(unit) ? unit : 'GRAMS' },
        };
      }
    }
    await shopifyGraphQL(channel, variantMutation, {
      productId,
      variants: [{
        id: variantId,
        price: mapped.price ? String(mapped.price) : '0.00',
        compareAtPrice: mapped.compare_at_price ? String(mapped.compare_at_price) : null,
        inventoryItem,
      }],
    });
  }

  // Publish product to all sales channels
  if (productId) {
    await publishToSalesChannels(channel, productId);
  }
}

// ── Publish product to all sales channels ──────────────────────────────────
async function publishToSalesChannels(channel: Channel, productId: string) {
  try {
    const pubQuery = `{ publications(first: 20) { edges { node { id name } } } }`;
    const pubData = await shopifyGraphQL(channel, pubQuery) as { publications: { edges: Array<{ node: { id: string; name: string } }> } };
    const publicationIds = pubData.publications?.edges?.map(e => e.node.id) || [];

    if (publicationIds.length > 0) {
      const publishMutation = `
        mutation publishablePublish($id: ID!, $input: [PublicationInput!]!) {
          publishablePublish(id: $id, input: $input) {
            publishable { publishedOnCurrentPublication }
            userErrors { field message }
          }
        }`;
      await shopifyGraphQL(channel, publishMutation, {
        id: productId,
        input: publicationIds.map(pid => ({ publicationId: pid })),
      });
    }
  } catch (pubErr) {
    console.warn(`[Sync] Could not publish product ${productId}:`, pubErr);
  }
}

// ── Mapping Helper ─────────────────────────────────────────────────────────
function applyMappings(rawData: Record<string, unknown>, mappings: AttributeMapping[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const m of mappings) {
    if (rawData[m.feed_column] !== undefined) {
      result[m.target_field] = rawData[m.feed_column];
    }
  }
  return result;
}

function groupRowsByHandle(products: ProductRow[], mappings: AttributeMapping[]): GroupedProduct[] {
  const groups = new Map<string, ProductRow[]>();

  for (const product of products) {
    const mapped = applyMappings(product.raw_data, mappings);
    // Use mapped handle if available, otherwise generate a unique one from title or SKU
    const handle = normalizeHandle(mapped.handle)
      || normalizeHandle(mapped.title)
      || normalizeHandle(product.sku)
      || `sku-${product.sku.toLowerCase()}`;

    const existing = groups.get(handle) || [];
    existing.push(product);
    groups.set(handle, existing);
  }

  return Array.from(groups.entries()).map(([handle, rows]) => ({ handle, rows }));
}

function normalizeHandle(value: unknown): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function rowHasAnyVariantOption(mapped: Record<string, unknown>): boolean {
  return ['option1_value', 'option2_value', 'option3_value'].some(key => {
    const value = mapped[key];
    return value !== undefined && value !== null && String(value).trim() !== '';
  });
}

function hasVariantOptions(rows: ProductRow[], mappings: AttributeMapping[]): boolean {
  return rows.length > 1 && Boolean(buildVariantOptions(rows, mappings));
}

function validateVariantSKUs(rows: ProductRow[]) {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const row of rows) {
    const sku = String(row.sku || '').trim();
    if (!sku) continue;
    if (seen.has(sku)) duplicates.add(sku);
    seen.add(sku);
  }
  if (duplicates.size > 0) {
    throw new Error(`Duplicate variant SKUs in group: ${Array.from(duplicates).join(', ')}`);
  }
}

async function syncVariantGroup(
  channel: Channel,
  group: GroupedProduct,
  mappings: AttributeMapping[],
  metafieldMappings: AttributeMapping[],
  withImages: boolean,
  shopifyMap: Map<string, { productId: string; variantId: string; inventoryItemId: string }>,
  locationId?: string,
  priceAdjustmentPercent = 0,
  priceRoundingMode: 'none' | 'up' | 'down' = 'none',
) {
  const mappedRows = group.rows.map(row => ({ row, mapped: applyPriceAdjustment(applyMappings(row.raw_data, mappings), priceAdjustmentPercent, priceRoundingMode) }));
  const first = mappedRows[0];
  const productIds = group.rows
    .map(row => shopifyMap.get(row.sku)?.productId)
    .filter((value): value is string => Boolean(value));
  const distinctProductIds = new Set(productIds);
  const existingProductId = chooseCanonicalProductId(productIds);

  const productOptions = buildVariantOptions(group.rows, mappings);

  if (productOptions.length === 0) {
    throw new Error(`Variant group ${group.handle} has no valid option names/values`);
  }

  const fileMap = new Map<string, { originalSource: string; contentType: string }>();
  if (withImages) {
    for (const entry of mappedRows) {
      const urls = String(entry.mapped.image_url || '').split(',').map(url => url.trim()).filter(Boolean);
      for (const url of urls) {
        if (!fileMap.has(url)) fileMap.set(url, { originalSource: url, contentType: 'IMAGE' });
      }
    }
  }

  const metafields = metafieldMappings
    .filter(m => first.row.raw_data[m.feed_column] !== undefined && first.row.raw_data[m.feed_column] !== null && first.row.raw_data[m.feed_column] !== '')
    .map(m => {
      const parts = m.target_field.replace('metafield:', '').split(':');
      return {
        namespace: parts[0],
        key: parts[1],
        type: parts[2] || 'single_line_text_field',
        value: String(first.row.raw_data[m.feed_column]),
      };
    });

  const input: Record<string, unknown> = {
    title: first.mapped.title || first.row.sku,
    handle: group.handle,
    productOptions: productOptions.map(({ name, position, values }) => ({ name, position, values })),
    variants: mappedRows.map((entry, index) => {
      const shopifyIds = shopifyMap.get(entry.row.sku);
      const optionValues = productOptions.map(option => ({
        optionName: option!.name,
        name: option.valuesBySku[entry.row.sku] || '',
      }));

      const variant: Record<string, unknown> = {
        position: index + 1,
        sku: entry.row.sku,
        optionValues,
      };

      if (shopifyIds?.variantId) variant.id = shopifyIds.variantId;
      if (entry.mapped.price !== undefined && entry.mapped.price !== null && entry.mapped.price !== '') variant.price = String(entry.mapped.price);
      if (entry.mapped.compare_at_price !== undefined && entry.mapped.compare_at_price !== null && entry.mapped.compare_at_price !== '') {
        variant.compareAtPrice = String(entry.mapped.compare_at_price);
      }
      if (entry.mapped.barcode) variant.barcode = String(entry.mapped.barcode);
      if (entry.mapped.taxable !== undefined) variant.taxable = ['true', '1', 'yes'].includes(String(entry.mapped.taxable).toLowerCase());

      // Inventory tracking + quantity
      const hasInventory = entry.mapped.inventory_quantity !== undefined;
      if (hasInventory && locationId) {
        variant.inventoryQuantities = [{
          locationId,
          name: 'available',
          quantity: parseInt(String(entry.mapped.inventory_quantity)),
        }];
      }

      // Build inventoryItem (tracked + weight)
      const inventoryItem: Record<string, unknown> = {};
      if (hasInventory) inventoryItem.tracked = true;
      if (entry.mapped.weight !== undefined && entry.mapped.weight !== '' && entry.mapped.weight !== null) {
        const weightVal = parseFloat(String(entry.mapped.weight));
        if (!isNaN(weightVal)) {
          const unit = String(entry.mapped.variant_weight_unit || 'GRAMS').toUpperCase();
          const validUnits = ['GRAMS', 'KILOGRAMS', 'OUNCES', 'POUNDS'];
          inventoryItem.measurement = {
            weight: { value: weightVal, unit: validUnits.includes(unit) ? unit : 'GRAMS' },
          };
        }
      }
      if (Object.keys(inventoryItem).length > 0) variant.inventoryItem = inventoryItem;

      const variantImage = withImages ? String(entry.mapped.image_url || '').split(',').map(url => url.trim()).find(Boolean) : null;
      if (variantImage) {
        variant.file = { originalSource: variantImage, contentType: 'IMAGE' };
      }

      return variant;
    }),
  };

  if (existingProductId) input.id = existingProductId;
  if (first.mapped.body_html) input.descriptionHtml = first.mapped.body_html;
  if (first.mapped.vendor) input.vendor = first.mapped.vendor;
  if (first.mapped.product_type) input.productType = first.mapped.product_type;
  if (first.mapped.tags) input.tags = String(first.mapped.tags).split(',').map(tag => tag.trim()).filter(Boolean);
  if (first.mapped.status) input.status = String(first.mapped.status).toUpperCase();
  if (metafields.length > 0) input.metafields = metafields;
  if (fileMap.size > 0) input.files = Array.from(fileMap.values());

  const mutation = `
    mutation productSetSync($input: ProductSetInput!, $synchronous: Boolean!) {
      productSet(input: $input, synchronous: $synchronous) {
        product { id }
        userErrors { code field message }
      }
    }`;

  const result = await shopifyGraphQL(channel, mutation, {
    input,
    synchronous: true,
  }) as { productSet: { product?: { id: string }; userErrors?: Array<{ field?: string[]; message: string }> } };

  if (result.productSet.userErrors && result.productSet.userErrors.length > 0) {
    throw new Error(result.productSet.userErrors.map(err => err.message).join('; '));
  }

  // Publish product to all sales channels
  const createdProductId = result.productSet.product?.id;
  if (createdProductId) {
    await publishToSalesChannels(channel, createdProductId);
  }

  if (existingProductId && distinctProductIds.size > 1) {
    await deleteDuplicateGroupedProducts(channel, Array.from(distinctProductIds).filter(id => id !== existingProductId));
  }
}

function buildVariantOptions(rows: ProductRow[], mappings: AttributeMapping[]): Array<{ name: string; position: number; values: Array<{ name: string }>; valuesBySku: Record<string, string> }> {
  const mappedRows = rows.map(row => ({ row, mapped: applyMappings(row.raw_data, mappings) }));
  const explicitOptions = [1, 2, 3]
    .map(index => {
      const name = mappedRows.map(entry => String(entry.mapped[`option${index}_name`] || '').trim()).find(Boolean);
      const valuesBySku = Object.fromEntries(
        mappedRows
          .map(entry => [entry.row.sku, String(entry.mapped[`option${index}_value`] || '').trim()] as const)
          .filter(([, value]) => Boolean(value))
      );
      const values = Array.from(new Set(Object.values(valuesBySku))).filter(Boolean);
      if (!name || values.length === 0) return null;
      return {
        name,
        position: index,
        values: values.map(value => ({ name: value })),
        valuesBySku,
      };
    })
    .filter((option): option is { name: string; position: number; values: Array<{ name: string }>; valuesBySku: Record<string, string> } => Boolean(option));

  if (explicitOptions.length > 0) {
    return explicitOptions;
  }

  const inferredOption = inferVariantOptionFromRows(rows);
  if (inferredOption) {
    return [{
      name: inferredOption.name,
      position: 1,
      values: Array.from(new Set(Object.values(inferredOption.valuesBySku))).map(value => ({ name: value })),
      valuesBySku: inferredOption.valuesBySku,
    }];
  }

  const skuValuesBySku = Object.fromEntries(rows.map(row => [row.sku, row.sku]));
  return [{
    name: 'SKU',
    position: 1,
    values: rows.map(row => ({ name: row.sku })),
    valuesBySku: skuValuesBySku,
  }];
}

function inferVariantOptionFromRows(rows: ProductRow[]): { name: string; valuesBySku: Record<string, string> } | null {
  const preferredKeys = ['size', 'color', 'colour', 'variant', 'style', 'material', 'scent', 'flavor', 'flavour'];
  const firstRow = rows[0]?.raw_data || {};
  const headers = Object.keys(firstRow);

  for (const preferredKey of preferredKeys) {
    const matchingHeader = headers.find(header => normalizeComparisonKey(header) === preferredKey);
    if (!matchingHeader) continue;
    const valuesBySku = Object.fromEntries(
      rows
        .map(row => [row.sku, String(row.raw_data[matchingHeader] || '').trim()] as const)
        .filter(([, value]) => Boolean(value))
    );
    const distinctValues = Array.from(new Set(Object.values(valuesBySku)));
    if (distinctValues.length > 1) {
      return { name: matchingHeader, valuesBySku };
    }
  }

  for (const header of headers) {
    const valuesBySku = Object.fromEntries(
      rows
        .map(row => [row.sku, String(row.raw_data[header] || '').trim()] as const)
        .filter(([, value]) => Boolean(value))
    );
    const distinctValues = Array.from(new Set(Object.values(valuesBySku)));
    if (distinctValues.length === rows.length && distinctValues.length > 1) {
      return { name: header, valuesBySku };
    }
  }

  return null;
}

function normalizeComparisonKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

async function deleteDuplicateGroupedProducts(channel: Channel, productIds: string[]) {
  if (productIds.length === 0) return;

  const mutation = `
    mutation productDeleteSync($input: ProductDeleteInput!) {
      productDelete(input: $input) {
        deletedProductId
        userErrors { field message }
      }
    }`;

  for (const productId of productIds) {
    const result = await shopifyGraphQL(channel, mutation, {
      input: { id: productId },
    }) as { productDelete: { deletedProductId?: string; userErrors?: Array<{ message: string }> } };

    if (result.productDelete.userErrors && result.productDelete.userErrors.length > 0) {
      throw new Error(result.productDelete.userErrors.map(err => err.message).join('; '));
    }
  }
}

function chooseCanonicalProductId(productIds: string[]): string | undefined {
  if (productIds.length === 0) return undefined;

  const counts = new Map<string, number>();
  for (const productId of productIds) {
    counts.set(productId, (counts.get(productId) || 0) + 1);
  }

  const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  const [candidateId, candidateCount] = sorted[0];

  if (counts.size === 1 || candidateCount > 1) {
    return candidateId;
  }

  return undefined;
}

function applyPriceAdjustment(
  mapped: Record<string, unknown>,
  priceAdjustmentPercent = 0,
  priceRoundingMode: 'none' | 'up' | 'down' = 'none'
): Record<string, unknown> {
  if (!priceAdjustmentPercent && priceRoundingMode === 'none') return mapped;

  const adjusted = { ...mapped };
  for (const field of ['price', 'compare_at_price']) {
    const current = adjusted[field];
    if (current === undefined || current === null || current === '') continue;
    const numeric = Number(current);
    if (Number.isFinite(numeric)) {
      let nextValue = numeric * (1 + (priceAdjustmentPercent / 100));
      if (priceRoundingMode === 'up') {
        nextValue = Math.ceil(nextValue);
      } else if (priceRoundingMode === 'down') {
        nextValue = Math.floor(nextValue);
      }
      adjusted[field] = nextValue.toFixed(2);
    }
  }
  return adjusted;
}

// ── Logging ────────────────────────────────────────────────────────────────
async function logSyncEntry(jobId: string, sku: string, action: string, message: string) {
  await query(
    'INSERT INTO sync_logs (job_id, sku, action, message) VALUES ($1, $2, $3, $4)',
    [jobId, sku, action, message]
  );
}

// ── Filter Rules Evaluator ─────────────────────────────────────────────────
function evaluateFilterRules(rawData: Record<string, unknown>, rules: Array<{ field: string; operator: string; value: string; logic?: string }>): boolean {
  if (!rules || rules.length === 0) return true;
  let currentResult = true;
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    const fieldValue = String(rawData[rule.field] || '').toLowerCase();
    const ruleValue = String(rule.value || '').toLowerCase();
    let ruleMatches = false;
    switch (rule.operator) {
      case 'equals': ruleMatches = fieldValue === ruleValue; break;
      case 'not_equals': ruleMatches = fieldValue !== ruleValue; break;
      case 'contains': ruleMatches = fieldValue.includes(ruleValue); break;
      case 'not_contains': ruleMatches = !fieldValue.includes(ruleValue); break;
      case 'greater_than': ruleMatches = parseFloat(fieldValue) > parseFloat(ruleValue); break;
      case 'less_than': ruleMatches = parseFloat(fieldValue) < parseFloat(ruleValue); break;
      case 'greater_or_equal': ruleMatches = parseFloat(fieldValue) >= parseFloat(ruleValue); break;
      case 'less_or_equal': ruleMatches = parseFloat(fieldValue) <= parseFloat(ruleValue); break;
      case 'starts_with': ruleMatches = fieldValue.startsWith(ruleValue); break;
      case 'ends_with': ruleMatches = fieldValue.endsWith(ruleValue); break;
      case 'is_empty': ruleMatches = fieldValue === '' || fieldValue === 'null' || fieldValue === 'undefined'; break;
      case 'is_not_empty': ruleMatches = fieldValue !== '' && fieldValue !== 'null' && fieldValue !== 'undefined'; break;
      case 'equals_any': ruleMatches = ruleValue.split(/\s+/).some(v => fieldValue === v); break;
      case 'not_equals_any': ruleMatches = !ruleValue.split(/\s+/).some(v => fieldValue === v); break;
      default: ruleMatches = true;
    }
    if (rule.logic === 'or') {
      if (currentResult) return true;
      currentResult = ruleMatches;
    } else {
      currentResult = currentResult && ruleMatches;
    }
  }
  return currentResult;
}

// ── Main Entry Point ───────────────────────────────────────────────────────
export async function runSyncJob(config: SyncJobConfig) {
  const {
    jobId,
    channel,
    feedId,
    preset,
    filterRules,
    skus,
    priceAdjustmentPercent = 0,
    priceRoundingMode = 'none',
  } = config;

  try {
    await query("UPDATE sync_jobs SET status = 'running', started_at = NOW() WHERE id = $1", [jobId]);

    let products: ProductRow[];
    let sourceCount = 0;
    if (skus && skus.length > 0) {
      // Only fetch specific SKUs (auto-sync for changed products)
      const productsResult = await query(
        'SELECT sku, raw_data FROM products WHERE feed_id = $1 AND status = $2 AND sku = ANY($3)',
        [feedId, 'active', skus]
      );
      products = productsResult.rows;
      sourceCount = products.length;
    } else {
      const productsResult = await query(
        'SELECT sku, raw_data FROM products WHERE feed_id = $1 AND status = $2',
        [feedId, 'active']
      );
      products = productsResult.rows;
      sourceCount = products.length;
    }

    if (filterRules && filterRules.length > 0) {
      products = products.filter(p => evaluateFilterRules(p.raw_data, filterRules));
      console.log(`[SyncFlow] Filter rules applied: ${sourceCount} → ${products.length} products`);
    }

    await query('UPDATE sync_jobs SET total_products = $1 WHERE id = $2', [products.length, jobId]);

    const mappingsResult = await query(
      'SELECT feed_column, target_field FROM attribute_mappings WHERE feed_id = $1 AND channel_id = $2',
      [feedId, channel.id]
    );
    const mappings: AttributeMapping[] = mappingsResult.rows;

    console.log(`[SyncFlow] Job ${jobId} | Preset: ${preset} | Products: ${products.length}`);

    if (preset === 'price_stock_meta' || (config.fields && config.fields.every(f => ['price', 'stock', 'metafields'].includes(f)))) {
      console.log('[SyncFlow] Pathway: TURBO');
      await turboSync(channel, products, mappings, jobId, priceAdjustmentPercent, priceRoundingMode);
    } else if (products.length < 50) {
      console.log('[SyncFlow] Pathway: INDIVIDUAL');
      await individualSync(channel, products, mappings, jobId, preset !== 'sync_all_no_images', priceAdjustmentPercent, priceRoundingMode);
    } else {
      console.log('[SyncFlow] Pathway: INDIVIDUAL (large batch, parallel)');
      await individualSync(channel, products, mappings, jobId, preset === 'sync_all', priceAdjustmentPercent, priceRoundingMode);
    }

    // Don't mark complete if cancelled
    if (await isJobCancelled(jobId)) {
      console.log(`[SyncFlow] Job ${jobId} was cancelled`);
      return;
    }

    await query("UPDATE sync_jobs SET status = 'completed', completed_at = NOW() WHERE id = $1", [jobId]);
    console.log(`[SyncFlow] Job ${jobId} completed`);
  } catch (err) {
    console.error(`[SyncFlow] Job ${jobId} failed:`, err);
    await query(
      "UPDATE sync_jobs SET status = 'failed', completed_at = NOW(), error_message = $1 WHERE id = $2",
      [String(err), jobId]
    );
  } finally {
    cancelledJobs.delete(jobId);
  }
}
