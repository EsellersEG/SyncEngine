/**
 * Feed Scheduler Service
 * Periodically checks feeds with sync_interval_minutes set and triggers auto-import.
 */

import { query } from '../db.js';
import { importFeedProducts } from './feedService.js';

let schedulerInterval: ReturnType<typeof setInterval> | null = null;

export function startScheduler() {
  if (schedulerInterval) return;

  // Check every 60 seconds for feeds that need importing
  schedulerInterval = setInterval(async () => {
    try {
      const result = await query(
        `SELECT f.*, c.name as client_name
         FROM feeds f
         JOIN clients c ON f.client_id = c.id
         WHERE f.sync_interval_minutes IS NOT NULL
           AND f.sync_interval_minutes > 0
           AND f.is_active = true
           AND (
             f.last_sync_at IS NULL
             OR f.last_sync_at < NOW() - (f.sync_interval_minutes || ' minutes')::interval
           )`
      );

      for (const feed of result.rows) {
        console.log(`[Scheduler] Auto-importing feed: ${feed.name} (${feed.client_name})`);
        try {
          await importFeedProducts(feed.id);
        } catch (err) {
          console.error(`[Scheduler] Failed to import feed ${feed.name}:`, err);
        }
      }
    } catch (err) {
      console.error('[Scheduler] Error checking feeds:', err);
    }
  }, 60_000);

  console.log('[Scheduler] Started — checking feeds every 60s');
}

export function stopScheduler() {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    console.log('[Scheduler] Stopped');
  }
}
