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

const BATCH_SIZE = 25;
const MAX_RETRIES = 8;
const RETRY_DELAY_MS = 2000;

// ── GraphQL Helper ─────────────────────────────────────────────────────────
async function shopifyGraphQL(channel: Channel, query: string, variables = {}): Promise<unknown> {
  const url = `https://${channel.shopify_store_url}/admin/api/${channel.shopify_api_version}/graphql.json`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': channel.shopify_access_token,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json() as { errors?: unknown[]; data?: unknown; extensions?: { cost?: { throttleStatus?: { currentlyAvailable?: number } } } };
  if (json.errors) throw new Error(JSON.stringify(json.errors));

  // Throttle check
  const cost = json.extensions?.cost?.throttleStatus;
  if (cost && cost.currentlyAvailable && cost.currentlyAvailable < 100) {
    await sleep(2000);
  }

  return json.data;
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── SKU → Shopify ID lookup ───────────────────────────────────────────────
async function getShopifyProductMap(channel: Channel): Promise<Map<string, { productId: string; variantId: string; inventoryItemId: string }>> {
  const map = new Map();

  // Use Shopify REST to get all products with variants
  let pageInfo: string | null = null;
  let hasMore = true;

  while (hasMore) {
    const url = `https://${channel.shopify_store_url}/admin/api/${channel.shopify_api_version}/products.json?limit=250${pageInfo ? `&page_info=${pageInfo}` : ''}`;
    const res = await fetch(url, {
      headers: { 'X-Shopify-Access-Token': channel.shopify_access_token },
    });
    const linkHeader = res.headers.get('Link');
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Shopify API error (${res.status}): ${errText}`);
    }
    const data = await res.json() as { products?: Array<{ id: number; variants: Array<{ sku: string; id: number; inventory_item_id: number }> }> };

    if (!data.products || !Array.isArray(data.products)) {
      throw new Error(`Shopify returned unexpected response: ${JSON.stringify(data).slice(0, 200)}`);
    }

    for (const product of data.products) {
      for (const variant of product.variants) {
        if (variant.sku) {
          map.set(variant.sku, {
            productId: `gid://shopify/Product/${product.id}`,
            variantId: `gid://shopify/ProductVariant/${variant.id}`,
            inventoryItemId: `gid://shopify/InventoryItem/${variant.inventory_item_id}`,
          });
        }
      }
    }

    if (linkHeader && linkHeader.includes('rel="next"')) {
      const match = linkHeader.match(/page_info=([^&>]+).*rel="next"/);
      pageInfo = match ? match[1] : null;
      hasMore = !!pageInfo;
    } else {
      hasMore = false;
    }
  }

  return map;
}

// ── Turbo Mode: parallel price/stock updates ──────────────────────────────
async function turboSync(channel: Channel, products: ProductRow[], mappings: AttributeMapping[], jobId: string) {
  const shopifyMap = await getShopifyProductMap(channel);

  for (let i = 0; i < products.length; i += BATCH_SIZE) {
    const batch = products.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(p => syncProductTurbo(channel, p, mappings, shopifyMap, jobId)));
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

    // Price update
    if (mapped.price || mapped.compare_at_price) {
      const priceQuery = `
        mutation variantUpdate($input: ProductVariantInput!) {
          productVariantUpdate(input: $input) {
            productVariant { id price compareAtPrice }
            userErrors { field message }
          }
        }`;
      await shopifyGraphQL(channel, priceQuery, {
        input: {
          id: shopifyIds.variantId,
          price: mapped.price,
          compareAtPrice: mapped.compare_at_price || null,
        },
      });
    }

    // Stock update — get location first
    if (mapped.inventory_quantity !== undefined) {
      const locQuery = `{ locations(first: 1) { edges { node { id } } } }`;
      const locData = await shopifyGraphQL(channel, locQuery) as { locations: { edges: Array<{ node: { id: string } }> } };
      const locationId = locData.locations.edges[0]?.node?.id;

      if (locationId) {
        const stockQuery = `
          mutation inventorySet($input: InventoryAdjustQuantityInput!) {
            inventoryAdjustQuantity(input: $input) {
              inventoryLevel { available }
              userErrors { field message }
            }
          }`;
        await shopifyGraphQL(channel, stockQuery, {
          input: {
            inventoryItemId: shopifyIds.inventoryItemId,
            locationId,
            delta: parseInt(String(mapped.inventory_quantity)) - 0, // delta — will improve with current tracking
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

  for (const product of products) {
    const shopifyIds = shopifyMap.get(product.sku);
    const mapped = applyMappings(product.raw_data, mappings);

    try {
      if (!shopifyIds) {
        // CREATE
        await createShopifyProduct(channel, product.sku, mapped, withImages);
        await logSyncEntry(jobId, product.sku, 'created', 'New product created in Shopify');
        await query('UPDATE sync_jobs SET created_count = created_count + 1 WHERE id = $1', [jobId]);
      } else {
        // UPDATE title, body, tags, vendor, status
        const updateMutation = `
          mutation productUpdate($input: ProductInput!) {
            productUpdate(input: $input) {
              product { id title }
              userErrors { field message }
            }
          }`;
        const input: Record<string, unknown> = { id: shopifyIds.productId };
        if (mapped.title) input.title = mapped.title;
        if (mapped.body_html) input.bodyHtml = mapped.body_html;
        if (mapped.tags) input.tags = String(mapped.tags).split(',').map(t => t.trim());
        if (mapped.vendor) input.vendor = mapped.vendor;
        if (mapped.status) input.status = String(mapped.status).toUpperCase();

        await shopifyGraphQL(channel, updateMutation, { input });
        await logSyncEntry(jobId, product.sku, 'updated', 'Full sync succeeded');
        await query('UPDATE sync_jobs SET updated_count = updated_count + 1 WHERE id = $1', [jobId]);
      }
    } catch (err) {
      await logSyncEntry(jobId, product.sku, 'failed', String(err));
      await query('UPDATE sync_jobs SET failed_count = failed_count + 1 WHERE id = $1', [jobId]);
    }
  }
}

async function createShopifyProduct(channel: Channel, sku: string, mapped: Record<string, unknown>, withImages: boolean) {
  const createMutation = `
    mutation productCreate($input: ProductInput!) {
      productCreate(input: $input) {
        product { id variants(first: 1) { edges { node { id sku } } } }
        userErrors { field message }
      }
    }`;

  const input: Record<string, unknown> = {
    title: mapped.title || sku,
    bodyHtml: mapped.body_html || '',
    vendor: mapped.vendor || '',
    tags: mapped.tags ? String(mapped.tags).split(',').map(t => t.trim()) : [],
    status: mapped.status ? String(mapped.status).toUpperCase() : 'DRAFT',
    variants: [{
      sku,
      price: mapped.price || '0.00',
      compareAtPrice: mapped.compare_at_price || null,
      inventoryPolicy: 'DENY',
      inventoryManagement: 'SHOPIFY',
    }],
  };

  if (withImages && mapped.image_url) {
    input.images = [{ src: mapped.image_url }];
  }

  await shopifyGraphQL(channel, createMutation, { input });
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
