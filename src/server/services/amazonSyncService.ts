/**
 * Amazon Sync Service — Feeds-based bulk sync
 *
 * Mirrors noonSyncService.ts patterns:
 *  - Uses sync_jobs + sync_logs tables
 *  - Batch time limit (5.5 min / 330s)
 *  - Cancellation tracking
 *  - Submits JSON_LISTINGS_FEED via amazonFeedsService
 *  - Polls feed status until DONE/FATAL or time limit
 *
 * Presets: price_stock, content_only, sync_all, custom
 */

import { query } from '../db.js';
import {
  parseAmazonCredentials,
  type AmazonCredentials,
} from './amazonAuthService.js';
import {
  submitListingsFeed,
  checkFeedStatus,
  getFeedResults,
  buildStockPatchMessages,
  buildPricePatchMessages,
  buildContentPatchMessages,
  chunkMessages,
  type FeedMessage,
} from './amazonFeedsService.js';

const BATCH_TIME_LIMIT_MS = 330_000; // 5.5 minutes
const FEED_POLL_INTERVAL_MS = 15_000; // poll feed status every 15s

// Currency per marketplace
const MARKETPLACE_CURRENCY: Record<string, string> = {
  ATVPDKIKX0DER: 'USD', // US
  A2VIGQ35RCS4UG: 'AED', // AE
  ARBP9OOSHTCHU: 'EGP',  // EG
  A1F83G8C2ARO7P: 'GBP', // UK
  A1PA6795UKMFR9: 'EUR', // DE
};

export interface AmazonChannel {
  id: string;
  client_id: string;
  amazon_credentials_json: string;
  amazon_marketplace_ids: string;
  amazon_region: string;
  settings?: Record<string, unknown>;
}

export interface AmazonSyncJobConfig {
  jobId: string;
  channel: AmazonChannel;
  feedId: string;
  preset: string;
  fields?: string[];
  includeImages?: boolean;
  priceAdjustmentPercent?: number;
  priceRoundingMode?: 'none' | 'up' | 'down';
}

interface AttributeMapping {
  feed_column: string;
  target_field: string;
}

// ── Cancellation tracking ──────────────────────────────────────────────────
const cancelledJobs = new Set<string>();

