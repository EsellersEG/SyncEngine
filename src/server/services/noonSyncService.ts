/**
 * Noon Sync Service — Stock & Price Sync
 *
 * Mirrors shopifySyncService.ts patterns:
 *  - Uses sync_jobs + sync_logs tables
 *  - Batch time limit (5.5 min / 330s)
 *  - Cancellation tracking
 *  - Rate-limited API calls
 *
 * Noon API endpoints used:
 *  - POST /seller/api/v1/stock/update — update stock levels
 *  - POST /seller/api/v1/pricing/upsert — batch upsert pricing
 */

import { query } from '../db.js';
import {
  parseNoonCredentials,
  noonApiRequest,
  type NoonCredentials,
} from './noonAuthService.js';

const BATCH_TIME_LIMIT_MS = 330_000; // 5.5 minutes
const BATCH_SIZE = 50; // Items per API call
const PRICE_CHANGE_GUARDRAIL = 0.30; // 30% max price change warning

interface NoonChannel {
  id: string;
  client_id: string;
  noon_credentials_json: string;
  noon_warehouse_code: string;
  noon_country_code: string;
  settings?: Record<string, unknown>;
}

interface NoonSyncJobConfig {
  jobId: string;
  channel: NoonChannel;
  feedId: string;
  preset: string;
  fields?: string[];
  priceAdjustmentPercent?: number;
  priceRoundingMode?: 'none' | 'up' | 'down';
}

interface AttributeMapping {
  feed_column: string;
  target_field: string;
}

// ── Cancellation tracking ──────────────────────────────────────────────────
const cancelledJobs = new Set<string>();

