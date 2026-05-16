/**
 * Shopify Sync Engine — SyncFlow
 *
 * Execution pathways (auto-selected by product count):
 *  1. Turbo Mode        → parallel GraphQL mutations, price/stock/meta only (≤200 products)
 *  2. Ultra Mode        → 3-phase parallel: update existing + create new + variant groups (≤200 products)
 *  3. Bulk Sync         → Shopify Bulk Operations API via JSONL upload, NO rate limits (>200 products)
 *     - Uses productSet mutation: product + variant + price + stock ALL in one JSONL line per product
 *     - 2 sequential bulk ops: productSet (main) + inventoryItemUpdate (tracking/weight)
 *     - Falls back to Turbo/Ultra if bulk operations fail
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
  includeImages?: boolean;
  priceAdjustmentPercent?: number;
  priceRoundingMode?: 'none' | 'up' | 'down';
  warehouseName?: string;
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

interface SyncLogDetails {
  stock_from: number | null;
  stock_to: number | null;
  price_from: string | null;
  price_to: string | null;
  warehouse_name: string | null;
}

const TURBO_BATCH_SIZE = 40; // Ultra turbo parallel batch
const IMAGE_TURBO_BATCH_SIZE = 15; // Turbo with images (more API calls per product)
const CREATE_PARALLEL_SIZE = 20; // Parallel product creation
const VARIANT_PARALLEL_SIZE = 20; // Variant group parallel processing
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

const FETCH_TIMEOUT_MS = 30000; // 30-second timeout per request

// ── Rate-limited fetch with retry ──────────────────────────────────────────
async function shopifyFetchWithRetry(url: string, options: RequestInit, retries = 0): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { ...options, signal: controller.signal });
  } catch (err: unknown) {
    clearTimeout(timeoutId);
    if (err instanceof Error && err.name === 'AbortError' && retries < MAX_RETRIES) {
      const backoff = RETRY_DELAY_MS * Math.pow(1.5, retries);
      console.log(`[SyncFlow] Request timed out after ${FETCH_TIMEOUT_MS}ms, retrying in ${Math.round(backoff)}ms (retry ${retries + 1})`);
      await sleep(backoff);
      return shopifyFetchWithRetry(url, options, retries + 1);
    }
    throw err;
  }
  clearTimeout(timeoutId);
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

// ── Metafield Definitions Cache ────────────────────────────────────────────
const metafieldDefCache = new Map<string, { defs: Map<string, string>; fetchedAt: number }>();
const METAFIELD_DEF_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// ── Publication IDs Cache ──────────────────────────────────────────────────
const publicationIdsCache = new Map<string, { ids: string[]; fetchedAt: number }>();
const PUBLICATION_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getCachedPublicationIds(channel: Channel): Promise<string[]> {
  const cacheKey = channel.id;
  const cached = publicationIdsCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < PUBLICATION_CACHE_TTL) {
    return cached.ids;
  }
  const pubQuery = `{ publications(first: 20) { edges { node { id } } } }`;
  const pubData = await shopifyGraphQL(channel, pubQuery) as { publications: { edges: Array<{ node: { id: string } }> } };
  const ids = pubData.publications?.edges?.map(e => e.node.id) || [];
  publicationIdsCache.set(cacheKey, { ids, fetchedAt: Date.now() });
  return ids;
}

async function getMetafieldDefinitions(channel: Channel): Promise<Map<string, string>> {
  const cacheKey = channel.id;
  const cached = metafieldDefCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < METAFIELD_DEF_CACHE_TTL) {
    return cached.defs;
  }
  const defs = new Map<string, string>();
  try {
    const defQuery = `{ metafieldDefinitions(ownerType: PRODUCT, first: 250) { edges { node { namespace key type { name } } } } }`;
    const result = await shopifyGraphQL(channel, defQuery) as {
      metafieldDefinitions: { edges: Array<{ node: { namespace: string; key: string; type: { name: string } } }> }
    };
    for (const edge of result.metafieldDefinitions.edges) {
      const { namespace, key, type } = edge.node;
      defs.set(`${namespace}.${key}`, type.name);
    }
    console.log(`[SyncFlow] Fetched ${defs.size} metafield definitions from Shopify`);
  } catch (err) {
    console.warn(`[SyncFlow] Could not fetch metafield definitions, using user-selected types:`, err);
  }
  metafieldDefCache.set(cacheKey, { defs, fetchedAt: Date.now() });
  return defs;
}

function buildMetafields(
  rawData: Record<string, string | number | null>,
  metafieldMappings: AttributeMapping[],
  shopifyDefs: Map<string, string>,
): Array<{ namespace: string; key: string; type: string; value: string }> {
  return metafieldMappings
    .filter(m => rawData[m.feed_column] !== undefined && rawData[m.feed_column] !== null && rawData[m.feed_column] !== '')
    .map(m => {
      const parts = m.target_field.replace('metafield:', '').split(':');
      const namespace = parts[0];
      const key = parts[1];
      const userType = parts[2] || 'single_line_text_field';
      // Auto-detect: use Shopify definition type if available, else user's selection
      const defType = shopifyDefs.get(`${namespace}.${key}`);
      const mfType = defType || userType;
      return {
        namespace,
        key,
        type: mfType,
        value: formatMetafieldValue(rawData[m.feed_column], mfType),
      };
    });
}

function parseMappedWeight(mapped: Record<string, unknown>): { value: number; unit: string } | null {
  if (mapped.weight === undefined || mapped.weight === null || mapped.weight === '') {
    return null;
  }

  const value = parseFloat(String(mapped.weight));
  if (Number.isNaN(value)) {
    return null;
  }

  const unit = String(mapped.variant_weight_unit || 'GRAMS').toUpperCase();
  const validUnits = ['GRAMS', 'KILOGRAMS', 'OUNCES', 'POUNDS'];
  return {
    value,
    unit: validUnits.includes(unit) ? unit : 'GRAMS',
  };
}

function isTruthyValue(value: unknown): boolean {
  return ['true', '1', 'yes'].includes(String(value).toLowerCase());
}

function isValidImageUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

// Transform Google Drive URLs to direct download format that Shopify can fetch server-side.
// The uc?export=download endpoint serves the original file with correct Content-Type
// and Content-Disposition headers (including original filename with extension).
function toDirectImageUrl(url: string): string {
  let fileId: string | null = null;

  // https://drive.google.com/file/d/FILE_ID/view?usp=sharing
  const driveFileMatch = url.match(/drive\.google\.com\/file\/d\/([^/?]+)/);
  if (driveFileMatch) fileId = driveFileMatch[1];

  // https://drive.google.com/open?id=FILE_ID
  if (!fileId) {
    const driveOpenMatch = url.match(/drive\.google\.com\/open\?id=([^&]+)/);
    if (driveOpenMatch) fileId = driveOpenMatch[1];
  }

  // https://drive.google.com/uc?id=FILE_ID (already a direct link, just ensure export=download)
  if (!fileId) {
    const driveUcMatch = url.match(/drive\.google\.com\/uc\?.*id=([^&]+)/);
    if (driveUcMatch) fileId = driveUcMatch[1];
  }

  // https://lh3.googleusercontent.com/d/FILE_ID
  if (!fileId) {
    const lh3Match = url.match(/lh3\.googleusercontent\.com\/d\/([^=/?]+)/);
    if (lh3Match) fileId = lh3Match[1];
  }

  if (fileId) {
    return `https://drive.google.com/uc?id=${fileId}&export=download`;
  }
  return url;
}

async function updateInventoryItemDetails(
  channel: Channel,
  inventoryItemId: string,
  mapped: Record<string, unknown>
): Promise<void> {
  const input: Record<string, unknown> = {};

  if (mapped.inventory_quantity !== undefined) {
    input.tracked = true;
  }

  const weight = parseMappedWeight(mapped);
  if (weight) {
    input.measurement = { weight };
  }

  if (Object.keys(input).length === 0) {
    return;
  }

  const mutation = `
    mutation inventoryItemUpdate($id: ID!, $input: InventoryItemInput!) {
      inventoryItemUpdate(id: $id, input: $input) {
        inventoryItem {
          id
          tracked
          measurement {
            weight {
              value
              unit
            }
          }
        }
        userErrors { field message }
      }
    }`;

  const result = await shopifyGraphQL(channel, mutation, {
    id: inventoryItemId,
    input,
  }) as {
    inventoryItemUpdate: {
      userErrors?: Array<{ field?: string[]; message: string }>;
    };
  };

  if (result.inventoryItemUpdate.userErrors && result.inventoryItemUpdate.userErrors.length > 0) {
    throw new Error(result.inventoryItemUpdate.userErrors.map(err => err.message).join('; '));
  }
}

async function getVariantInventoryItemId(channel: Channel, variantId: string): Promise<string | null> {
  const query = `
    query getVariantInventoryItemId($variantId: ID!) {
      productVariant(id: $variantId) {
        inventoryItem { id }
      }
    }`;

  const result = await shopifyGraphQL(channel, query, { variantId }) as {
    productVariant?: { inventoryItem?: { id: string } };
  };

  return result.productVariant?.inventoryItem?.id || null;
}

async function getProductVariantInventoryMap(channel: Channel, productId: string): Promise<Map<string, string>> {
  const query = `
    query getProductVariantInventoryMap($id: ID!) {
      product(id: $id) {
        variants(first: 100) {
          edges {
            node {
              sku
              inventoryItem { id }
            }
          }
        }
      }
    }`;

  const result = await shopifyGraphQL(channel, query, { id: productId }) as {
    product?: {
      variants?: {
        edges: Array<{ node: { sku: string; inventoryItem?: { id: string } } }>;
      };
    };
  };

  const inventoryMap = new Map<string, string>();
  for (const edge of result.product?.variants?.edges || []) {
    if (edge.node.sku && edge.node.inventoryItem?.id) {
      inventoryMap.set(edge.node.sku, edge.node.inventoryItem.id);
    }
  }

  return inventoryMap;
}

// ── Delete all existing media from a product ───────────────────────────────
async function deleteExistingProductMedia(channel: Channel, productId: string): Promise<void> {
  // Fetch all media IDs for the product
  const mediaQuery = `
    query getProductMedia($id: ID!) {
      product(id: $id) {
        media(first: 250) {
          edges { node { id } }
        }
      }
    }`;
  const mediaResult = await shopifyGraphQL(channel, mediaQuery, { id: productId }) as {
    product?: { media?: { edges: Array<{ node: { id: string } }> } }
  };
  const mediaIds = mediaResult.product?.media?.edges?.map(e => e.node.id) || [];
  if (mediaIds.length === 0) return;

  // Delete all existing media
  const deleteMutation = `
    mutation productDeleteMedia($productId: ID!, $mediaIds: [ID!]!) {
      productDeleteMedia(productId: $productId, mediaIds: $mediaIds) {
        deletedMediaIds
        mediaUserErrors { field message }
      }
    }`;
  await shopifyGraphQL(channel, deleteMutation, { productId, mediaIds });
}

// ── SKU → Shopify ID lookup via GraphQL ────────────────────────────────────
async function getShopifyProductMap(channel: Channel): Promise<Map<string, { productId: string; variantId: string; inventoryItemId: string; price?: string; inventoryQuantity?: number }>> {
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
                  price
                  inventoryQuantity
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
            variants: { edges: Array<{ node: { id: string; sku: string; barcode: string; price: string; inventoryQuantity: number; inventoryItem: { id: string } } }> };
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
          price: v.price,
          inventoryQuantity: v.inventoryQuantity,
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

// Fast lookup for small number of SKUs — avoids loading entire 25K catalog
async function getShopifyProductMapForSKUs(
  channel: Channel,
  skus: string[]
): Promise<Map<string, { productId: string; variantId: string; inventoryItemId: string; price?: string; inventoryQuantity?: number }>> {
  const map = new Map<string, { productId: string; variantId: string; inventoryItemId: string; price?: string; inventoryQuantity?: number }>();

  // Query up to 10 SKUs at a time using search
  for (let i = 0; i < skus.length; i += 10) {
    const batch = skus.slice(i, i + 10);
    const searchQuery = batch.map(sku => `sku:\"${sku.replace(/"/g, '\\\"')}\"`).join(' OR ');
    const gqlQuery = `
      query findProducts($query: String!) {
        products(first: 50, query: $query) {
          edges {
            node {
              id
              variants(first: 100) {
                edges {
                  node {
                    id
                    sku
                    barcode
                    price
                    inventoryQuantity
                    inventoryItem { id }
                  }
                }
              }
            }
          }
        }
      }`;
    const data = await shopifyGraphQL(channel, gqlQuery, { query: searchQuery }) as {
      products: {
        edges: Array<{
          node: {
            id: string;
            variants: { edges: Array<{ node: { id: string; sku: string; barcode: string; price: string; inventoryQuantity: number; inventoryItem: { id: string } } }> };
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
          price: v.price,
          inventoryQuantity: v.inventoryQuantity,
        };
        if (v.sku) map.set(v.sku, entry);
        if (v.barcode && !map.has(v.barcode)) map.set(v.barcode, entry);
      }
    }
  }

  console.log(`[SyncFlow] Fast SKU lookup: ${map.size} entries for ${skus.length} SKUs`);
  return map;
}

// ── Turbo Mode: parallel price/stock updates ──────────────────────────────
async function turboSync(
  channel: Channel,
  products: ProductRow[],
  mappings: AttributeMapping[],
  jobId: string,
  priceAdjustmentPercent = 0,
  priceRoundingMode: 'none' | 'up' | 'down' = 'none',
  warehouseName?: string
) {
  const shopifyMap = products.length <= 50
    ? await getShopifyProductMapForSKUs(channel, products.map(p => p.sku))
    : await getShopifyProductMap(channel);

  // Pre-resolve location once
  let locationId = channel.settings?.stock_location_id;
  if (!locationId) {
    const locQuery = `{ locations(first: 1) { edges { node { id } } } }`;
    const locData = await shopifyGraphQL(channel, locQuery) as { locations: { edges: Array<{ node: { id: string } }> } };
    locationId = locData.locations.edges[0]?.node?.id;
  }
  console.log(`[SyncFlow] Turbo: locationId=${locationId || 'NONE'}, products=${products.length}`);

  // Pre-compute metafield mappings
  const metafieldMappings = mappings.filter(m => m.target_field.startsWith('metafield:'));

  // Fetch Shopify metafield definitions for auto-type detection
  const shopifyDefs = metafieldMappings.length > 0 ? await getMetafieldDefinitions(channel) : new Map<string, string>();

  for (let i = 0; i < products.length; i += TURBO_BATCH_SIZE) {
    if (await isJobCancelled(jobId)) {
      console.log(`[SyncFlow] Job ${jobId} cancelled at product ${i}/${products.length}`);
      return;
    }

    const batch = products.slice(i, i + TURBO_BATCH_SIZE);
    const results = await Promise.all(batch.map(p => syncProductTurbo(channel, p, mappings, metafieldMappings, shopifyMap, jobId, locationId, 0, priceAdjustmentPercent, priceRoundingMode, warehouseName, shopifyDefs)));

    // Batch counter update (one DB call per batch instead of per product)
    const updated = results.filter(r => r === 'updated').length;
    const skipped = results.filter(r => r === 'skipped').length;
    const failed = results.filter(r => r === 'failed').length;
    await query(
      'UPDATE sync_jobs SET processed_count = $1, updated_count = updated_count + $2, skipped_count = skipped_count + $3, failed_count = failed_count + $4 WHERE id = $5',
      [Math.min(i + TURBO_BATCH_SIZE, products.length), updated, skipped, failed, jobId]
    );
  }
}

async function syncProductTurbo(
  channel: Channel,
  product: ProductRow,
  mappings: AttributeMapping[],
  metafieldMappings: AttributeMapping[],
  shopifyMap: Map<string, { productId: string; variantId: string; inventoryItemId: string; price?: string; inventoryQuantity?: number }>,
  jobId: string,
  locationId?: string,
  retries = 0,
  priceAdjustmentPercent = 0,
  priceRoundingMode: 'none' | 'up' | 'down' = 'none',
  warehouseName?: string,
  shopifyDefs: Map<string, string> = new Map(),
  fullFields = false,
  withImages = false,
): Promise<'updated' | 'skipped' | 'failed'> {
  const shopifyIds = shopifyMap.get(product.sku);

  if (!shopifyIds) {
    await logSyncEntry(jobId, product.sku, 'skipped', 'SKU not found in Shopify — use Sync All to create it');
    return 'skipped';
  }

  try {
    const mapped = applyPriceAdjustment(applyMappings(product.raw_data, mappings), priceAdjustmentPercent, priceRoundingMode);

    // Detect changes — skip products where nothing changed
    const newPrice = mapped.price ? String(mapped.price) : null;
    const newCompareAtPrice = mapped.compare_at_price ? String(mapped.compare_at_price) : null;
    const stockQty = mapped.inventory_quantity !== undefined && mapped.inventory_quantity !== null
      ? parseInt(String(mapped.inventory_quantity))
      : NaN;
    const priceChanged = newPrice !== null && shopifyIds.price !== newPrice;
    const compareAtPriceChanged = newCompareAtPrice !== null;
    const stockChanged = !isNaN(stockQty) && shopifyIds.inventoryQuantity !== stockQty;
    const hasMetafields = metafieldMappings.length > 0;

    // For price_stock_meta (fullFields=false): skip if nothing changed
    if (!fullFields && !priceChanged && !compareAtPriceChanged && !stockChanged && !hasMetafields) {
      await logSyncEntry(jobId, product.sku, 'skipped', 'No changes detected');
      return 'skipped';
    }

    // Fire all mutations in PARALLEL
    const promises: Promise<unknown>[] = [];

    // 1. Product update (fields + metafields)
    {
      const productInput: Record<string, unknown> = { id: shopifyIds.productId };
      if (fullFields) {
        if (mapped.title) productInput.title = mapped.title;
        if (mapped.body_html) productInput.descriptionHtml = mapped.body_html;
        if (mapped.tags) productInput.tags = String(mapped.tags).split(',').map((t: string) => t.trim());
        if (mapped.vendor) productInput.vendor = mapped.vendor;
        if (mapped.product_type) productInput.productType = mapped.product_type;
        if (mapped.status) productInput.status = String(mapped.status).toUpperCase();
      }
      const metafields = hasMetafields ? buildMetafields(product.raw_data, metafieldMappings, shopifyDefs) : [];
      if (metafields.length > 0) productInput.metafields = metafields;
      if (Object.keys(productInput).length > 1) {
        const updateMutation = `
          mutation productUpdate($input: ProductInput!) {
            productUpdate(input: $input) {
              product { id }
              userErrors { field message }
            }
          }`;
        promises.push(shopifyGraphQL(channel, updateMutation, {
          input: productInput,
        }).then((r: unknown) => {
          const res = r as { productUpdate?: { userErrors?: Array<{ field: string; message: string }> } };
          const errs = res?.productUpdate?.userErrors;
          if (errs && errs.length > 0) {
            const details = errs.map((e, i) => {
              const mf = metafields[i] || metafields[0];
              return mf
                ? `[${mf.namespace}.${mf.key} (type=${mf.type}, value=${mf.value?.substring(0, 80)})]: ${e.message}`
                : e.message;
            }).join('; ');
            throw new Error(`Product update error: ${details}`);
          }
        }));
      }
    }

    // 2. Variant update (price + barcode + variant fields)
    {
      const doVariantUpdate = fullFields || priceChanged || compareAtPriceChanged;
      if (doVariantUpdate) {
        const variantInput: Record<string, unknown> = { id: shopifyIds.variantId };
        if (mapped.price) variantInput.price = String(mapped.price);
        if (mapped.compare_at_price) variantInput.compareAtPrice = String(mapped.compare_at_price);
        if (fullFields) {
          if (mapped.barcode) variantInput.barcode = String(mapped.barcode);
          if (mapped.variant_requires_shipping !== undefined) {
            variantInput.inventoryItem = { requiresShipping: isTruthyValue(mapped.variant_requires_shipping) };
          }
          if (mapped.variant_inventory_policy) {
            variantInput.inventoryPolicy = String(mapped.variant_inventory_policy).toUpperCase();
          }
        }
        const variantMutation = `
          mutation variantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
            productVariantsBulkUpdate(productId: $productId, variants: $variants) {
              productVariants { id }
              userErrors { field message }
            }
          }`;
        promises.push(shopifyGraphQL(channel, variantMutation, {
          productId: shopifyIds.productId,
          variants: [variantInput],
        }).then((r: unknown) => {
          const res = r as { productVariantsBulkUpdate?: { userErrors?: Array<{ field: string; message: string }> } };
          const priceErrors = res?.productVariantsBulkUpdate?.userErrors;
          if (priceErrors && priceErrors.length > 0) {
            console.error(`[SyncFlow] Variant update failed for ${product.sku}: ${JSON.stringify(priceErrors)}`);
          }
        }));
      }
    }

    // 3. Inventory item details (tracking + weight)
    promises.push(updateInventoryItemDetails(channel, shopifyIds.inventoryItemId, mapped));

    // 4. Stock update
    if ((fullFields ? !isNaN(stockQty) : stockChanged) && locationId) {
      const stockQuery = `
        mutation inventorySetQuantities($input: InventorySetQuantitiesInput!) {
          inventorySetQuantities(input: $input) {
            inventoryAdjustmentGroup { reason }
            userErrors { field message }
          }
        }`;
      promises.push(shopifyGraphQL(channel, stockQuery, {
        input: {
          name: "available",
          reason: "correction",
          ignoreCompareQuantity: true,
          quantities: [{
            inventoryItemId: shopifyIds.inventoryItemId,
            locationId,
            quantity: stockQty,
          }],
        },
      }).then((r: unknown) => {
        const res = r as { inventorySetQuantities?: { userErrors?: Array<{ field: string; message: string }> } };
        const stockErrors = res?.inventorySetQuantities?.userErrors;
        if (stockErrors && stockErrors.length > 0) {
          console.error(`[SyncFlow] Stock update failed for ${product.sku}: ${JSON.stringify(stockErrors)}`);
        }
      }));
    } else if (!locationId && !isNaN(stockQty)) {
      console.warn(`[SyncFlow] No locationId for stock update of ${product.sku}`);
    }

    // 5. Image sync (when withImages=true) — delete old, upload new in parallel with other mutations
    if (withImages) {
      const imageSource = mapped.variant_image || mapped.image_url;
      if (imageSource) {
        const urls = String(imageSource).split(',').map(u => u.trim()).filter(isValidImageUrl).map(toDirectImageUrl);
        if (urls.length > 0) {
          promises.push(
            deleteExistingProductMedia(channel, shopifyIds.productId).then(() =>
              shopifyGraphQL(channel, `
                mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
                  productCreateMedia(productId: $productId, media: $media) {
                    media { id }
                    mediaUserErrors { field message }
                  }
                }`, {
                productId: shopifyIds.productId,
                media: urls.map(url => ({ originalSource: url, mediaContentType: 'IMAGE' })),
              })
            )
          );
        }
      }
    }

    // 6. Published status
    if (fullFields && mapped.published !== undefined) {
      promises.push(setProductPublicationStatus(channel, shopifyIds.productId, mapped.published));
    }

    await Promise.all(promises);

    const rawQty = product.raw_data.qty_available;
    const rawPrice = product.raw_data.list_price;
    const loggedStockTo = !isNaN(stockQty) ? stockQty : (rawQty != null ? Number(rawQty) : null);
    const loggedPriceTo = mapped.price != null ? String(mapped.price) : (rawPrice != null ? String(rawPrice) : null);
    const loggedStockFrom = shopifyIds.inventoryQuantity != null ? shopifyIds.inventoryQuantity : null;
    const loggedPriceFrom = shopifyIds.price != null && shopifyIds.price !== '' ? shopifyIds.price : null;

    const logDetails: SyncLogDetails = {
      stock_from: loggedStockFrom,
      stock_to: loggedStockTo,
      price_from: loggedPriceFrom,
      price_to: loggedPriceTo,
      warehouse_name: warehouseName ?? null,
    };
    await logSyncEntry(jobId, product.sku, 'updated', fullFields ? 'Ultra sync succeeded' : 'Turbo sync succeeded', logDetails);
    return 'updated';
  } catch (err: unknown) {
    const errMsg = String(err);
    if (errMsg.includes('Throttled') && retries < MAX_RETRIES) {
      await sleep(RETRY_DELAY_MS * (retries + 1));
      return syncProductTurbo(channel, product, mappings, metafieldMappings, shopifyMap, jobId, locationId, retries + 1, priceAdjustmentPercent, priceRoundingMode, warehouseName, shopifyDefs, fullFields, withImages);
    }
    await logSyncEntry(jobId, product.sku, 'failed', errMsg);
    return 'failed';
  }
}

// ── Ultra Sync: three-phase approach for maximum speed ────────────────────
async function ultraSync(
  channel: Channel,
  products: ProductRow[],
  mappings: AttributeMapping[],
  jobId: string,
  withImages: boolean,
  priceAdjustmentPercent = 0,
  priceRoundingMode: 'none' | 'up' | 'down' = 'none',
  warehouseName?: string
) {
  // Load Shopify product map
  const shopifyMap = products.length <= 50
    ? await getShopifyProductMapForSKUs(channel, products.map(p => p.sku))
    : await getShopifyProductMap(channel);

  // Pre-resolve location once
  let locationId = channel.settings?.stock_location_id;
  if (!locationId) {
    const locQuery = `{ locations(first: 1) { edges { node { id } } } }`;
    const locData = await shopifyGraphQL(channel, locQuery) as { locations: { edges: Array<{ node: { id: string } }> } };
    locationId = locData.locations.edges[0]?.node?.id;
  }

  // Pre-compute metafield mappings
  const metafieldMappings = mappings.filter(m => m.target_field.startsWith('metafield:'));
  const shopifyDefs = metafieldMappings.length > 0 ? await getMetafieldDefinitions(channel) : new Map<string, string>();

  // Group by handle, then categorize
  const groups = groupRowsByHandle(products, mappings);
  const existingSingles: ProductRow[] = [];
  const newSingles: ProductRow[] = [];
  const variantGroups: GroupedProduct[] = [];

  for (const group of groups) {
    if (group.rows.length > 1) {
      variantGroups.push(group);
    } else {
      if (shopifyMap.has(group.rows[0].sku)) {
        existingSingles.push(group.rows[0]);
      } else {
        newSingles.push(group.rows[0]);
      }
    }
  }

  const totalVariantRows = variantGroups.reduce((sum, g) => sum + g.rows.length, 0);
  console.log(`[SyncFlow] Ultra split: ${existingSingles.length} existing → turbo, ${newSingles.length} new → create, ${variantGroups.length} variant groups (${totalVariantRows} rows)`);

  let processedCount = 0;
  const batchSize = withImages ? IMAGE_TURBO_BATCH_SIZE : TURBO_BATCH_SIZE;

  // ── PHASE 1: Turbo-update existing products (FAST — all fields in parallel) ──
  if (existingSingles.length > 0) {
    console.log(`[SyncFlow] Phase 1: Ultra-updating ${existingSingles.length} existing products (batch ${batchSize})`);
    for (let i = 0; i < existingSingles.length; i += batchSize) {
      if (await isJobCancelled(jobId)) return;
      const batch = existingSingles.slice(i, i + batchSize);
      const results = await Promise.all(
        batch.map(p => syncProductTurbo(
          channel, p, mappings, metafieldMappings, shopifyMap, jobId, locationId,
          0, priceAdjustmentPercent, priceRoundingMode, warehouseName, shopifyDefs,
          true, withImages
        ))
      );
      const updated = results.filter(r => r === 'updated').length;
      const skipped = results.filter(r => r === 'skipped').length;
      const failed = results.filter(r => r === 'failed').length;
      processedCount += batch.length;
      await query(
        'UPDATE sync_jobs SET processed_count = $1, updated_count = updated_count + $2, skipped_count = skipped_count + $3, failed_count = failed_count + $4 WHERE id = $5',
        [processedCount, updated, skipped, failed, jobId]
      );
    }
  }

  // ── PHASE 2: Create new products (parallel batch) ────────────────────────
  if (newSingles.length > 0) {
    console.log(`[SyncFlow] Phase 2: Creating ${newSingles.length} new products (batch ${CREATE_PARALLEL_SIZE})`);
    for (let i = 0; i < newSingles.length; i += CREATE_PARALLEL_SIZE) {
      if (await isJobCancelled(jobId)) return;
      const batch = newSingles.slice(i, i + CREATE_PARALLEL_SIZE);
      let created = 0, failed = 0;
      await Promise.all(batch.map(async (product) => {
        try {
          const mapped = applyPriceAdjustment(applyMappings(product.raw_data, mappings), priceAdjustmentPercent, priceRoundingMode);
          await createShopifyProduct(channel, product.sku, mapped, withImages, mappings, product.raw_data, shopifyDefs);
          await logSyncEntry(jobId, product.sku, 'created', 'New product created');
          created++;
        } catch (err) {
          await logSyncEntry(jobId, product.sku, 'failed', String(err));
          failed++;
        }
      }));
      processedCount += batch.length;
      await query(
        'UPDATE sync_jobs SET processed_count = $1, created_count = created_count + $2, failed_count = failed_count + $3 WHERE id = $4',
        [processedCount, created, failed, jobId]
      );
    }
  }

  // ── PHASE 3: Variant groups (parallel productSet) ────────────────────────
  if (variantGroups.length > 0) {
    console.log(`[SyncFlow] Phase 3: Processing ${variantGroups.length} variant groups (batch ${VARIANT_PARALLEL_SIZE})`);
    for (let i = 0; i < variantGroups.length; i += VARIANT_PARALLEL_SIZE) {
      if (await isJobCancelled(jobId)) return;
      const batch = variantGroups.slice(i, i + VARIANT_PARALLEL_SIZE);
      let updated = 0, created = 0, failed = 0;
      await Promise.all(batch.map(async (group) => {
        try {
          validateVariantSKUs(group.rows);
          await syncVariantGroup(channel, group, mappings, metafieldMappings, withImages, shopifyMap, locationId, priceAdjustmentPercent, priceRoundingMode, shopifyDefs);
          await logSyncEntry(jobId, group.rows[0].sku, 'updated', `Variant group synced (${group.rows.length} variants)`);
          updated += group.rows.length;
        } catch (err) {
          for (const row of group.rows) {
            await logSyncEntry(jobId, row.sku, 'failed', String(err));
          }
          failed += group.rows.length;
        }
      }));
      processedCount += batch.reduce((sum, g) => sum + g.rows.length, 0);
      await query(
        'UPDATE sync_jobs SET processed_count = $1, updated_count = updated_count + $2, created_count = created_count + $3, failed_count = failed_count + $4 WHERE id = $5',
        [processedCount, updated, created, failed, jobId]
      );
    }
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
  const shopifyMap = products.length <= 50
    ? await getShopifyProductMapForSKUs(channel, products.map(p => p.sku))
    : await getShopifyProductMap(channel);

  // Pre-resolve location once
  let locationId = channel.settings?.stock_location_id;
  if (!locationId) {
    const locQuery = `{ locations(first: 1) { edges { node { id } } } }`;
    const locData = await shopifyGraphQL(channel, locQuery) as { locations: { edges: Array<{ node: { id: string } }> } };
    locationId = locData.locations.edges[0]?.node?.id;
  }

  // Pre-compute metafield mappings once
  const metafieldMappings = mappings.filter(m => m.target_field.startsWith('metafield:'));

  // Fetch Shopify metafield definitions for auto-type detection
  const shopifyDefs = metafieldMappings.length > 0 ? await getMetafieldDefinitions(channel) : new Map<string, string>();

  const groupedProducts = groupRowsByHandle(products, mappings);

  let processed = 0;

  // Process in parallel batches
  for (let i = 0; i < groupedProducts.length; i += 20) {
    if (await isJobCancelled(jobId)) {
      console.log(`[SyncFlow] Job ${jobId} cancelled at product group ${i}/${groupedProducts.length}`);
      return;
    }

    const batch = groupedProducts.slice(i, i + 20);
    const results = await Promise.all(batch.map(group => syncGroupedProduct(channel, group, mappings, metafieldMappings, jobId, withImages, shopifyMap, locationId, priceAdjustmentPercent, priceRoundingMode, shopifyDefs)));

    // Batch counter update
    let updated = 0, created = 0, failed = 0;
    for (const r of results) { updated += r.updated; created += r.created; failed += r.failed; }
    processed += batch.reduce((sum, group) => sum + group.rows.length, 0);
    await query(
      'UPDATE sync_jobs SET processed_count = $1, updated_count = updated_count + $2, created_count = created_count + $3, failed_count = failed_count + $4 WHERE id = $5',
      [processed, updated, created, failed, jobId]
    );
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
  shopifyDefs: Map<string, string> = new Map(),
): Promise<{ updated: number; created: number; failed: number }> {
  const counts = { updated: 0, created: 0, failed: 0 };
  const firstRow = group.rows[0];

  if (group.rows.length > 1) {
    // Multiple rows share the same handle → variant group
    try {
      validateVariantSKUs(group.rows);
      await syncVariantGroup(channel, group, mappings, metafieldMappings, withImages, shopifyMap, locationId, priceAdjustmentPercent, priceRoundingMode, shopifyDefs);
      await logSyncEntry(jobId, firstRow.sku, 'updated', `Variant group synced (${group.rows.length} rows, handle: ${group.handle})`);
      counts.updated = group.rows.length;
    } catch (err) {
      const message = String(err);
      for (const row of group.rows) {
        await logSyncEntry(jobId, row.sku, 'failed', message);
      }
      counts.failed = group.rows.length;
    }
    return counts;
  }

  await Promise.all(group.rows.map(async (product) => {
    const shopifyIds = shopifyMap.get(product.sku);
    const mapped = applyPriceAdjustment(applyMappings(product.raw_data, mappings), priceAdjustmentPercent, priceRoundingMode);

    try {
      if (!shopifyIds) {
        await createShopifyProduct(channel, product.sku, mapped, withImages, mappings, product.raw_data, shopifyDefs);
        await logSyncEntry(jobId, product.sku, 'created', 'New product created in Shopify');
        counts.created++;
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
        if (mapped.product_type) input.productType = mapped.product_type;
        if (mapped.status) input.status = String(mapped.status).toUpperCase();

        if (metafieldMappings.length > 0) {
          const metafields = buildMetafields(product.raw_data, metafieldMappings, shopifyDefs);
          if (metafields.length > 0) {
            input.metafields = metafields;
          }
        }

        if (Object.keys(input).length > 1) {
          updatePromises.push(shopifyGraphQL(channel, updateMutation, { input }).then((r: unknown) => {
            const res = r as { productUpdate?: { userErrors?: Array<{ field: string; message: string }> } };
            const errs = res?.productUpdate?.userErrors;
            if (errs && errs.length > 0) {
              const mfs = (input.metafields as Array<{namespace: string; key: string; type: string; value: string}>) || [];
              const details = errs.map((e, i) => {
                const mf = mfs[i] || mfs[0];
                const ctx = mf ? ` [${mf.namespace}.${mf.key} type=${mf.type} value=${mf.value?.substring(0, 80)}]` : '';
                return `${e.message}${ctx}`;
              }).join('; ');
              throw new Error(`Metafield error: ${details}`);
            }
          }));
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
          if (mapped.barcode) variantInput.barcode = String(mapped.barcode);
          if (mapped.variant_requires_shipping !== undefined) {
            variantInput.inventoryItem = { ...(variantInput.inventoryItem as Record<string, unknown> ?? {}), requiresShipping: isTruthyValue(mapped.variant_requires_shipping) };
          }
          if (mapped.variant_inventory_policy) {
            variantInput.inventoryPolicy = String(mapped.variant_inventory_policy).toUpperCase();
          }
          if (mapped.variant_fulfillment_service && String(mapped.variant_fulfillment_service).startsWith('gid://shopify/FulfillmentService/')) {
            variantInput.fulfillmentServiceId = String(mapped.variant_fulfillment_service);
          }
          updatePromises.push(shopifyGraphQL(channel, variantMutation, {
            productId: shopifyIds.productId,
            variants: [variantInput],
          }));
        }

        if (mapped.published !== undefined) {
          updatePromises.push(setProductPublicationStatus(channel, shopifyIds.productId, mapped.published));
        }

        updatePromises.push(updateInventoryItemDetails(channel, shopifyIds.inventoryItemId, mapped));

        const indivStockQty = mapped.inventory_quantity !== undefined && mapped.inventory_quantity !== null
          ? parseInt(String(mapped.inventory_quantity))
          : NaN;
        if (!isNaN(indivStockQty) && locationId) {
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
              ignoreCompareQuantity: true,
              quantities: [{
                inventoryItemId: shopifyIds.inventoryItemId,
                locationId,
                quantity: indivStockQty,
              }],
            },
          }).then((r: unknown) => {
            const res = r as { inventorySetQuantities?: { userErrors?: Array<{ field: string; message: string }> } };
            if (res?.inventorySetQuantities?.userErrors?.length) {
              console.error(`[SyncFlow] Stock update failed for ${product.sku}: ${JSON.stringify(res.inventorySetQuantities.userErrors)}`);
            }
          }));
        }

        const updateImageSource = mapped.variant_image || mapped.image_url;
        if (withImages && updateImageSource) {
          const urls = String(updateImageSource).split(',').map(u => u.trim()).filter(isValidImageUrl).map(toDirectImageUrl);
          if (urls.length > 0) {
            // Delete existing images first, then upload new ones
            await deleteExistingProductMedia(channel, shopifyIds.productId);
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
        counts.updated++;
      }
    } catch (err) {
      await logSyncEntry(jobId, product.sku, 'failed', String(err));
      counts.failed++;
    }
  }));

  return counts;
}

async function createShopifyProduct(channel: Channel, sku: string, mapped: Record<string, unknown>, withImages: boolean, mappings?: AttributeMapping[], rawData?: Record<string, unknown>, shopifyDefs: Map<string, string> = new Map()) {
  // Note: duplicate check removed — callers verify against shopifyMap before calling

  const createMutation = `
    mutation productCreate($product: ProductCreateInput!, $media: [CreateMediaInput!]) {
      productCreate(product: $product, media: $media) {
        product { id variants(first: 1) { edges { node { id inventoryItem { id } } } } }
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

  if (mapped.handle) product.handle = String(mapped.handle).trim();
  if (mapped.product_type) product.productType = mapped.product_type;

  // Add metafields to create input
  if (mappings && rawData) {
    const metafieldMappings = mappings.filter(m => m.target_field.startsWith('metafield:'));
    const metafields = buildMetafields(rawData as Record<string, string | number | null>, metafieldMappings, shopifyDefs);
    if (metafields.length > 0) {
      product.metafields = metafields;
    }
  }

  // Media (images) — handles comma-separated URLs
  const media: Array<{ originalSource: string; mediaContentType: string }> = [];
  const createImageSource = mapped.variant_image || mapped.image_url;
  if (withImages && createImageSource) {
    const urls = String(createImageSource).split(',').map(u => u.trim()).filter(isValidImageUrl).map(toDirectImageUrl);
    for (const url of urls) {
      media.push({ originalSource: url, mediaContentType: 'IMAGE' });
    }
  }

  const result = await shopifyGraphQL(channel, createMutation, {
    product,
    media: media.length > 0 ? media : undefined,
  }) as { productCreate: { product: { id: string; variants: { edges: Array<{ node: { id: string; inventoryItem?: { id: string } } }> } }; userErrors: Array<{ field: string; message: string }> } };

  if (result.productCreate.userErrors?.length > 0) {
    const metafields = (product as Record<string, unknown>).metafields as Array<{namespace: string; key: string; type: string; value: string}> | undefined;
    const details = result.productCreate.userErrors.map((e: { field: string; message: string }, i: number) => {
      const fieldStr = e.field || '';
      if (metafields && fieldStr.includes('metafield')) {
        const mf = metafields[i] || metafields[0];
        return `[${mf?.namespace}.${mf?.key} type=${mf?.type} value=${mf?.value?.substring(0, 80)}]: ${e.message}`;
      }
      return `[${fieldStr}]: ${e.message}`;
    }).join('; ');
    throw new Error(`Create failed: ${details}`);
  }

  const productId = result.productCreate.product?.id;
  const variantId = result.productCreate.product?.variants?.edges?.[0]?.node?.id;
  let inventoryItemId = result.productCreate.product?.variants?.edges?.[0]?.node?.inventoryItem?.id || null;

  // Update default variant with SKU + price
  if (variantId && productId) {
    const variantMutation = `
      mutation variantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          productVariants { id sku }
          userErrors { field message }
        }
      }`;
    const variantInput: Record<string, unknown> = {
      id: variantId,
      price: mapped.price ? String(mapped.price) : '0.00',
      compareAtPrice: mapped.compare_at_price ? String(mapped.compare_at_price) : null,
      inventoryItem: { sku },
    };
    if (mapped.barcode) variantInput.barcode = String(mapped.barcode);
    if (mapped.variant_requires_shipping !== undefined) {
      (variantInput.inventoryItem as Record<string, unknown>).requiresShipping = isTruthyValue(mapped.variant_requires_shipping);
    }
    if (mapped.variant_inventory_policy) {
      variantInput.inventoryPolicy = String(mapped.variant_inventory_policy).toUpperCase();
    }
    if (mapped.variant_fulfillment_service && String(mapped.variant_fulfillment_service).startsWith('gid://shopify/FulfillmentService/')) {
      variantInput.fulfillmentServiceId = String(mapped.variant_fulfillment_service);
    }
    await shopifyGraphQL(channel, variantMutation, {
      productId,
      variants: [variantInput],
    });

    if (!inventoryItemId) {
      inventoryItemId = await getVariantInventoryItemId(channel, variantId);
    }
    if (inventoryItemId) {
      await updateInventoryItemDetails(channel, inventoryItemId, mapped);
    }
  }

  // Publish product to all sales channels
  if (productId) {
    if (mapped.published !== undefined) {
      await setProductPublicationStatus(channel, productId, mapped.published);
    } else {
      await publishToSalesChannels(channel, productId);
    }
  }
}
// ── Publish product to all sales channels ──────────────────────────────────
async function publishToSalesChannels(channel: Channel, productId: string) {
  try {
    const publicationIds = await getCachedPublicationIds(channel);

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

async function setProductPublicationStatus(channel: Channel, productId: string, published: unknown) {
  try {
    const publicationIds = await getCachedPublicationIds(channel);

    if (publicationIds.length === 0) {
      return;
    }

    if (isTruthyValue(published)) {
      const publishMutation = `
        mutation publishablePublish($id: ID!, $input: [PublicationInput!]!) {
          publishablePublish(id: $id, input: $input) {
            userErrors { field message }
          }
        }`;
      await shopifyGraphQL(channel, publishMutation, {
        id: productId,
        input: publicationIds.map(publicationId => ({ publicationId })),
      });
      return;
    }

    const unpublishMutation = `
      mutation publishableUnpublish($id: ID!, $input: [PublicationInput!]!) {
        publishableUnpublish(id: $id, input: $input) {
          userErrors { field message }
        }
      }`;
    await shopifyGraphQL(channel, unpublishMutation, {
      id: productId,
      input: publicationIds.map(publicationId => ({ publicationId })),
    });
  } catch (pubErr) {
    console.warn(`[Sync] Could not update publication status for ${productId}:`, pubErr);
  }
}

// ── Metafield Value Formatter ───────────────────────────────────────────────
function formatMetafieldValue(rawValue: unknown, type: string): string {
  const str = String(rawValue);
  if (type.startsWith('list.')) {
    if (str.startsWith('[')) return str;
    // Split on commas OR newlines (feeds often use newlines as separators)
    const items = str.split(/[,\n]+/).map(s => s.trim()).filter(Boolean);
    const innerType = type.replace('list.', '');
    if (innerType === 'number_integer' || innerType === 'number_decimal')
      return JSON.stringify(items.map(Number));
    return JSON.stringify(items);
  }
  // JSON-structured types — pass through if already JSON, otherwise wrap
  if (type === 'weight' || type === 'volume' || type === 'dimension') {
    if (str.startsWith('{')) return str;
    // Expect "value unit" format e.g. "5.0 kg" or just a number
    const parts = str.split(/\s+/);
    const value = parseFloat(parts[0]) || 0;
    const unit = parts[1] || (type === 'weight' ? 'kg' : type === 'volume' ? 'ml' : 'mm');
    return JSON.stringify({ value, unit });
  }
  if (type === 'rating') {
    if (str.startsWith('{')) return str;
    return JSON.stringify({ value: str, scale_min: '0', scale_max: '5' });
  }
  if (type === 'money') {
    if (str.startsWith('{')) return str;
    return JSON.stringify({ amount: str, currency_code: 'USD' });
  }
  if (type === 'color') {
    // Ensure it's a valid hex color format
    if (str.startsWith('#')) return str;
    return `#${str}`;
  }
  if (type === 'boolean') {
    const lower = str.toLowerCase();
    return (lower === 'true' || lower === '1' || lower === 'yes') ? 'true' : 'false';
  }
  // single_line_text_field must not contain newlines
  if (type === 'single_line_text_field') {
    return str.replace(/[\r\n]+/g, ' ').trim();
  }
  return str;
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
    // Use the EXACT handle from feed if mapped, otherwise each product is its own group by SKU
    // NEVER group by title — different products with similar titles get merged incorrectly
    const rawHandle = mapped.handle ? String(mapped.handle).trim() : '';
    const handle = rawHandle || ('sku-' + product.sku);

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
  shopifyDefs: Map<string, string> = new Map(),
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
      const urls = String(entry.mapped.image_url || '').split(',').map(url => url.trim()).filter(isValidImageUrl).map(toDirectImageUrl);
      for (const url of urls) {
        if (!fileMap.has(url)) fileMap.set(url, { originalSource: url, contentType: 'IMAGE' });
      }
    }
  }

  const metafields = buildMetafields(first.row.raw_data, metafieldMappings, shopifyDefs);

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
      if (entry.mapped.taxable !== undefined) variant.taxable = isTruthyValue(entry.mapped.taxable);
      if (entry.mapped.variant_requires_shipping !== undefined) {
        variant.inventoryItem = { ...(variant.inventoryItem as Record<string, unknown> ?? {}), requiresShipping: isTruthyValue(entry.mapped.variant_requires_shipping) };
      }
      if (entry.mapped.variant_inventory_policy) {
        variant.inventoryPolicy = String(entry.mapped.variant_inventory_policy).toUpperCase();
      }
      if (entry.mapped.variant_fulfillment_service && String(entry.mapped.variant_fulfillment_service).startsWith('gid://shopify/FulfillmentService/')) {
        variant.fulfillmentServiceId = String(entry.mapped.variant_fulfillment_service);
      }

      // Inventory tracking + quantity
      const hasInventory = entry.mapped.inventory_quantity !== undefined;
      if (hasInventory && locationId) {
        variant.inventoryQuantities = [{
          locationId,
          name: 'available',
          quantity: parseInt(String(entry.mapped.inventory_quantity)),
        }];
      }

      const variantImageSource = entry.mapped.variant_image || entry.mapped.image_url;
      const variantImage = withImages ? String(variantImageSource || '').split(',').map(url => url.trim()).filter(isValidImageUrl).map(toDirectImageUrl).find(Boolean) : null;
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

  // Delete existing images before uploading new ones (only for existing products with images)
  if (existingProductId && withImages && fileMap.size > 0) {
    await deleteExistingProductMedia(channel, existingProductId);
  }

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
    const details = result.productSet.userErrors.map(err => {
      const fieldPath = Array.isArray(err.field) ? err.field.join('.') : (err.field || '');
      // Try to match field to metafield for better context
      if (fieldPath.includes('metafield') && metafields.length > 0) {
        const mfSummary = metafields.map(mf => `${mf.namespace}.${mf.key}(type=${mf.type},val=${mf.value?.substring(0, 60)})`).join(', ');
        return `${err.message} [metafields: ${mfSummary}]`;
      }
      return `${err.message}${fieldPath ? ` [field: ${fieldPath}]` : ''}`;
    }).join('; ');
    throw new Error(details);
  }

  const syncedProductId = result.productSet.product?.id || existingProductId;
  if (syncedProductId) {
    const inventoryMap = await getProductVariantInventoryMap(channel, syncedProductId);
    for (const entry of mappedRows) {
      const inventoryItemId = inventoryMap.get(entry.row.sku);
      if (inventoryItemId) {
        await updateInventoryItemDetails(channel, inventoryItemId, entry.mapped);
      }
    }
  }

  // Publish product to all sales channels
  const createdProductId = result.productSet.product?.id;
  if (createdProductId) {
    if (first.mapped.published !== undefined) {
      await setProductPublicationStatus(channel, createdProductId, first.mapped.published);
    } else {
      await publishToSalesChannels(channel, createdProductId);
    }
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
async function logSyncEntry(jobId: string, sku: string, action: string, message: string, _details?: SyncLogDetails) {
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

// ── Bulk Sync: Shopify Bulk Operations API (server-side, no rate limits) ──
const BULK_POLL_INTERVAL_MS = 5000;
const BULK_MAX_POLL_TIME_MS = 30 * 60 * 1000; // 30-minute max wait
const BULK_SYNC_THRESHOLD = 200; // Use bulk ops when product count exceeds this

interface BulkOpResult {
  id: string;
  status: string;
  errorCode?: string | null;
  objectCount?: string;
  url?: string | null;
}

async function stagedUploadCreate(channel: Channel): Promise<{
  url: string;
  parameters: Array<{ name: string; value: string }>;
}> {
  const mutation = `
    mutation {
      stagedUploadsCreate(input: [{
        resource: BULK_MUTATION_VARIABLES,
        filename: "bulk_op_vars",
        mimeType: "text/jsonl",
        httpMethod: POST
      }]) {
        userErrors { field message }
        stagedTargets {
          url
          resourceUrl
          parameters { name value }
        }
      }
    }`;

  const result = await shopifyGraphQL(channel, mutation) as {
    stagedUploadsCreate: {
      userErrors: Array<{ field: string; message: string }>;
      stagedTargets: Array<{
        url: string;
        resourceUrl: string;
        parameters: Array<{ name: string; value: string }>;
      }>;
    };
  };

  if (result.stagedUploadsCreate.userErrors?.length > 0) {
    throw new Error(`Staged upload error: ${result.stagedUploadsCreate.userErrors.map(e => e.message).join('; ')}`);
  }

  const target = result.stagedUploadsCreate.stagedTargets[0];
  if (!target) throw new Error('No staged upload target returned');
  return target;
}

async function uploadJSONL(
  uploadTarget: { url: string; parameters: Array<{ name: string; value: string }> },
  jsonlContent: string
): Promise<void> {
  const form = new FormData();
  for (const param of uploadTarget.parameters) {
    form.append(param.name, param.value);
  }
  // file must be the last field per Shopify docs
  form.append('file', new Blob([jsonlContent], { type: 'text/jsonl' }), 'bulk_op_vars.jsonl');

  const res = await fetch(uploadTarget.url, {
    method: 'POST',
    body: form,
  });

  // GCS returns 201 (via success_action_status param); accept any 2xx
  if (res.status < 200 || res.status >= 300) {
    const text = await res.text().catch(() => '');
    throw new Error(`JSONL upload failed (${res.status}): ${text.substring(0, 500)}`);
  }
  console.log(`[SyncFlow] JSONL upload OK (${res.status})`);
}

async function launchBulkOperation(
  channel: Channel,
  mutationString: string,
  stagedUploadPath: string
): Promise<string> {
  const gql = `
    mutation bulkRun($mutation: String!, $stagedUploadPath: String!) {
      bulkOperationRunMutation(mutation: $mutation, stagedUploadPath: $stagedUploadPath) {
        bulkOperation { id status }
        userErrors { field message }
      }
    }`;

  const result = await shopifyGraphQL(channel, gql, {
    mutation: mutationString,
    stagedUploadPath,
  }) as {
    bulkOperationRunMutation: {
      bulkOperation?: { id: string; status: string };
      userErrors: Array<{ field: string; message: string }>;
    };
  };

  if (result.bulkOperationRunMutation.userErrors?.length > 0) {
    throw new Error(`Bulk operation error: ${result.bulkOperationRunMutation.userErrors.map(e => e.message).join('; ')}`);
  }

  const opId = result.bulkOperationRunMutation.bulkOperation?.id;
  if (!opId) throw new Error('No bulk operation ID returned');
  return opId;
}

async function pollBulkOperation(
  channel: Channel,
  operationId: string,
  label: string,
  jobId?: string
): Promise<BulkOpResult> {
  const startTime = Date.now();

  while (Date.now() - startTime < BULK_MAX_POLL_TIME_MS) {
    await sleep(BULK_POLL_INTERVAL_MS);

    if (jobId && await isJobCancelled(jobId)) {
      try {
        await shopifyGraphQL(channel,
          `mutation cancelBulk($id: ID!) { bulkOperationCancel(id: $id) { bulkOperation { status } userErrors { message } } }`,
          { id: operationId }
        );
      } catch { /* ignore cancel errors */ }
      throw new Error(`Job cancelled during bulk ${label}`);
    }

    const pollQuery = `
      query pollBulkOp($id: ID!) {
        node(id: $id) {
          ... on BulkOperation { id status errorCode objectCount url partialDataUrl }
        }
      }`;
    const result = await shopifyGraphQL(channel, pollQuery, { id: operationId }) as { node: BulkOpResult };
    const op = result.node;

    if (!op || !op.status) {
      console.warn(`[SyncFlow] Bulk ${label}: unexpected poll response, retrying...`);
      continue;
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    console.log(`[SyncFlow] Bulk ${label}: status=${op.status} objects=${op.objectCount || 0} (${elapsed}s)`);

    if (op.status === 'COMPLETED') return op;
    if (op.status === 'FAILED') throw new Error(`Bulk ${label} FAILED: ${op.errorCode || 'unknown'}`);
    if (op.status === 'CANCELLED') throw new Error(`Bulk ${label} was cancelled`);
  }

  throw new Error(`Bulk ${label} timed out after ${BULK_MAX_POLL_TIME_MS / 60000} min`);
}

