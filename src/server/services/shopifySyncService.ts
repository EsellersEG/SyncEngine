/**
 * Shopify Sync Engine — SyncFlow
 *
 * Three execution pathways:
 *  1. Turbo Mode        → parallelBatch GraphQL mutations (price/stock/meta)
 *  2. Bulk Operations   → Shopify Bulk API via JSONL upload (large catalogs)
 *  3. Individual Mutations → one-by-one for small syncs or specific fields
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

const BATCH_SIZE = 4; // Conservative parallel batch size for GraphQL cost budget
const MAX_RETRIES = 8;
const RETRY_DELAY_MS = 2000;
const REST_CALL_DELAY_MS = 550; // Stay under 2 req/sec REST limit

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

// ── SKU → Shopify ID lookup via GraphQL (much better rate limits) ─────────
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

  for (let i = 0; i < products.length; i += BATCH_SIZE) {
    const batch = products.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(p => syncProductTurbo(channel, p, mappings, shopifyMap, jobId)));
    // Update progress after each batch
    await query('UPDATE sync_jobs SET processed_count = $1 WHERE id = $2', [Math.min(i + BATCH_SIZE, products.length), jobId]);
  }
}

async function syncProductTurbo(
  channel: Channel,
  product: ProductRow,
  mappings: AttributeMapping[],
  shopifyMap: Map<string, { productId: string; variantId: string; inventoryItemId: string }>,
  jobId: string,
  retries = 0
): Promise<void> {
  const shopifyIds = shopifyMap.get(product.sku);

  if (!shopifyIds) {
    await logSyncEntry(jobId, product.sku, 'skipped', 'SKU not found in Shopify — use Sync All to create it');
    return;
  }

  try {
    const mapped = applyMappings(product.raw_data, mappings);

    // Price update via productVariantsBulkUpdate
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

    // Stock update — use inventorySetQuantities
    if (mapped.inventory_quantity !== undefined) {
      let locationId = channel.settings?.stock_location_id;
      if (!locationId) {
        const locQuery = `{ locations(first: 1) { edges { node { id } } } }`;
        const locData = await shopifyGraphQL(channel, locQuery) as { locations: { edges: Array<{ node: { id: string } }> } };
        locationId = locData.locations.edges[0]?.node?.id;
      }

      if (locationId) {
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
    }

    await logSyncEntry(jobId, product.sku, 'updated', 'Turbo sync succeeded');
    await query('UPDATE sync_jobs SET updated_count = updated_count + 1 WHERE id = $1', [jobId]);
  } catch (err: unknown) {
    const errMsg = String(err);
    if (errMsg.includes('Throttled') && retries < MAX_RETRIES) {
      await sleep(RETRY_DELAY_MS * (retries + 1));
      return syncProductTurbo(channel, product, mappings, shopifyMap, jobId, retries + 1);
    }
    await logSyncEntry(jobId, product.sku, 'failed', errMsg);
    await query('UPDATE sync_jobs SET failed_count = failed_count + 1 WHERE id = $1', [jobId]);
  }
}

// ── Individual Sync: create new + update all fields ───────────────────────
async function individualSync(channel: Channel, products: ProductRow[], mappings: AttributeMapping[], jobId: string, withImages: boolean) {
  const shopifyMap = await getShopifyProductMap(channel);

  for (let i = 0; i < products.length; i++) {
    const product = products[i];
    const shopifyIds = shopifyMap.get(product.sku);
    const mapped = applyMappings(product.raw_data, mappings);

    try {
      if (!shopifyIds) {
        // CREATE
        await createShopifyProduct(channel, product.sku, mapped, withImages);
        await logSyncEntry(jobId, product.sku, 'created', 'New product created in Shopify');
        await query('UPDATE sync_jobs SET created_count = created_count + 1 WHERE id = $1', [jobId]);
      } else {
        // UPDATE product fields
        const updateMutation = `
          mutation productUpdate($input: ProductInput!) {
            productUpdate(input: $input) {
              product { id title }
              userErrors { field message }
            }
          }`;
        const input: Record<string, unknown> = { id: shopifyIds.productId };
        if (mapped.title) input.title = mapped.title;
        if (mapped.body_html) input.descriptionHtml = mapped.body_html;
        if (mapped.tags) input.tags = String(mapped.tags).split(',').map(t => t.trim());
        if (mapped.vendor) input.vendor = mapped.vendor;
        if (mapped.status) input.status = String(mapped.status).toUpperCase();

        await shopifyGraphQL(channel, updateMutation, { input });

        // UPDATE variant price/sku via productVariantsBulkUpdate
        if (mapped.price || mapped.compare_at_price || mapped.sku) {
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
          await shopifyGraphQL(channel, variantMutation, {
            productId: shopifyIds.productId,
            variants: [variantInput],
          });
        }

        // UPDATE stock via inventorySetQuantities
        if (mapped.inventory_quantity !== undefined) {
          let locationId = channel.settings?.stock_location_id;
          if (!locationId) {
            const locQuery = `{ locations(first: 1) { edges { node { id } } } }`;
            const locData = await shopifyGraphQL(channel, locQuery) as { locations: { edges: Array<{ node: { id: string } }> } };
            locationId = locData.locations.edges[0]?.node?.id;
          }
          if (locationId) {
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
        }

        await logSyncEntry(jobId, product.sku, 'updated', 'Full sync succeeded');
        await query('UPDATE sync_jobs SET updated_count = updated_count + 1 WHERE id = $1', [jobId]);
      }
    } catch (err) {
      await logSyncEntry(jobId, product.sku, 'failed', String(err));
      await query('UPDATE sync_jobs SET failed_count = failed_count + 1 WHERE id = $1', [jobId]);
    }

    // Update progress
    await query('UPDATE sync_jobs SET processed_count = $1 WHERE id = $2', [i + 1, jobId]);
  }
}

async function createShopifyProduct(channel: Channel, sku: string, mapped: Record<string, unknown>, withImages: boolean) {
  // Step 1: Create product with basic fields using the new API (2024-10+)
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

  // Media (images) via separate argument
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

  // Step 2: Update the default variant with SKU, price via productVariantsBulkUpdate
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
        sku,
        price: mapped.price ? String(mapped.price) : '0.00',
        compareAtPrice: mapped.compare_at_price ? String(mapped.compare_at_price) : null,
      }],
    });
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
  const { jobId, channel, feedId, preset, filterRules } = config;

  try {
    // Mark job as running
    await query(
      "UPDATE sync_jobs SET status = 'running', started_at = NOW() WHERE id = $1",
      [jobId]
    );

    // Fetch products
    const productsResult = await query(
      'SELECT sku, raw_data FROM products WHERE feed_id = $1 AND status = $2',
      [feedId, 'active']
    );
    let products: ProductRow[] = productsResult.rows;

    // Apply filter rules if provided
    if (filterRules && filterRules.length > 0) {
      products = products.filter(p => evaluateFilterRules(p.raw_data, filterRules));
      console.log(`[SyncFlow] Filter rules applied: ${productsResult.rows.length} → ${products.length} products`);
    }

    // Update total count
    await query('UPDATE sync_jobs SET total_products = $1 WHERE id = $2', [products.length, jobId]);

    // Fetch mappings
    const mappingsResult = await query(
      'SELECT feed_column, target_field FROM attribute_mappings WHERE feed_id = $1 AND channel_id = $2',
      [feedId, channel.id]
    );
    const mappings: AttributeMapping[] = mappingsResult.rows;

    console.log(`[SyncFlow] Job ${jobId} | Preset: ${preset} | Products: ${products.length}`);

    // Choose pathway
    if (preset === 'price_stock_meta' || (config.fields && config.fields.every(f => ['price', 'stock', 'metafields'].includes(f)))) {
      // Turbo Mode
      console.log('[SyncFlow] Pathway: TURBO');
      await turboSync(channel, products, mappings, jobId);
    } else if (products.length < 50) {
      // Individual
      console.log('[SyncFlow] Pathway: INDIVIDUAL');
      await individualSync(channel, products, mappings, jobId, preset !== 'sync_all_no_images');
    } else {
      // For large catalogs: do individual (Bulk API can be added later)
      console.log('[SyncFlow] Pathway: INDIVIDUAL (large batch)');
      await individualSync(channel, products, mappings, jobId, preset === 'sync_all');
    }

    // Mark complete
    await query(
      "UPDATE sync_jobs SET status = 'completed', completed_at = NOW() WHERE id = $1",
      [jobId]
    );
    console.log(`[SyncFlow] Job ${jobId} completed`);
  } catch (err) {
    console.error(`[SyncFlow] Job ${jobId} failed:`, err);
    await query(
      "UPDATE sync_jobs SET status = 'failed', completed_at = NOW(), error_message = $1 WHERE id = $2",
      [String(err), jobId]
    );
  }
}
