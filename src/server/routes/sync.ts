import { Router } from 'express';
import { query } from '../db.js';
import { authenticate, type AuthRequest } from '../middleware/auth.js';
import { runSyncJob, cancelJob } from '../services/shopifySyncService.js';
import { runNoonSyncJob, cancelNoonJob } from '../services/noonSyncService.js';
import { runAmazonSyncJob, cancelAmazonJob } from '../services/amazonSyncService.js';

const router = Router();
router.use(authenticate);

// POST /api/sync/start — kick off a sync job
router.post('/start', async (req: AuthRequest, res) => {
  try {
    const { channel_id, feed_id, preset = 'sync_all', fields, filter_rules, include_images, workers } = req.body;
    if (!channel_id || !feed_id) {
      return res.status(400).json({ error: 'channel_id and feed_id required' });
    }

    // Validate channel exists
    const channelResult = await query(
      'SELECT * FROM channels WHERE id = $1',
      [channel_id]
    );
    const channel = channelResult.rows[0];
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    if (channel.type !== 'shopify' && channel.type !== 'noon' && channel.type !== 'amazon') {
      return res.status(400).json({ error: 'Only Shopify, Noon, and Amazon channels are supported' });
    }

    const feedResult = await query(
      'SELECT id, type, odoo_url, odoo_database, odoo_username, odoo_api_key, odoo_warehouse_id, odoo_warehouse_name FROM feeds WHERE id = $1',
      [feed_id]
    );
    const feed = feedResult.rows[0];
    if (!feed) return res.status(404).json({ error: 'Feed not found' });

    const effectivePreset = feed.type === 'odoo' ? 'price_stock_meta' : preset;

    // Resolve warehouse name: if ID is set but name is null, fetch from Odoo and persist it
    let resolvedWarehouseName: string | undefined = feed.odoo_warehouse_name || undefined;
    if (feed.odoo_warehouse_id && !feed.odoo_warehouse_name && feed.odoo_url && feed.odoo_database && feed.odoo_username && feed.odoo_api_key) {
      try {
        const { fetchOdooWarehouses } = await import('../services/odooService.js');
        const warehouses = await fetchOdooWarehouses({ url: feed.odoo_url, database: feed.odoo_database, username: feed.odoo_username, apiKey: feed.odoo_api_key });
        const wh = warehouses.find((w: { id: number; name: string }) => w.id === feed.odoo_warehouse_id);
        if (wh) {
          resolvedWarehouseName = wh.name;
          // Persist so we don't need to fetch again next time
          await query('UPDATE feeds SET odoo_warehouse_name = $1 WHERE id = $2', [wh.name, feed_id]);
        }
      } catch { /* ignore — fallback below */ }
    }

    const automationResult = await query(
      `SELECT price_adjustment_percent, rounding_mode
       FROM automations
       WHERE channel_id = $1
         AND feed_id = $2
         AND action_type = 'sync_to_shopify'
         AND is_active = true
       ORDER BY CASE WHEN trigger_type = 'after_import' THEN 0 ELSE 1 END, updated_at DESC, created_at DESC
       LIMIT 1`,
      [channel_id, feed_id]
    );
    const automationConfig = automationResult.rows[0];
    const priceAdjustmentPercent = Number(automationConfig?.price_adjustment_percent || 0);
    const priceRoundingMode = automationConfig?.rounding_mode === 'up' || automationConfig?.rounding_mode === 'down'
      ? automationConfig.rounding_mode
      : 'none';

    // Auto-fail stale running jobs (older than 15 minutes) so new syncs aren't blocked
    await query(
      `UPDATE sync_jobs SET status = 'failed', completed_at = NOW(),
              error_message = 'Job timed out — no progress for over 15 minutes'
       WHERE channel_id = $1 AND status = 'running'
         AND started_at < NOW() - INTERVAL '15 minutes'`,
      [channel_id]
    );

    // Check for already running job
    const running = await query(
      "SELECT id FROM sync_jobs WHERE channel_id = $1 AND status = 'running'",
      [channel_id]
    );
    if (running.rows.length > 0) {
      return res.status(409).json({ error: 'A sync job is already running for this channel', jobId: running.rows[0].id });
    }

    // Create job record
    const jobResult = await query(
      `INSERT INTO sync_jobs (channel_id, feed_id, triggered_by, preset, fields, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')
       RETURNING id`,
      [channel_id, feed_id, req.user!.id, effectivePreset, fields || null]
    );
    const jobId = jobResult.rows[0].id;

    res.json({ jobId, status: 'pending', message: 'Sync job started' });

    // Run async (don't await) — dispatch to appropriate sync engine
    if (channel.type === 'noon') {
      runNoonSyncJob({
        jobId,
        channel: {
          id: channel.id,
          client_id: channel.client_id,
          noon_credentials_json: channel.noon_credentials_json,
          noon_warehouse_code: channel.noon_warehouse_code,
          noon_country_code: channel.noon_country_code,
          settings: channel.settings,
        },
        feedId: feed_id,
        preset: effectivePreset,
        fields,
        priceAdjustmentPercent,
        priceRoundingMode,
      }).catch(err => {
        console.error(`[SyncRoute] Noon job ${jobId} crashed:`, err);
      });
    } else if (channel.type === 'amazon') {
      runAmazonSyncJob({
        jobId,
        channel: {
          id: channel.id,
          client_id: channel.client_id,
          amazon_credentials_json: channel.amazon_credentials_json,
          amazon_marketplace_ids: channel.amazon_marketplace_ids,
          amazon_region: channel.amazon_region,
          settings: channel.settings,
        },
        feedId: feed_id,
        preset: effectivePreset,
        fields,
        includeImages: !!include_images,
        priceAdjustmentPercent,
        priceRoundingMode,
      }).catch(err => {
        console.error(`[SyncRoute] Amazon job ${jobId} crashed:`, err);
      });
    } else {
      runSyncJob({
        jobId,
        channel,
        feedId: feed_id,
        preset: effectivePreset,
        fields,
        filterRules: filter_rules,
        includeImages: !!include_images,
        priceAdjustmentPercent,
        priceRoundingMode,
        warehouseName: resolvedWarehouseName,
        workers: (workers && effectivePreset === 'price_stock_meta') ? Math.min(Math.max(1, parseInt(String(workers), 10) || 1), 10) : 1,
      }).catch(err => {
        console.error(`[SyncRoute] Job ${jobId} crashed:`, err);
      });
    }

    return;
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to start sync' });
  }
});

