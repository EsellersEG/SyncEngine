/**
 * Automation Scheduler Service
 * Runs automations based on their configured intervals.
 * Replaces the old per-feed sync_interval approach.
 */

import { query } from '../db.js';
import { importFeedProducts } from './feedService.js';
import { runSyncJob } from './shopifySyncService.js';
import { getOdooOrderStates, type OdooConfig } from './odooService.js';

let schedulerInterval: ReturnType<typeof setInterval> | null = null;
let cancelCheckInterval: ReturnType<typeof setInterval> | null = null;

export function startScheduler() {
  if (schedulerInterval) return;

  // Check every 60 seconds for automations that need to run
  schedulerInterval = setInterval(async () => {
    try {
      // Get scheduled automations that are due
      const result = await query(
        `SELECT a.*,
          f.name as feed_name, f.type as feed_type,
          f.spreadsheet_id, f.sheet_name, f.header_row, f.service_account_json,
          f.odoo_url, f.odoo_database, f.odoo_username, f.odoo_api_key,
          ch.name as channel_name, ch.shopify_store_url, ch.shopify_access_token, ch.shopify_api_version, ch.settings,
          c.name as client_name
         FROM automations a
         LEFT JOIN feeds f ON a.feed_id = f.id
         LEFT JOIN channels ch ON a.channel_id = ch.id
         LEFT JOIN clients c ON a.client_id = c.id
         WHERE a.is_active = true
           AND a.trigger_type = 'schedule'
           AND a.interval_minutes IS NOT NULL
           AND a.interval_minutes > 0
           AND (
             a.last_run_at IS NULL
             OR a.last_run_at < NOW() - (a.interval_minutes || ' minutes')::interval
           )`
      );

      for (const automation of result.rows) {
        try {
          if (automation.action_type === 'import_feed' && automation.feed_id) {
            console.log(`[Scheduler] Running automation: ${automation.name} (import ${automation.feed_name})`);
            // Build feed object from joined data
            const feed = {
              id: automation.feed_id,
              client_id: automation.client_id,
              type: automation.feed_type,
              spreadsheet_id: automation.spreadsheet_id,
              sheet_name: automation.sheet_name,
              header_row: automation.header_row,
              service_account_json: automation.service_account_json,
              odoo_url: automation.odoo_url,
              odoo_database: automation.odoo_database,
              odoo_username: automation.odoo_username,
              odoo_api_key: automation.odoo_api_key,
            };
            await importFeedProducts(feed);
          } else if (automation.action_type === 'sync_to_shopify' && automation.channel_id && automation.feed_id) {
            console.log(`[Scheduler] Running automation: ${automation.name} (sync to ${automation.channel_name})`);
            const preset = automation.feed_type === 'odoo' ? 'price_stock_meta' : 'sync_all';
            // Create a sync job
            const jobResult = await query(
              `INSERT INTO sync_jobs (client_id, channel_id, feed_id, status, preset, total_products)
               VALUES ($1, $2, $3, 'pending', $4, 0)
               RETURNING id`,
              [automation.client_id, automation.channel_id, automation.feed_id, preset]
            );
            const jobId = jobResult.rows[0].id;
            // Run it async
            runSyncJob({
              jobId,
              channel: {
                id: automation.channel_id,
                shopify_store_url: automation.shopify_store_url,
                shopify_access_token: automation.shopify_access_token,
                shopify_api_version: automation.shopify_api_version,
                settings: automation.settings,
              },
              feedId: automation.feed_id,
              preset,
              priceAdjustmentPercent: Number(automation.price_adjustment_percent || 0),
              priceRoundingMode: automation.rounding_mode === 'up' || automation.rounding_mode === 'down' ? automation.rounding_mode : 'none',
            }).catch(err => {
              console.error(`[Scheduler] Sync job ${jobId} failed:`, err);
            });
          }
          // Update last_run_at
          await query('UPDATE automations SET last_run_at = NOW() WHERE id = $1', [automation.id]);
        } catch (err) {
          console.error(`[Scheduler] Automation ${automation.name} failed:`, err);
        }
      }
    } catch (err) {
      console.error('[Scheduler] Error:', err);
    }
  }, 60_000);

  // Odoo→Shopify cancellation polling is disabled by default.
  // Enable by setting ENABLE_ODOO_CANCEL_SYNC=true in environment variables.
  if (process.env.ENABLE_ODOO_CANCEL_SYNC === 'true') {
    cancelCheckInterval = setInterval(syncOdooCancellationsToShopify, 5 * 60_000);
    console.log('[Scheduler] Odoo→Shopify cancellation polling enabled (every 5m)');
  }

  // Also poll feeds with sync_interval_minutes set every 60 seconds
  setInterval(runScheduledFeedImports, 60_000);

  console.log('[Scheduler] Started — checking automations every 60s, Odoo cancellations every 5m');
}