export function cancelNoonJob(jobId: string) {
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

// ── Main sync runner ───────────────────────────────────────────────────────

export async function runNoonSyncJob(config: NoonSyncJobConfig): Promise<void> {
  const { jobId, channel, feedId, preset, priceAdjustmentPercent = 0, priceRoundingMode = 'none' } = config;
  const startTime = Date.now();

  console.log(`[NoonSync] Starting job ${jobId} — preset: ${preset}`);

  try {
    // Mark job as running
    await query(
      "UPDATE sync_jobs SET status = 'running', started_at = NOW() WHERE id = $1",
      [jobId]
    );

    const credentials = parseNoonCredentials(channel.noon_credentials_json);
    const countryCode = channel.noon_country_code || 'AE';
    const warehouseCode = channel.noon_warehouse_code;

    // Load mappings
    const mappingsResult = await query(
      'SELECT feed_column, target_field FROM attribute_mappings WHERE feed_id = $1 AND channel_id = $2',
      [feedId, channel.id]
    );
    const mappings: AttributeMapping[] = mappingsResult.rows;

    if (mappings.length === 0) {
      await failJob(jobId, 'No attribute mappings configured for this feed+channel pair');
      return;
    }

    // Load products
    const productsResult = await query(
      "SELECT sku, raw_data FROM products WHERE feed_id = $1 AND status = 'active'",
      [feedId]
    );
    const products = productsResult.rows;

    await query(
      'UPDATE sync_jobs SET total_products = $1 WHERE id = $2',
      [products.length, jobId]
    );

    if (products.length === 0) {
      await completeJob(jobId, 0, 0, 0, 0);
      return;
    }

    // Load existing Noon product mappings
    const noonProductsResult = await query(
      'SELECT sku, noon_partner_sku FROM noon_products WHERE channel_id = $1',
      [channel.id]
    );
    const noonSkuMap = new Map<string, string>();
    for (const np of noonProductsResult.rows) {
      noonSkuMap.set(np.sku, np.noon_partner_sku);
    }

    let processedCount = 0;
    let updatedCount = 0;
    let failedCount = 0;
    let skippedCount = 0;

    // Determine which fields to sync
    const syncStock = preset === 'price_stock' || preset === 'stock_only' || preset === 'sync_all';
    const syncPrice = preset === 'price_stock' || preset === 'price_only' || preset === 'sync_all';

    // Process in batches
    for (let i = 0; i < products.length; i += BATCH_SIZE) {
      // Time check
      if (Date.now() - startTime > BATCH_TIME_LIMIT_MS) {
        console.log(`[NoonSync] Job ${jobId} hit time limit at product ${i}/${products.length}`);
        await query(
          'UPDATE sync_jobs SET processed_count = $1, updated_count = $2, failed_count = $3, skipped_count = $4 WHERE id = $5',
          [processedCount, updatedCount, failedCount, skippedCount, jobId]
        );
        break;
      }

      // Cancellation check
      if (await isJobCancelled(jobId)) {
        console.log(`[NoonSync] Job ${jobId} cancelled`);
        return;
      }

      const batch = products.slice(i, i + BATCH_SIZE);

      // ── Stock sync ──
      if (syncStock) {
        try {
          const stockUpdates = buildStockPayload(batch, mappings, noonSkuMap, warehouseCode);
          if (stockUpdates.length > 0) {
            await noonApiRequest(credentials, countryCode, 'POST', '/seller/api/v1/stock/update', {
              stocks: stockUpdates,
            });
            for (const update of stockUpdates) {
              await logEntry(jobId, update.partnerSku, 'updated', `Stock updated to ${update.quantity}`);
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Stock update failed';
          console.error(`[NoonSync] Stock batch error:`, msg);
          for (const p of batch) {
            await logEntry(jobId, p.sku, 'failed', `Stock sync failed: ${msg}`);
            failedCount++;
          }
        }
      }

      // ── Price sync ──
      if (syncPrice) {
        try {
          const priceUpdates = buildPricePayload(
            batch, mappings, noonSkuMap, priceAdjustmentPercent, priceRoundingMode
          );
          if (priceUpdates.length > 0) {
            // Check guardrails
            for (const pu of priceUpdates) {
              if (pu._priceChangePercent && Math.abs(pu._priceChangePercent) > PRICE_CHANGE_GUARDRAIL * 100) {
                await logEntry(jobId, pu.partnerSku, 'updated',
                  `⚠️ Price changed by ${pu._priceChangePercent.toFixed(1)}% (exceeds ${PRICE_CHANGE_GUARDRAIL * 100}% guardrail)`,
                  { price_to: String(pu.price) }
                );
              }
            }

            // Strip internal fields before sending
            const cleanPayload = priceUpdates.map(({ partnerSku, price, msrp, salePrice }) => ({
              partnerSku, price, msrp, salePrice,
            }));

            await noonApiRequest(credentials, countryCode, 'POST', '/seller/api/v1/pricing/upsert', {
              prices: cleanPayload,
            });

            for (const update of priceUpdates) {
              await logEntry(jobId, update.partnerSku, 'updated', `Price updated to ${update.price}`);
              updatedCount++;
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Price update failed';
          console.error(`[NoonSync] Price batch error:`, msg);
          for (const p of batch) {
            await logEntry(jobId, p.sku, 'failed', `Price sync failed: ${msg}`);
            failedCount++;
          }
        }
      }

      processedCount += batch.length;

      // Progress update
      if (i % (BATCH_SIZE * 5) === 0) {
        await query(
          'UPDATE sync_jobs SET processed_count = $1, updated_count = $2, failed_count = $3, skipped_count = $4 WHERE id = $5',
          [processedCount, updatedCount, failedCount, skippedCount, jobId]
        );
      }
    }

    await completeJob(jobId, processedCount, updatedCount, failedCount, skippedCount);
    cancelledJobs.delete(jobId);
    console.log(`[NoonSync] Job ${jobId} completed — ${updatedCount} updated, ${failedCount} failed, ${skippedCount} skipped`);
  } catch (err) {
    console.error(`[NoonSync] Job ${jobId} crashed:`, err);
    await failJob(jobId, err instanceof Error ? err.message : 'Unknown error');
  }
}

// ── Payload builders ───────────────────────────────────────────────────────

function buildStockPayload(
  products: Array<{ sku: string; raw_data: Record<string, unknown> }>,
  mappings: AttributeMapping[],
  noonSkuMap: Map<string, string>,
  warehouseCode: string
): Array<{ partnerSku: string; quantity: number; warehouseCode: string }> {
  const qtyMapping = mappings.find(m => m.target_field === 'inventory_quantity' || m.target_field === 'qty');
  if (!qtyMapping) return [];

  const results: Array<{ partnerSku: string; quantity: number; warehouseCode: string }> = [];

  for (const p of products) {
    const partnerSku = noonSkuMap.get(p.sku) || p.sku;
    const rawQty = p.raw_data[qtyMapping.feed_column];
    const quantity = Math.max(0, Math.floor(Number(rawQty) || 0));

    results.push({ partnerSku, quantity, warehouseCode });
  }

  return results;
}

function buildPricePayload(
  products: Array<{ sku: string; raw_data: Record<string, unknown> }>,
  mappings: AttributeMapping[],
  noonSkuMap: Map<string, string>,
  priceAdjustmentPercent: number,
  roundingMode: 'none' | 'up' | 'down'
): Array<{ partnerSku: string; price: number; msrp?: number; salePrice?: number; _priceChangePercent?: number }> {
  const priceMapping = mappings.find(m => m.target_field === 'price');
  if (!priceMapping) return [];

  const msrpMapping = mappings.find(m => m.target_field === 'msrp' || m.target_field === 'compare_at_price');
  const salePriceMapping = mappings.find(m => m.target_field === 'sale_price');

  const results: Array<{ partnerSku: string; price: number; msrp?: number; salePrice?: number; _priceChangePercent?: number }> = [];

  for (const p of products) {
    const partnerSku = noonSkuMap.get(p.sku) || p.sku;
    let price = parseFloat(String(p.raw_data[priceMapping.feed_column] || 0));
    if (isNaN(price) || price <= 0) continue;

    // Apply price adjustment
    if (priceAdjustmentPercent) {
      price = price * (1 + priceAdjustmentPercent / 100);
    }

    // Apply rounding
    if (roundingMode === 'up') {
      price = Math.ceil(price);
    } else if (roundingMode === 'down') {
      price = Math.floor(price);
    } else {
      price = Math.round(price * 100) / 100;
    }

    const entry: { partnerSku: string; price: number; msrp?: number; salePrice?: number; _priceChangePercent?: number } = {
      partnerSku,
      price,
    };

    if (msrpMapping) {
      const msrp = parseFloat(String(p.raw_data[msrpMapping.feed_column] || 0));
      if (!isNaN(msrp) && msrp > 0) entry.msrp = msrp;
    }

    if (salePriceMapping) {
      const salePrice = parseFloat(String(p.raw_data[salePriceMapping.feed_column] || 0));
      if (!isNaN(salePrice) && salePrice > 0) entry.salePrice = salePrice;
    }

    results.push(entry);
  }

  return results;
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function logEntry(
  jobId: string,
  sku: string,
  action: string,
  message: string,
  details?: Record<string, string>
) {
  await query(
    'INSERT INTO sync_logs (job_id, sku, action, message, details) VALUES ($1, $2, $3, $4, $5)',
    [jobId, sku, action, message, details ? JSON.stringify(details) : null]
  );
}

async function failJob(jobId: string, errorMessage: string) {
  await query(
    "UPDATE sync_jobs SET status = 'failed', error_message = $1, completed_at = NOW() WHERE id = $2",
    [errorMessage, jobId]
  );
}

async function completeJob(
  jobId: string,
  processedCount: number,
  updatedCount: number,
  failedCount: number,
  skippedCount: number
) {
  await query(
    `UPDATE sync_jobs SET status = 'completed', completed_at = NOW(),
     processed_count = $1, updated_count = $2, failed_count = $3, skipped_count = $4
     WHERE id = $5`,
    [processedCount, updatedCount, failedCount, skippedCount, jobId]
  );
}
