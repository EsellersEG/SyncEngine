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
}

interface ProductRow {
  sku: string;
  raw_data: Record<string, string | number | null>;
  [key: string]: unknown;
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
            variants: { edges: Array<{ node: { id: string; sku: string; inventoryItem: { id: string } } }> };
          };
        }>;
      };
    };

    for (const productEdge of data.products.edges) {
      for (const variantEdge of productEdge.node.variants.edges) {
        const v = variantEdge.node;
        if (v.sku) {
          map.set(v.sku, {
            productId: productEdge.node.id,
            variantId: v.id,
            inventoryItemId: v.inventoryItem.id,
          });
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
async function turboSync(channel: Channel, products: ProductRow[], mappings: AttributeMapping[], jobId: string) {
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
    await Promise.all(batch.map(p => syncProductTurbo(channel, p, mappings, metafieldMappings, shopifyMap, jobId, locationId)));
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
  retries = 0
): Promise<void> {
  const shopifyIds = shopifyMap.get(product.sku);

  if (!shopifyIds) {
    await logSyncEntry(jobId, product.sku, 'skipped', 'SKU not found in Shopify — use Sync All to create it');
    await query('UPDATE sync_jobs SET skipped_count = skipped_count + 1 WHERE id = $1', [jobId]);
    return;
  }

  try {
    const mapped = applyMappings(product.raw_data, mappings);

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
      return syncProductTurbo(channel, product, mappings, metafieldMappings, shopifyMap, jobId, locationId, retries + 1);
    }
    await logSyncEntry(jobId, product.sku, 'failed', errMsg);
    await query('UPDATE sync_jobs SET failed_count = failed_count + 1 WHERE id = $1', [jobId]);
  }
}

// ── Individual Sync: create new + update all fields (PARALLEL) ────────────
async function individualSync(channel: Channel, products: ProductRow[], mappings: AttributeMapping[], jobId: string, withImages: boolean) {
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

  let processed = 0;

  // Process in parallel batches (6 products at a time)
  for (let i = 0; i < products.length; i += INDIVIDUAL_PARALLEL_SIZE) {
    if (await isJobCancelled(jobId)) {
      console.log(`[SyncFlow] Job ${jobId} cancelled at product ${i}/${products.length}`);
      return;
    }

    const batch = products.slice(i, i + INDIVIDUAL_PARALLEL_SIZE);
    await Promise.all(batch.map(async (product) => {
      const shopifyIds = shopifyMap.get(product.sku);
      const mapped = applyMappings(product.raw_data, mappings);

      try {
        if (!shopifyIds) {
          await createShopifyProduct(channel, product.sku, mapped, withImages, mappings, product.raw_data);
          await logSyncEntry(jobId, product.sku, 'created', 'New product created in Shopify');
          await query('UPDATE sync_jobs SET created_count = created_count + 1 WHERE id = $1', [jobId]);
        } else {
          // UPDATE existing product — run independent API calls in PARALLEL
          const updatePromises: Promise<unknown>[] = [];

          // 1. Product fields + metafields (single call)
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

          // Merge metafields into same update call
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

          // Only call productUpdate if there's something to update
          if (Object.keys(input).length > 1) {
            updatePromises.push(shopifyGraphQL(channel, updateMutation, { input }));
          }

          // 2. Variant price update (parallel)
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

          // 3. Stock update (parallel)
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

          // 4. Images (parallel, only if withImages and URL provided)
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

          // Execute all updates in parallel
          await Promise.all(updatePromises);

          await logSyncEntry(jobId, product.sku, 'updated', 'Full sync succeeded');
          await query('UPDATE sync_jobs SET updated_count = updated_count + 1 WHERE id = $1', [jobId]);
        }
      } catch (err) {
        await logSyncEntry(jobId, product.sku, 'failed', String(err));
        await query('UPDATE sync_jobs SET failed_count = failed_count + 1 WHERE id = $1', [jobId]);
      }
    }));

    processed = Math.min(i + INDIVIDUAL_PARALLEL_SIZE, products.length);
    await query('UPDATE sync_jobs SET processed_count = $1 WHERE id = $2', [processed, jobId]);
  }
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
    await shopifyGraphQL(channel, variantMutation, {
      productId,
      variants: [{
        id: variantId,
        price: mapped.price ? String(mapped.price) : '0.00',
        compareAtPrice: mapped.compare_at_price ? String(mapped.compare_at_price) : null,
        inventoryItem: { sku },
      }],
    });
  }

  // Publish product to all sales channels
  if (productId) {
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
  const { jobId, channel, feedId, preset, filterRules, skus } = config;

  try {
    await query("UPDATE sync_jobs SET status = 'running', started_at = NOW() WHERE id = $1", [jobId]);

    let products: ProductRow[];
    if (skus && skus.length > 0) {
      // Only fetch specific SKUs (auto-sync for changed products)
      const productsResult = await query(
        'SELECT sku, raw_data FROM products WHERE feed_id = $1 AND status = $2 AND sku = ANY($3)',
        [feedId, 'active', skus]
      );
      products = productsResult.rows;
    } else {
      const productsResult = await query(
        'SELECT sku, raw_data FROM products WHERE feed_id = $1 AND status = $2',
        [feedId, 'active']
      );
      products = productsResult.rows;
    }

    if (filterRules && filterRules.length > 0) {
      products = products.filter(p => evaluateFilterRules(p.raw_data, filterRules));
      console.log(`[SyncFlow] Filter rules applied: ${productsResult.rows.length} → ${products.length} products`);
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
      await turboSync(channel, products, mappings, jobId);
    } else if (products.length < 50) {
      console.log('[SyncFlow] Pathway: INDIVIDUAL');
      await individualSync(channel, products, mappings, jobId, preset !== 'sync_all_no_images');
    } else {
      console.log('[SyncFlow] Pathway: INDIVIDUAL (large batch, parallel)');
      await individualSync(channel, products, mappings, jobId, preset === 'sync_all');
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
