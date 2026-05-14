/**
 * Noon-specific routes
 * - Test connection
 * - Warehouses list
 * - Content export pipeline (start/status/download)
 * - FBN orders fetch
 */

import { Router } from 'express';
import { query } from '../db.js';
import { authenticate, type AuthRequest } from '../middleware/auth.js';

const router = Router();
router.use(authenticate);

// POST /api/noon/test-connection — test Noon credentials
router.post('/test-connection', async (req: AuthRequest, res) => {
  try {
    const { credentials_json, country_code } = req.body;
    if (!credentials_json || !country_code) {
      return res.status(400).json({ error: 'credentials_json and country_code required' });
    }
    const { testNoonConnection } = await import('../services/noonAuthService.js');
    const result = await testNoonConnection(credentials_json, country_code);
    return res.json(result);
  } catch (err) {
    console.error('Noon connection test failed:', err);
    return res.status(400).json({ error: err instanceof Error ? err.message : 'Connection failed' });
  }
});

// POST /api/noon/warehouses — list Noon warehouses
router.post('/warehouses', async (req: AuthRequest, res) => {
  try {
    const { credentials_json, country_code } = req.body;
    if (!credentials_json || !country_code) {
      return res.status(400).json({ error: 'credentials_json and country_code required' });
    }
    const { fetchNoonWarehouses } = await import('../services/noonAuthService.js');
    const warehouses = await fetchNoonWarehouses(credentials_json, country_code);
    return res.json(warehouses);
  } catch (err) {
    console.error('Noon warehouses fetch failed:', err);
    return res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to fetch warehouses' });
  }
});

// POST /api/noon/content/start — start content export pipeline
router.post('/content/start', async (req: AuthRequest, res) => {
  try {
    const { channel_id, feed_id } = req.body;
    if (!channel_id || !feed_id) {
      return res.status(400).json({ error: 'channel_id and feed_id required' });
    }
    const { startContentExport } = await import('../services/noonContentService.js');
    const result = await startContentExport(channel_id, feed_id);
    return res.json(result);
  } catch (err) {
    console.error('Noon content export start failed:', err);
    return res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to start content export' });
  }
});

// GET /api/noon/content/:id/status — check content job status
router.get('/content/:id/status', async (req: AuthRequest, res) => {
  try {
    const { checkContentExportStatus } = await import('../services/noonContentService.js');
    const result = await checkContentExportStatus(req.params.id);
    return res.json(result);
  } catch (err) {
    console.error('Noon content status check failed:', err);
    return res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to check status' });
  }
});

// GET /api/noon/content/:id/download — download generated CSV
router.get('/content/:id/download', async (req: AuthRequest, res) => {
  try {
    const { getContentJobStatus, generateContentCsv } = await import('../services/noonContentService.js');
    const job = await getContentJobStatus(req.params.id);
    if (!job) return res.status(404).json({ error: 'Content job not found' });

    const csv = await generateContentCsv(job.channel_id, job.feed_id, req.params.id);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="noon-content-${req.params.id}.csv"`);
    return res.send(csv);
  } catch (err) {
    console.error('Noon content download failed:', err);
    return res.status(500).json({ error: err instanceof Error ? err.message : 'Download failed' });
  }
});

// GET /api/noon/content/jobs?channel_id=xxx — list content jobs
router.get('/content/jobs', async (req: AuthRequest, res) => {
  try {
    const { channel_id } = req.query;
    if (!channel_id) return res.status(400).json({ error: 'channel_id required' });
    const { listContentJobs } = await import('../services/noonContentService.js');
    const jobs = await listContentJobs(String(channel_id));
    return res.json(jobs);
  } catch (err) {
    console.error('Noon content jobs list failed:', err);
    return res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to list jobs' });
  }
});

// GET /api/noon/orders?channel_id=xxx — list Noon FBN orders
router.get('/orders', async (req: AuthRequest, res) => {
  try {
    const { channel_id, status, limit = '50' } = req.query;
    if (!channel_id) return res.status(400).json({ error: 'channel_id required' });

    let whereClause = 'WHERE no.channel_id = $1';
    const params: unknown[] = [String(channel_id)];

    if (status && status !== 'all') {
      params.push(String(status));
      whereClause += ` AND no.status = $${params.length}`;
    }

    params.push(parseInt(String(limit)));
    const result = await query(
      `SELECT no.* FROM noon_orders no ${whereClause} ORDER BY no.created_at DESC LIMIT $${params.length}`,
      params
    );

    return res.json(result.rows);
  } catch (err) {
    console.error('Noon orders fetch failed:', err);
    return res.status(500).json({ error: 'Failed to fetch Noon orders' });
  }
});

// POST /api/noon/orders/fetch — fetch latest FBN orders from Noon API
router.post('/orders/fetch', async (req: AuthRequest, res) => {
  try {
    const { channel_id } = req.body;
    if (!channel_id) return res.status(400).json({ error: 'channel_id required' });

    const channelResult = await query(
      'SELECT * FROM channels WHERE id = $1',
      [channel_id]
    );
    const channel = channelResult.rows[0];
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    if (!channel.noon_credentials_json) return res.status(400).json({ error: 'Noon credentials not configured' });

    const { parseNoonCredentials, noonApiRequest } = await import('../services/noonAuthService.js');
    const credentials = parseNoonCredentials(channel.noon_credentials_json);
    const countryCode = channel.noon_country_code || 'AE';

    // Fetch recent orders from Noon (FBPI orders)
    const warehouseCode = channel.noon_warehouse_code || '';
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const ordersResult = await noonApiRequest(
      credentials,
      countryCode,
      'POST',
      '/fbpi/v1/fbpi-orders/list',
      {
        warehouse_code: warehouseCode,
        created_after: thirtyDaysAgo.toISOString(),
        created_before: now.toISOString(),
      }
    ) as { orders?: Array<Record<string, unknown>> };

    const orders = ordersResult?.orders || [];
    let newCount = 0;

    for (const order of orders) {
      const noonOrderId = String(order.fbpi_order_nr || order.order_id || order.orderId || '');
      if (!noonOrderId) continue;

      // Upsert
      const existing = await query(
        'SELECT id FROM noon_orders WHERE channel_id = $1 AND noon_order_id = $2',
        [channel_id, noonOrderId]
      );

      if (existing.rows.length === 0) {
        await query(
          `INSERT INTO noon_orders (client_id, channel_id, noon_order_id, noon_order_number, status, total_price, customer_name, country_code, raw_data)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            channel.client_id,
            channel_id,
            noonOrderId,
            String(order.mp_order_nr || order.order_number || order.orderNumber || ''),
            'synced',
            0,
            '',
            String(order.mp_country_code || countryCode),
            JSON.stringify(order),
          ]
        );
        newCount++;
      }
    }

    return res.json({ success: true, fetched: orders.length, new: newCount });
  } catch (err) {
    console.error('Noon orders fetch failed:', err);
    return res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to fetch orders' });
  }
});

export default router;
