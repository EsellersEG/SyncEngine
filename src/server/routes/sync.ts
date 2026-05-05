import { Router } from 'express';
import { query } from '../db.js';
import { authenticate, type AuthRequest } from '../middleware/auth.js';
import { runSyncJob } from '../services/shopifySyncService.js';

const router = Router();
router.use(authenticate);

// POST /api/sync/start — kick off a sync job
router.post('/start', async (req: AuthRequest, res) => {
  try {
    const { channel_id, feed_id, preset = 'sync_all', fields } = req.body;
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
    runSyncJob({ jobId, channel, feedId: feed_id, preset, fields }).catch(err => {
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
      `SELECT sj.*, u.name as triggered_by_name, ch.name as channel_name
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
      `SELECT sj.*, u.name as triggered_by_name, ch.name as channel_name
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
    const result = await query(
      'SELECT * FROM sync_logs WHERE job_id = $1 ORDER BY created_at ASC',
      [req.params.id]
    );
    return res.json(result.rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch logs' });
  }
});

export default router;