export function stopScheduler() {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
  if (cancelCheckInterval) {
    clearInterval(cancelCheckInterval);
    cancelCheckInterval = null;
  }
  console.log('[Scheduler] Stopped');
}

// ── Odoo → Shopify cancellation sync ──────────────────────────────────────

async function syncOdooCancellationsToShopify() {
  try {
    // Find all synced orders that have an Odoo order ID, grouped by client
    const result = await query(`
      SELECT o.id, o.shopify_order_id, o.odoo_order_id, o.channel_id,
             o.client_id,
             ch.shopify_store_url, ch.shopify_access_token, ch.shopify_api_version,
             f.odoo_url, f.odoo_database, f.odoo_username, f.odoo_api_key
      FROM orders o
      JOIN channels ch ON ch.id = o.channel_id
      JOIN feeds f ON f.client_id = o.client_id AND f.type = 'odoo'
      WHERE o.status = 'synced'
        AND o.odoo_order_id IS NOT NULL
      LIMIT 100
    `);

    if (result.rows.length === 0) return;

    // Group by Odoo config (same client = same Odoo instance)
    const byClient = new Map<string, typeof result.rows>();
    for (const row of result.rows) {
      const key = row.client_id;
      if (!byClient.has(key)) byClient.set(key, []);
      byClient.get(key)!.push(row);
    }

    for (const [, rows] of byClient) {
      const first = rows[0];
      const config: OdooConfig = {
        url: first.odoo_url,
        database: first.odoo_database,
        username: first.odoo_username,
        apiKey: first.odoo_api_key,
      };

      const odooIds = rows.map(r => Number(r.odoo_order_id));
      let stateMap: Map<number, string>;
      try {
        stateMap = await getOdooOrderStates(config, odooIds);
      } catch (err) {
        console.error('[Scheduler] Failed to fetch Odoo order states:', err);
        continue;
      }

      for (const row of rows) {
        const state = stateMap.get(Number(row.odoo_order_id));
        if (state !== 'cancel') continue;

        console.log(`[Scheduler] Odoo order ${row.odoo_order_id} is cancelled — cancelling Shopify order ${row.shopify_order_id}`);

        // Cancel in Shopify
        try {
          const storeDomain = row.shopify_store_url.replace(/^https?:\/\//, '').replace(/\/$/, '');
          const url = `https://${storeDomain}/admin/api/${row.shopify_api_version}/orders/${row.shopify_order_id}/cancel.json`;
          const res = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Shopify-Access-Token': row.shopify_access_token,
            },
            body: JSON.stringify({ reason: 'other', email: false }),
          });
          if (!res.ok) {
            const body = await res.text();
            console.error(`[Scheduler] Shopify cancel failed (${res.status}): ${body}`);
          } else {
            console.log(`[Scheduler] Shopify order ${row.shopify_order_id} cancelled successfully`);
          }
        } catch (err) {
          console.error('[Scheduler] Failed to cancel Shopify order:', err);
        }

        // Update our DB regardless of Shopify result (Odoo is the source of truth here)
        await query("UPDATE orders SET status = 'cancelled' WHERE id = $1", [row.id]);
      }
    }
  } catch (err) {
    console.error('[Scheduler] syncOdooCancellationsToShopify error:', err);
  }
}

// ── Feed-level scheduled imports ──────────────────────────────────────────

async function runScheduledFeedImports() {
  try {
    // Find feeds with sync_interval_minutes set that are due for import
    const result = await query(`
      SELECT f.id, f.client_id, f.type, f.name,
             f.spreadsheet_id, f.sheet_name, f.header_row, f.service_account_json,
             f.odoo_url, f.odoo_database, f.odoo_username, f.odoo_api_key,
             f.odoo_search_by, f.odoo_warehouse_id, f.sync_interval_minutes, f.last_sync_at
      FROM feeds f
      WHERE f.sync_interval_minutes IS NOT NULL
        AND f.sync_interval_minutes > 0
        AND (
          f.last_sync_at IS NULL
          OR f.last_sync_at < NOW() - (f.sync_interval_minutes || ' minutes')::interval
        )
    `);

    for (const feed of result.rows) {
      console.log(`[Scheduler] Auto-importing feed: ${feed.name} (every ${feed.sync_interval_minutes}m)`);
      // Mark as started by updating last_sync_at immediately to prevent duplicate runs
      await query('UPDATE feeds SET last_sync_at = NOW() WHERE id = $1', [feed.id]);
      // Run import async
      importFeedProducts(feed).catch(err => {
        console.error(`[Scheduler] Feed import failed for ${feed.name}:`, err);
      });
    }
  } catch (err) {
    console.error('[Scheduler] runScheduledFeedImports error:', err);
  }
}