// GET /api/sync/jobs?channel_id=xxx&feed_id=xxx
router.get('/jobs', async (req: AuthRequest, res) => {
  try {
    const { channel_id, feed_id, limit = '20' } = req.query;
    const isAdmin = req.user!.role === 'admin';
    const result = await query(
      `SELECT sj.id, sj.channel_id, sj.feed_id, sj.triggered_by, sj.preset, sj.fields,
              sj.status, sj.total_products, sj.created_count, sj.updated_count,
              sj.failed_count, sj.skipped_count, sj.started_at, sj.completed_at,
              sj.error_message, sj.created_at,
              u.name as triggered_by_name, ch.name as channel_name
       FROM sync_jobs sj
       LEFT JOIN users u ON sj.triggered_by = u.id
       LEFT JOIN channels ch ON sj.channel_id = ch.id
       ${isAdmin ? '' : 'JOIN user_clients uc ON uc.client_id = ch.client_id AND uc.user_id = $4'}
       WHERE ($1::uuid IS NULL OR sj.channel_id = $1::uuid)
         AND ($2::uuid IS NULL OR sj.feed_id = $2::uuid)
       ORDER BY sj.created_at DESC
       LIMIT $3`,
      isAdmin
        ? [channel_id || null, feed_id || null, parseInt(limit as string)]
        : [channel_id || null, feed_id || null, parseInt(limit as string), req.user!.id]
    );
    return res.json(result.rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch jobs' });
  }
});

// GET /api/sync/jobs/:id — get job status + logs
router.get('/jobs/:id', async (req, res) => {
  try {
    const jobResult = await query(
      `SELECT sj.id, sj.channel_id, sj.feed_id, sj.triggered_by, sj.preset, sj.fields,
              sj.status, sj.total_products, sj.created_count, sj.updated_count,
              sj.failed_count, sj.skipped_count, sj.started_at, sj.completed_at,
              sj.error_message, sj.created_at,
              u.name as triggered_by_name, ch.name as channel_name
       FROM sync_jobs sj
       LEFT JOIN users u ON sj.triggered_by = u.id
       LEFT JOIN channels ch ON sj.channel_id = ch.id
       WHERE sj.id = $1`,
      [req.params.id]
    );
    if (!jobResult.rows[0]) return res.status(404).json({ error: 'Job not found' });

    const logs = await query(
      'SELECT * FROM sync_logs WHERE job_id = $1 ORDER BY created_at DESC LIMIT 200',
      [req.params.id]
    );

    return res.json({ ...jobResult.rows[0], logs: logs.rows });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch job' });
  }
});

// POST /api/sync/jobs/:id/cancel
router.post('/jobs/:id/cancel', async (req, res) => {
  try {
    const result = await query(
      `UPDATE sync_jobs SET status = 'cancelled', completed_at = NOW()
       WHERE id = $1 AND status IN ('pending', 'running')
       RETURNING id`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Job not found or not cancellable' });
    // Signal the in-memory running loop to stop
    cancelJob(req.params.id);
    cancelNoonJob(req.params.id);
    cancelAmazonJob(req.params.id);
    return res.json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to cancel job' });
  }
});

// GET /api/sync/jobs/:id/logs — streaming logs
router.get('/jobs/:id/logs', async (req, res) => {
  try {
    const { page = '1', limit = '50', action } = req.query;
    const offset = (parseInt(page as string) - 1) * parseInt(limit as string);
    
    let whereClause = 'WHERE job_id = $1';
    const params: unknown[] = [req.params.id];
    
    if (action && action !== 'all') {
      whereClause += ` AND action = $${params.length + 1}`;
      params.push(action);
    }
    
    const result = await query(
      `SELECT * FROM sync_logs ${whereClause} ORDER BY created_at ASC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, parseInt(limit as string), offset]
    );
    
    const countResult = await query(
      `SELECT COUNT(*) FROM sync_logs ${whereClause}`,
      params
    );
    
    // Get action counts
    const countsResult = await query(
      `SELECT action, COUNT(*)::int as count FROM sync_logs WHERE job_id = $1 GROUP BY action`,
      [req.params.id]
    );
    
    return res.json({
      logs: result.rows,
      total: parseInt(countResult.rows[0].count),
      counts: countsResult.rows,
      page: parseInt(page as string),
      limit: parseInt(limit as string),
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch logs' });
  }
});

// POST /api/sync/preview-filter — preview how many products match filter rules
router.post('/preview-filter', async (req, res) => {
  try {
    const { feed_id, filter_rules } = req.body;
    if (!feed_id) return res.status(400).json({ error: 'feed_id required' });
    
    const productsResult = await query(
      'SELECT raw_data FROM products WHERE feed_id = $1 AND status = $2',
      [feed_id, 'active']
    );
    
    const total = productsResult.rows.length;
    let matched = 0;
    
    if (!filter_rules || filter_rules.length === 0) {
      matched = total;
    } else {
      for (const row of productsResult.rows) {
        if (evaluateRules(row.raw_data, filter_rules)) {
          matched++;
        }
      }
    }
    
    return res.json({ total, matched, filtered: total - matched });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to preview filter' });
  }
});

// GET /api/sync/feed-headers/:feedId — get column headers for filter rules
router.get('/feed-headers/:feedId', async (req, res) => {
  try {
    const result = await query(
      'SELECT raw_data FROM products WHERE feed_id = $1 LIMIT 1',
      [req.params.feedId]
    );
    if (!result.rows[0]) return res.json({ headers: [] });
    const headers = Object.keys(result.rows[0].raw_data);
    return res.json({ headers });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch headers' });
  }
});

// Helper: evaluate filter rules against product raw_data
function evaluateRules(rawData: Record<string, unknown>, rules: Array<{ field: string; operator: string; value: string; logic?: string }>): boolean {
  if (!rules || rules.length === 0) return true;
  
  // Group by OR logic: rules with logic='or' start a new group
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
      if (currentResult) return true; // previous AND group passed
      currentResult = ruleMatches;
    } else {
      currentResult = currentResult && ruleMatches;
    }
  }
  
  return currentResult;
}

// GET /api/sync/jobs/:id/export — export sync logs as CSV
router.get('/jobs/:id/export', async (req, res) => {
  try {
    const { action } = req.query;

    // Get job info (to determine preset for column set)
    const jobResult = await query(
      `SELECT sj.id, sj.preset, ch.name as channel_name, sj.created_at,
              f.odoo_warehouse_name, f.odoo_warehouse_id
       FROM sync_jobs sj
       LEFT JOIN channels ch ON sj.channel_id = ch.id
       LEFT JOIN feeds f ON sj.feed_id = f.id
       WHERE sj.id = $1`,
      [req.params.id]
    );
    if (!jobResult.rows[0]) return res.status(404).json({ error: 'Job not found' });
    const job = jobResult.rows[0];
    const isOdoo = job.preset === 'price_stock_meta';
    const warehouseLabel = job.odoo_warehouse_name || (job.odoo_warehouse_id ? `Warehouse #${job.odoo_warehouse_id}` : 'All Warehouses');

    // Fetch all logs (no page limit for export)
    let whereClause = 'WHERE job_id = $1';
    const params: unknown[] = [req.params.id];
    if (action && action !== 'all') {
      whereClause += ` AND action = $${params.length + 1}`;
      params.push(action);
    }
    const logsResult = await query(
      `SELECT sku, action, message, details, created_at FROM sync_logs ${whereClause} ORDER BY created_at ASC`,
      params
    );

    // Build CSV
    const escape = (v: unknown) => {
      const s = v == null ? '' : String(v);
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const baseHeaders = ['SKU', 'Status', 'Action', 'Message', 'Date & Time'];
    const odooHeaders = isOdoo ? ['Stock Before', 'Stock After', 'Price Before', 'Price After', 'Warehouse'] : [];
    const headers = [...baseHeaders, ...odooHeaders];

    const rows = logsResult.rows.map(log => {
      const status = log.action === 'created' || log.action === 'updated' ? 'Success'
        : log.action === 'failed' ? 'Failed' : 'Skipped';
      const d = log.details as { stock_from?: number | null; stock_to?: number | null; price_from?: string | null; price_to?: string | null; warehouse_name?: string | null } | null;
      const base = [
        escape(log.sku),
        escape(status),
        escape(log.action),
        escape(log.message),
        escape(new Date(log.created_at).toLocaleString()),
      ];
      const odoo = isOdoo ? [
        escape(d?.stock_from ?? ''),
        escape(d?.stock_to ?? ''),
        escape(d?.price_from ?? ''),
        escape(d?.price_to ?? ''),
        escape(d?.warehouse_name ?? warehouseLabel),
      ] : [];
      return [...base, ...odoo].join(',');
    });

    const csv = [headers.join(','), ...rows].join('\n');
    const filename = `sync-${job.preset}-${new Date(job.created_at).toISOString().slice(0,16).replace('T', '_')}.csv`;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(csv);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to export logs' });
  }
});

export default router;