export function cancelAmazonJob(jobId: string) {
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

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Job helpers ────────────────────────────────────────────────────────────

async function failJob(jobId: string, error: string) {
  await query(
    "UPDATE sync_jobs SET status = 'failed', error_message = $1, completed_at = NOW() WHERE id = $2",
    [error.slice(0, 2000), jobId]
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
    `UPDATE sync_jobs SET
      status = 'completed',
      processed_count = $1, updated_count = $2, failed_count = $3, skipped_count = $4,
      completed_at = NOW()
     WHERE id = $5`,
    [processedCount, updatedCount, failedCount, skippedCount, jobId]
  );
}

async function logEntry(
  jobId: string,
  sku: string,
  status: string,
  message: string,
  details?: Record<string, string>
) {
  await query(
    `INSERT INTO sync_logs (sync_job_id, sku, status, message, details)
     VALUES ($1, $2, $3, $4, $5)`,
    [jobId, sku, status, message, details ? JSON.stringify(details) : null]
  );
}

// ── Main sync runner ───────────────────────────────────────────────────────

export async function runAmazonSyncJob(config: AmazonSyncJobConfig): Promise<void> {
  const {
    jobId, channel, feedId, preset,
    includeImages = false,
    priceAdjustmentPercent = 0,
    priceRoundingMode = 'none',
  } = config;
  const startTime = Date.now();

  console.log(`[AmazonSync] Starting job ${jobId} — preset: ${preset}, includeImages: ${includeImages}`);

  try {
    // Mark job as running
    await query(
      "UPDATE sync_jobs SET status = 'running', started_at = NOW() WHERE id = $1",
      [jobId]
    );

    const credentials = parseAmazonCredentials(channel.amazon_credentials_json);
    const region = channel.amazon_region || 'eu';
    const marketplaceIds = (channel.amazon_marketplace_ids || '').split(',').map(s => s.trim()).filter(Boolean);

    if (marketplaceIds.length === 0) {
      await failJob(jobId, 'No marketplace IDs configured for this Amazon channel');
      return;
    }

    // Use first marketplace for pricing / content locale
    const primaryMarketplace = marketplaceIds[0];
    const currency = MARKETPLACE_CURRENCY[primaryMarketplace] || 'USD';

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

    // Build flat row data from raw_data
    const rows = products.map((p: { sku: string; raw_data: Record<string, unknown> }) => ({
      ...p.raw_data,
      sku: p.sku,
    }));

    // Build feed messages based on preset
    const syncStock = preset === 'price_stock' || preset === 'stock_only' || preset === 'sync_all' || preset === 'price_stock_meta';
    const syncPrice = preset === 'price_stock' || preset === 'price_only' || preset === 'sync_all' || preset === 'price_stock_meta';
    const syncContent = preset === 'content_only' || preset === 'sync_all' || preset === 'price_stock_meta';

    const allMessages: FeedMessage[] = [];
    let msgId = 1;

    if (syncStock) {
      const stockMsgs = buildStockPatchMessages(rows, mappings, msgId);
      msgId += stockMsgs.length;
      allMessages.push(...stockMsgs);
    }

    if (syncPrice) {
      const priceMsgs = buildPricePatchMessages(
        rows, mappings, primaryMarketplace, currency, msgId,
        priceAdjustmentPercent, priceRoundingMode
      );
      msgId += priceMsgs.length;
      allMessages.push(...priceMsgs);
    }

    if (syncContent) {
      const contentMsgs = buildContentPatchMessages(
        rows, mappings, primaryMarketplace, msgId, includeImages
      );
      msgId += contentMsgs.length;
      allMessages.push(...contentMsgs);
    }

    if (allMessages.length === 0) {
      await logEntry(jobId, '*', 'skipped', 'No valid messages could be built from products + mappings');
      await completeJob(jobId, products.length, 0, 0, products.length);
      return;
    }

    console.log(`[AmazonSync] Job ${jobId} — built ${allMessages.length} feed messages`);

    // Cancellation check before submitting
    if (await isJobCancelled(jobId)) {
      console.log(`[AmazonSync] Job ${jobId} cancelled before feed submission`);
      return;
    }

    // Submit feed(s) — split if exceeding max
    const chunks = chunkMessages(allMessages);
    let totalProcessed = 0;
    let totalUpdated = 0;
    let totalFailed = 0;
    let totalSkipped = 0;

    for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
      const chunk = chunks[chunkIdx];

      // Time check
      if (Date.now() - startTime > BATCH_TIME_LIMIT_MS) {
        console.log(`[AmazonSync] Job ${jobId} hit time limit at chunk ${chunkIdx}/${chunks.length}`);
        await query(
          'UPDATE sync_jobs SET processed_count = $1, updated_count = $2, failed_count = $3, skipped_count = $4 WHERE id = $5',
          [totalProcessed, totalUpdated, totalFailed, totalSkipped, jobId]
        );
        break;
      }

      // Cancel check
      if (await isJobCancelled(jobId)) {
        console.log(`[AmazonSync] Job ${jobId} cancelled`);
        return;
      }

      try {
        // Submit feed
        const { feedId: amazonFeedId, feedDocumentId } = await submitListingsFeed(
          credentials, region, credentials.seller_id, marketplaceIds, chunk
        );

        // Track feed job
        await query(
          `INSERT INTO amazon_feed_jobs (channel_id, feed_id, sync_job_id, amazon_feed_id, amazon_feed_document_id, status, total_messages)
           VALUES ($1, $2, $3, $4, $5, 'submitted', $6)`,
          [channel.id, feedId, jobId, amazonFeedId, feedDocumentId, chunk.length]
        );

        console.log(`[AmazonSync] Job ${jobId} — feed ${amazonFeedId} submitted (${chunk.length} messages)`);

        // Poll feed status until done or time limit
        let feedDone = false;
        while (!feedDone && (Date.now() - startTime) < BATCH_TIME_LIMIT_MS) {
          await sleep(FEED_POLL_INTERVAL_MS);

          if (await isJobCancelled(jobId)) {
            console.log(`[AmazonSync] Job ${jobId} cancelled during feed polling`);
            return;
          }

          const status = await checkFeedStatus(credentials, region, amazonFeedId);
          console.log(`[AmazonSync] Feed ${amazonFeedId} status: ${status.processingStatus}`);

          if (status.processingStatus === 'DONE' || status.processingStatus === 'FATAL') {
            feedDone = true;

            // Update feed job record
            await query(
              `UPDATE amazon_feed_jobs SET status = $1, completed_at = NOW() WHERE amazon_feed_id = $2`,
              [status.processingStatus === 'DONE' ? 'done' : 'fatal', amazonFeedId]
            );

            if (status.processingStatus === 'DONE' && status.resultFeedDocumentId) {
              // Fetch results
              try {
                const results = await getFeedResults(credentials, region, status.resultFeedDocumentId);

                await query(
                  `UPDATE amazon_feed_jobs SET
                    amazon_result_document_id = $1,
                    processed_count = $2,
                    failed_count = $3
                   WHERE amazon_feed_id = $4`,
                  [
                    status.resultFeedDocumentId,
                    results.numberOfRecordsProcessed || chunk.length,
                    results.numberOfRecordsWithError || 0,
                    amazonFeedId,
                  ]
                );

                const errCount = results.numberOfRecordsWithError || 0;
                const okCount = (results.numberOfRecordsProcessed || chunk.length) - errCount;

                totalUpdated += okCount;
                totalFailed += errCount;

                // Log individual errors if available
                if (results.errors && results.errors.length > 0) {
                  for (const err of results.errors.slice(0, 100)) {
                    await logEntry(jobId, err.sku || 'unknown', 'failed',
                      `Amazon feed error: ${err.code || ''} — ${err.message || 'Unknown error'}`,
                      { severity: err.severity || 'ERROR' }
                    );
                  }
                }

                await logEntry(jobId, '*', 'updated',
                  `Feed ${amazonFeedId}: ${okCount} succeeded, ${errCount} failed`
                );
              } catch (resultErr) {
                console.error(`[AmazonSync] Failed to fetch results for feed ${amazonFeedId}:`, resultErr);
                totalUpdated += chunk.length; // Assume success if we can't parse results
                await logEntry(jobId, '*', 'updated',
                  `Feed ${amazonFeedId} completed but result download failed`
                );
              }
            } else if (status.processingStatus === 'FATAL') {
              totalFailed += chunk.length;
              await logEntry(jobId, '*', 'failed', `Feed ${amazonFeedId} processing failed (FATAL)`);
            }
          } else if (status.processingStatus === 'CANCELLED') {
            feedDone = true;
            totalSkipped += chunk.length;
            await query(
              `UPDATE amazon_feed_jobs SET status = 'cancelled', completed_at = NOW() WHERE amazon_feed_id = $1`,
              [amazonFeedId]
            );
          }
        }

        if (!feedDone) {
          // Time limit hit while polling
          await logEntry(jobId, '*', 'updated',
            `Feed ${amazonFeedId} still processing — will need manual check`
          );
          totalProcessed += chunk.length;
        }

        totalProcessed += chunk.length;

      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Feed submission failed';
        console.error(`[AmazonSync] Feed chunk ${chunkIdx} error:`, msg);
        totalFailed += chunk.length;
        await logEntry(jobId, '*', 'failed', `Feed submission error: ${msg}`);
      }

      // Progress update
      await query(
        'UPDATE sync_jobs SET processed_count = $1, updated_count = $2, failed_count = $3, skipped_count = $4 WHERE id = $5',
        [totalProcessed, totalUpdated, totalFailed, totalSkipped, jobId]
      );
    }

    // Update amazon_products last_synced_at for processed SKUs
    const processedSkus = allMessages.map(m => m.sku);
    if (processedSkus.length > 0) {
      // Upsert amazon_products entries
      for (const sku of processedSkus) {
        await query(
          `INSERT INTO amazon_products (channel_id, sku, last_synced_at)
           VALUES ($1, $2, NOW())
           ON CONFLICT (channel_id, sku) DO UPDATE SET last_synced_at = NOW()`,
          [channel.id, sku]
        );
      }
    }

    await completeJob(jobId, totalProcessed, totalUpdated, totalFailed, totalSkipped);
    cancelledJobs.delete(jobId);
    console.log(`[AmazonSync] Job ${jobId} completed — ${totalUpdated} updated, ${totalFailed} failed, ${totalSkipped} skipped`);
  } catch (err) {
    console.error(`[AmazonSync] Job ${jobId} crashed:`, err);
    await failJob(jobId, err instanceof Error ? err.message : 'Unknown error');
  }
}