async function executeBulkOperation(
  channel: Channel,
  mutationString: string,
  jsonlLines: string[],
  label: string,
  jobId?: string
): Promise<BulkOpResult> {
  if (jsonlLines.length === 0) {
    console.log(`[SyncFlow] Bulk ${label}: 0 items, skipping`);
    return { id: '', status: 'COMPLETED', objectCount: '0' };
  }

  const jsonlContent = jsonlLines.join('\n');
  const sizeKB = (jsonlContent.length / 1024).toFixed(1);
  console.log(`[SyncFlow] Bulk ${label}: uploading ${jsonlLines.length} items (${sizeKB} KB)`);

  const target = await stagedUploadCreate(channel);
  await uploadJSONL(target, jsonlContent);

  const keyParam = target.parameters.find(p => p.name === 'key');
  if (!keyParam) throw new Error(`No 'key' parameter in staged upload for ${label}`);

  const operationId = await launchBulkOperation(channel, mutationString, keyParam.value);
  console.log(`[SyncFlow] Bulk ${label}: launched ${operationId}`);

  return pollBulkOperation(channel, operationId, label, jobId);
}

async function batchLogSyncEntries(
  jobId: string,
  entries: Array<{ sku: string; action: string; message: string }>
) {
  if (entries.length === 0) return;
  for (let i = 0; i < entries.length; i += 500) {
    const batch = entries.slice(i, i + 500);
    const values: unknown[] = [];
    const placeholders: string[] = [];
    batch.forEach((entry, idx) => {
      const base = idx * 4;
      placeholders.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`);
      values.push(jobId, entry.sku, entry.action, entry.message);
    });
    await query(
      `INSERT INTO sync_logs (job_id, sku, action, message) VALUES ${placeholders.join(', ')}`,
      values
    );
  }
}

async function bulkSync(
  channel: Channel,
  products: ProductRow[],
  mappings: AttributeMapping[],
  jobId: string,
  fullFields: boolean,
  withImages: boolean,
  priceAdjustmentPercent = 0,
  priceRoundingMode: 'none' | 'up' | 'down' = 'none',
  warehouseName?: string
) {
  const startTime = Date.now();
  console.log(`[SyncFlow] ══ BULK SYNC ══ ${products.length} products | fullFields=${fullFields} | withImages=${withImages}`);

  // ── Preparation ──
  const shopifyMap = await getShopifyProductMap(channel);

  let locationId = channel.settings?.stock_location_id;
  if (!locationId) {
    const locData = await shopifyGraphQL(channel, `{ locations(first: 1) { edges { node { id } } } }`) as {
      locations: { edges: Array<{ node: { id: string } }> };
    };
    locationId = locData.locations.edges[0]?.node?.id;
  }

  const metafieldMappings = mappings.filter(m => m.target_field.startsWith('metafield:'));
  const shopifyDefs = metafieldMappings.length > 0
    ? await getMetafieldDefinitions(channel)
    : new Map<string, string>();

  // ── Categorize products ──
  const groups = groupRowsByHandle(products, mappings);
  const existingSingles: ProductRow[] = [];
  const newSingles: ProductRow[] = [];
  const variantGroups: GroupedProduct[] = [];

  for (const group of groups) {
    if (group.rows.length > 1) {
      variantGroups.push(group);
    } else {
      if (shopifyMap.has(group.rows[0].sku)) {
        existingSingles.push(group.rows[0]);
      } else {
        newSingles.push(group.rows[0]);
      }
    }
  }

  console.log(`[SyncFlow] Bulk split: ${existingSingles.length} existing | ${newSingles.length} new | ${variantGroups.length} variant groups`);

  // ── Generate JSONL: productSet combines product + variant + stock in ONE mutation ──
  const productSetLines: string[] = [];
  const inventoryItemLines: string[] = [];

  for (const product of existingSingles) {
    const ids = shopifyMap.get(product.sku)!;
    const mapped = applyPriceAdjustment(
      applyMappings(product.raw_data, mappings),
      priceAdjustmentPercent,
      priceRoundingMode
    );

    // Build productSet input (one call = product fields + variant + stock)
    const psInput: Record<string, unknown> = {
      id: ids.productId,
    };

    // Product-level fields
    if (fullFields) {
      if (mapped.title) psInput.title = mapped.title;
      if (mapped.body_html) psInput.descriptionHtml = mapped.body_html;
      if (mapped.tags) psInput.tags = String(mapped.tags).split(',').map((t: string) => t.trim());
      if (mapped.vendor) psInput.vendor = mapped.vendor;
      if (mapped.product_type) psInput.productType = mapped.product_type;
      if (mapped.status) psInput.status = String(mapped.status).toUpperCase();
    }

    // Metafields
    const metafields = metafieldMappings.length > 0
      ? buildMetafields(product.raw_data, metafieldMappings, shopifyDefs)
      : [];
    if (metafields.length > 0) psInput.metafields = metafields;

    // Variant (price + barcode + stock in one)
    const variant: Record<string, unknown> = {
      id: ids.variantId,
      sku: product.sku,
    };
    if (mapped.price) variant.price = String(mapped.price);
    if (mapped.compare_at_price) variant.compareAtPrice = String(mapped.compare_at_price);
    if (fullFields) {
      if (mapped.barcode) variant.barcode = String(mapped.barcode);
      if (mapped.variant_requires_shipping !== undefined) {
        variant.inventoryItem = { requiresShipping: isTruthyValue(mapped.variant_requires_shipping) };
      }
      if (mapped.variant_inventory_policy) {
        variant.inventoryPolicy = String(mapped.variant_inventory_policy).toUpperCase();
      }
    }

    // Stock quantity embedded in variant
    const stockQty = mapped.inventory_quantity != null
      ? parseInt(String(mapped.inventory_quantity))
      : NaN;
    if (!isNaN(stockQty) && locationId) {
      variant.inventoryQuantities = [{
        locationId,
        name: 'available',
        quantity: stockQty,
      }];
    }

    psInput.variants = [variant];
    productSetLines.push(JSON.stringify({ input: psInput, synchronous: false }));

    // Inventory item details (tracking + weight) — separate bulk op
    const invInput: Record<string, unknown> = {};
    if (mapped.inventory_quantity !== undefined) invInput.tracked = true;
    const weight = parseMappedWeight(mapped);
    if (weight) invInput.measurement = { weight };
    if (Object.keys(invInput).length > 0) {
      inventoryItemLines.push(JSON.stringify({ id: ids.inventoryItemId, input: invInput }));
    }
  }

  const genMs = Date.now() - startTime;
  console.log(
    `[SyncFlow] JSONL generated in ${genMs}ms: productSet=${productSetLines.length} invItem=${inventoryItemLines.length}`
  );

  if (await isJobCancelled(jobId)) return;

  // ── Run bulk operations SEQUENTIALLY (API 2024-10 allows only 1 at a time) ──
  let bulkSuccess = 0;
  let bulkFail = 0;

  // Bulk Op 1: productSet (product + variant + price + stock all in one)
  if (productSetLines.length > 0) {
    try {
      console.log(`[SyncFlow] Bulk Op 1/2: productSet (${productSetLines.length} products)...`);
      const r = await executeBulkOperation(
        channel,
        'mutation call($input: ProductSetInput!, $synchronous: Boolean!) { productSet(input: $input, synchronous: $synchronous) { product { id } userErrors { code field message } } }',
        productSetLines,
        'productSet',
        jobId
      );
      console.log(`[SyncFlow] ✓ productSet done: objects=${r.objectCount}`);
      bulkSuccess++;
    } catch (err) {
      console.error(`[SyncFlow] ✗ productSet failed:`, err);
      bulkFail++;
    }
  }

  if (await isJobCancelled(jobId)) return;

  // Bulk Op 2: inventoryItemUpdate (tracking + weight)
  if (inventoryItemLines.length > 0) {
    try {
      console.log(`[SyncFlow] Bulk Op 2/2: inventoryItem (${inventoryItemLines.length} items)...`);
      const r = await executeBulkOperation(
        channel,
        'mutation call($id: ID!, $input: InventoryItemInput!) { inventoryItemUpdate(id: $id, input: $input) { inventoryItem { id } userErrors { field message } } }',
        inventoryItemLines,
        'inventoryItem',
        jobId
      );
      console.log(`[SyncFlow] ✓ inventoryItem done: objects=${r.objectCount}`);
      bulkSuccess++;
    } catch (err) {
      console.error(`[SyncFlow] ✗ inventoryItem failed:`, err);
      bulkFail++;
    }
  }

  const bulkMs = Date.now() - startTime;
  const totalOps = (productSetLines.length > 0 ? 1 : 0) + (inventoryItemLines.length > 0 ? 1 : 0);
  console.log(`[SyncFlow] Bulk phase: ${bulkSuccess}/${totalOps} ops succeeded in ${(bulkMs / 1000).toFixed(1)}s`);

  // If ALL bulk ops failed, throw so caller falls back to turbo/ultra
  if (totalOps > 0 && bulkSuccess === 0) {
    throw new Error(`All ${totalOps} bulk operations failed`);
  }

  await query(
    'UPDATE sync_jobs SET processed_count = $1, updated_count = $2 WHERE id = $3',
    [existingSingles.length, existingSingles.length, jobId]
  );

  // Batch log all existing products
  await batchLogSyncEntries(jobId, existingSingles.map(p => ({
    sku: p.sku,
    action: 'updated',
    message: 'Bulk sync (productSet)',
  })));

  // ── Post-bulk: new products + variant groups (regular parallel API) ──
  let processedCount = existingSingles.length;

  if (newSingles.length > 0 && !await isJobCancelled(jobId)) {
    console.log(`[SyncFlow] Bulk post: creating ${newSingles.length} new products`);
    for (let i = 0; i < newSingles.length; i += CREATE_PARALLEL_SIZE) {
      if (await isJobCancelled(jobId)) return;
      const batch = newSingles.slice(i, i + CREATE_PARALLEL_SIZE);
      let created = 0, failed = 0;
      await Promise.all(batch.map(async (product) => {
        try {
          const mapped = applyPriceAdjustment(applyMappings(product.raw_data, mappings), priceAdjustmentPercent, priceRoundingMode);
          await createShopifyProduct(channel, product.sku, mapped, withImages, mappings, product.raw_data, shopifyDefs);
          await logSyncEntry(jobId, product.sku, 'created', 'New product created');
          created++;
        } catch (err) {
          await logSyncEntry(jobId, product.sku, 'failed', String(err));
          failed++;
        }
      }));
      processedCount += batch.length;
      await query(
        'UPDATE sync_jobs SET processed_count = $1, created_count = created_count + $2, failed_count = failed_count + $3 WHERE id = $4',
        [processedCount, created, failed, jobId]
      );
    }
  }

  if (variantGroups.length > 0 && !await isJobCancelled(jobId)) {
    console.log(`[SyncFlow] Bulk post: syncing ${variantGroups.length} variant groups`);
    for (let i = 0; i < variantGroups.length; i += VARIANT_PARALLEL_SIZE) {
      if (await isJobCancelled(jobId)) return;
      const batch = variantGroups.slice(i, i + VARIANT_PARALLEL_SIZE);
      let updated = 0, failed = 0;
      await Promise.all(batch.map(async (group) => {
        try {
          validateVariantSKUs(group.rows);
          await syncVariantGroup(channel, group, mappings, metafieldMappings, withImages, shopifyMap, locationId, priceAdjustmentPercent, priceRoundingMode, shopifyDefs);
          await logSyncEntry(jobId, group.rows[0].sku, 'updated', `Variant group synced (${group.rows.length} variants)`);
          updated += group.rows.length;
        } catch (err) {
          for (const row of group.rows) {
            await logSyncEntry(jobId, row.sku, 'failed', String(err));
          }
          failed += group.rows.length;
        }
      }));
      processedCount += batch.reduce((sum, g) => sum + g.rows.length, 0);
      await query(
        'UPDATE sync_jobs SET processed_count = $1, updated_count = updated_count + $2, failed_count = failed_count + $3 WHERE id = $4',
        [processedCount, updated, failed, jobId]
      );
    }
  }

  const totalSec = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[SyncFlow] ══ BULK SYNC DONE ══ ${totalSec}s | ${existingSingles.length} updated | ${newSingles.length} new | ${variantGroups.length} groups`);
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
    warehouseName,
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

    // Determine if images should be synced: sync_all always includes images, custom uses includeImages flag
    const withImages = preset === 'sync_all' || !!config.includeImages;

    console.log(`[SyncFlow] Job ${jobId} | Preset: ${preset} | Products: ${products.length} | Images: ${withImages}`);

    if (preset === 'price_stock_meta' || (config.fields && config.fields.every(f => ['price', 'stock', 'metafields'].includes(f)))) {
      // Always use turboSync — Shopify bulk ops silently drop metafield updates
      console.log(`[SyncFlow] Pathway: TURBO (${products.length} products, metafields need direct GraphQL)`);
      await turboSync(channel, products, mappings, jobId, priceAdjustmentPercent, priceRoundingMode, warehouseName);
    } else {
      if (products.length > BULK_SYNC_THRESHOLD) {
        console.log(`[SyncFlow] Pathway: BULK ULTRA (${products.length} products, ${preset})`);
        try {
          await bulkSync(channel, products, mappings, jobId, true, withImages, priceAdjustmentPercent, priceRoundingMode, warehouseName);
        } catch (bulkErr) {
          console.error('[SyncFlow] Bulk sync failed, falling back to ultra:', bulkErr);
          await ultraSync(channel, products, mappings, jobId, withImages, priceAdjustmentPercent, priceRoundingMode, warehouseName);
        }
      } else {
        console.log(`[SyncFlow] Pathway: ULTRA (${preset})`);
        await ultraSync(channel, products, mappings, jobId, withImages, priceAdjustmentPercent, priceRoundingMode, warehouseName);
      }
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
