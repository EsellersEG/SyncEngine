/**
 * Amazon-specific routes
 * - Test connection
 * - List marketplaces
 * - Feed jobs list + status
 * - Orders list + fetch
 */

import { Router } from 'express';
import { query } from '../db.js';
import { authenticate, type AuthRequest } from '../middleware/auth.js';

const router = Router();
router.use(authenticate);

// POST /api/amazon/test-connection — test Amazon SP-API credentials
router.post('/test-connection', async (req: AuthRequest, res) => {
  try {
    const { credentials_json, region } = req.body;
    if (!credentials_json || !region) {
      return res.status(400).json({ error: 'credentials_json and region required' });
    }
    const { testAmazonConnection } = await import('../services/amazonAuthService.js');
    const result = await testAmazonConnection(credentials_json, region);
    return res.json(result);
  } catch (err) {
    console.error('Amazon connection test failed:', err);
    return res.status(400).json({ error: err instanceof Error ? err.message : 'Connection failed' });
  }
});

// POST /api/amazon/marketplaces — list available marketplaces for credentials
router.post('/marketplaces', async (req: AuthRequest, res) => {
  try {
    const { credentials_json, region } = req.body;
    if (!credentials_json || !region) {
      return res.status(400).json({ error: 'credentials_json and region required' });
    }
    const { parseAmazonCredentials, getMarketplaceParticipations } = await import('../services/amazonAuthService.js');
    const credentials = parseAmazonCredentials(credentials_json);
    const marketplaces = await getMarketplaceParticipations(credentials, region);
    return res.json(marketplaces);
  } catch (err) {
    console.error('Amazon marketplaces fetch failed:', err);
    return res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to fetch marketplaces' });
  }
});

// GET /api/amazon/feed-jobs?channel_id=xxx — list feed submission jobs
router.get('/feed-jobs', async (req: AuthRequest, res) => {
  try {
    const { channel_id, limit = '50' } = req.query;
    if (!channel_id) return res.status(400).json({ error: 'channel_id required' });

    const result = await query(
      `SELECT * FROM amazon_feed_jobs
       WHERE channel_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [String(channel_id), parseInt(String(limit), 10)]
    );
    return res.json(result.rows);
  } catch (err) {
    console.error('Amazon feed jobs list failed:', err);
    return res.status(500).json({ error: 'Failed to list feed jobs' });
  }
});

// GET /api/amazon/feed-jobs/:id/status — check a specific feed job status + refresh from Amazon
router.get('/feed-jobs/:id/status', async (req: AuthRequest, res) => {
  try {
    const jobResult = await query(
      `SELECT afj.*, ch.amazon_credentials_json, ch.amazon_region
       FROM amazon_feed_jobs afj
       JOIN channels ch ON ch.id = afj.channel_id
       WHERE afj.id = $1`,
      [req.params.id]
    );
    const job = jobResult.rows[0];
    if (!job) return res.status(404).json({ error: 'Feed job not found' });

    // If still processing, refresh from Amazon
    if (job.status === 'submitted' || job.status === 'processing') {
      if (job.amazon_feed_id && job.amazon_credentials_json) {
        try {
          const { parseAmazonCredentials } = await import('../services/amazonAuthService.js');
          const { checkFeedStatus } = await import('../services/amazonFeedsService.js');
          const credentials = parseAmazonCredentials(job.amazon_credentials_json);
          const status = await checkFeedStatus(credentials, job.amazon_region || 'eu', job.amazon_feed_id);

          if (status.processingStatus === 'DONE' || status.processingStatus === 'FATAL' || status.processingStatus === 'CANCELLED') {
            const newStatus = status.processingStatus === 'DONE' ? 'done' : status.processingStatus === 'FATAL' ? 'fatal' : 'cancelled';
            await query(
              `UPDATE amazon_feed_jobs SET status = $1, amazon_result_document_id = $2, completed_at = NOW() WHERE id = $3`,
              [newStatus, status.resultFeedDocumentId || null, job.id]
            );
            job.status = newStatus;
            job.amazon_result_document_id = status.resultFeedDocumentId;
          }
        } catch (refreshErr) {
          console.error('Failed to refresh feed status from Amazon:', refreshErr);
        }
      }
    }

    // Mask credentials from response
    delete job.amazon_credentials_json;

    return res.json(job);
  } catch (err) {
    console.error('Amazon feed job status check failed:', err);
    return res.status(500).json({ error: 'Failed to check feed job status' });
  }
});

// GET /api/amazon/orders?channel_id=xxx — list Amazon orders
router.get('/orders', async (req: AuthRequest, res) => {
  try {
    const { channel_id, status, limit = '50' } = req.query;
    if (!channel_id) return res.status(400).json({ error: 'channel_id required' });

    let whereClause = 'WHERE ao.channel_id = $1';
    const params: unknown[] = [String(channel_id)];

    if (status && status !== 'all') {
      params.push(String(status));
      whereClause += ` AND ao.status = $${params.length}`;
    }

    params.push(parseInt(String(limit), 10));
    const result = await query(
      `SELECT ao.id, ao.amazon_order_id, ao.amazon_order_number, ao.status,
              ao.order_status, ao.total_price, ao.currency, ao.customer_name,
              ao.marketplace_id, ao.fulfillment_channel, ao.synced_at, ao.created_at
       FROM amazon_orders ao
       ${whereClause}
       ORDER BY ao.created_at DESC
       LIMIT $${params.length}`,
      params
    );
    return res.json(result.rows);
  } catch (err) {
    console.error('Amazon orders list failed:', err);
    return res.status(500).json({ error: 'Failed to list orders' });
  }
});

// POST /api/amazon/orders/fetch — trigger order poll for a channel
router.post('/orders/fetch', async (req: AuthRequest, res) => {
  try {
    const { channel_id } = req.body;
    if (!channel_id) return res.status(400).json({ error: 'channel_id required' });

    const { syncAmazonOrders } = await import('../services/amazonOrdersService.js');
    const result = await syncAmazonOrders(String(channel_id));
    return res.json(result);
  } catch (err) {
    console.error('Amazon order fetch failed:', err);
    return res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to fetch orders' });
  }
});

export default router;
