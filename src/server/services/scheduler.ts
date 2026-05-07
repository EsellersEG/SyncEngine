/**
 * Automation Scheduler Service
 * Runs automations based on their configured intervals.
 * Replaces the old per-feed sync_interval approach.
 */

import { query } from '../db.js';
import { importFeedProducts } from './feedService.js';
import { runSyncJob } from './shopifySyncService.js';

let schedulerInterval: ReturnType<typeof setInterval> | null = null;

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
          ch.name as channel_name, ch.platform, ch.shop_domain, ch.api_token,
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
          } else if (automation.action_type === 'sync_to_shopify' && automation.channel_id) {
            console.log(`[Scheduler] Running automation: ${automation.name} (sync to ${automation.channel_name})`);
            // Create a sync job
            const jobResult = await query(
              `INSERT INTO sync_jobs (client_id, channel_id, status, preset, total_products)
               VALUES ($1, $2, 'pending', 'sync_all', 0)
               RETURNING id`,
              [automation.client_id, automation.channel_id]
            );
            const jobId = jobResult.rows[0].id;
            // Run it async
            runSyncJob(jobId).catch(err => {
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

  console.log('[Scheduler] Started — checking automations every 60s');
}

export function stopScheduler() {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    console.log('[Scheduler] Stopped');
  }
}
