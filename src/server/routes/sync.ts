import { Router } from 'express';
import { query } from '../db.js';
import { authenticate, type AuthRequest } from '../middleware/auth.js';
import { runSyncJob } from '../services/shopifySyncService.js';

const router = Router();
router.use(authenticate);

// POST /api/sync/start — kick off a sync job
router.post('/start', async (req: AuthRequest, res) => {
  try {
    const { channel_id, feed_id, preset = 'sync_all', fields, filter_rules } = req.body;
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
    if (channel.type !== 'shopify') {
      return res.status(400).json({ error: 'Only Shopify channels supported in Phase 1' });
    }

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
      [channel_id, feed_id, req.user!.id, preset, fields || null]
    );
    const jobId = jobResult.rows[0].id;

    res.json({ jobId, status: 'pending', message: 'Sync job started' });

    // Run async (don't await)
    runSyncJob({ jobId, channel, feedId: feed_id, preset, fields, filterRules: filter_rules }).catch(err => {
      console.error(`[SyncRoute] Job ${jobId} crashed:`, err);
    });

    return;
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to start sync' });
  }
});

// GET /api/sync/jobs?channel_id=xxx&feed_id=xxx
router.get('/jobs', async (req, res) => {
  try {
    const { channel_id, feed_id, limit = '20' } = req.query;
    const result = await query(
      `SELECT sj.id, sj.channel_id, sj.feed_id, sj.triggered_by, sj.preset, sj.fields,
              sj.status, sj.total_products, sj.created_count, sj.updated_count,
              sj.failed_count, sj.skipped_count, sj.started_at, sj.completed_at,
              sj.error_message, sj.created_at,
              u.name as triggered_by_name, ch.name as channel_name
       FROM sync_jobs sj
       LEFT JOIN users u ON sj.triggered_by = u.id
       LEFT JOIN channels ch ON sj.channel_id = ch.id
       WHERE ($1::uuid IS NULL OR sj.channel_id = $1::uuid)
         AND ($2::uuid IS NULL OR sj.feed_id = $2::uuid)
       ORDER BY sj.created_at DESC
       LIMIT $3`,
      [channel_id || null, feed_id || null, parseInt(limit as string)]
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

export default router;
