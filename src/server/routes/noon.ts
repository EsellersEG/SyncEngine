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

// GET /api/noon/orders?channel_id=xxx — list Noon orders (FBN + FBP)
router.get('/orders', async (req: AuthRequest, res) => {
  try {
    const { channel_id, status, order_type, limit = '100' } = req.query;
    if (!channel_id) return res.status(400).json({ error: 'channel_id required' });

    let whereClause = 'WHERE no.channel_id = $1';
    const params: unknown[] = [String(channel_id)];

    if (status && status !== 'all') {
      params.push(String(status));
      whereClause += ` AND no.status = $${params.length}`;
    }

    if (order_type && order_type !== 'all') {
      params.push(String(order_type));
      whereClause += ` AND no.order_type = $${params.length}`;
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

// POST /api/noon/orders/fetch — fetch orders from Noon API
// body: { channel_id, order_type: 'fbn' | 'fbp' | 'both' }
router.post('/orders/fetch', async (req: AuthRequest, res) => {
  try {
    const { channel_id, order_type = 'both' } = req.body;
    if (!channel_id) return res.status(400).json({ error: 'channel_id required' });

    const channelResult = await query('SELECT * FROM channels WHERE id = $1', [channel_id]);
    const channel = channelResult.rows[0];
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    if (!channel.noon_credentials_json) return res.status(400).json({ error: 'Noon credentials not configured' });

    const { parseNoonCredentials, noonApiRequest } = await import('../services/noonAuthService.js');
    const credentials = parseNoonCredentials(channel.noon_credentials_json);
    const countryCode = channel.noon_country_code || 'AE';
    const warehouseCode = channel.noon_warehouse_code || '';

    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    let totalFetched = 0;
    let totalNew = 0;

    // ── FBN orders (Fulfilled by Noon — marketplace orders) ──
    if (order_type === 'fbn' || order_type === 'both') {
      try {
        console.log(`[NoonOrders] Fetching FBN orders for channel ${channel_id}...`);
        let page = 0;
        let hasMore = true;

        while (hasMore) {
          const searchResult = await noonApiRequest(
            credentials, countryCode, 'POST', '/order/v2/orders/search',
            { page, rows: 100, created_at_from: thirtyDaysAgo.toISOString(), created_at_to: now.toISOString() }
          ) as { data?: Array<Record<string, unknown>>; total_count?: number };

          const orders = searchResult?.data || [];
          totalFetched += orders.length;

          for (const order of orders) {
            const noonOrderId = String(order.order_nr || order.order_id || '');
            if (!noonOrderId) continue;

            const existing = await query(
              'SELECT id FROM noon_orders WHERE channel_id = $1 AND noon_order_id = $2',
              [channel_id, noonOrderId]
            );
            if (existing.rows.length === 0) {
              await query(
                `INSERT INTO noon_orders (client_id, channel_id, noon_order_id, noon_order_number, status, total_price, customer_name, country_code, order_type, raw_data)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
                [
                  channel.client_id, channel_id, noonOrderId,
                  String(order.order_nr || ''),
                  String(order.status || 'synced'),
                  parseFloat(String(order.total_amount || order.order_total || 0)) || 0,
                  String(order.customer_name || ''),
                  String(order.country_code || countryCode),
                  'fbn', JSON.stringify(order),
                ]
              );
              totalNew++;
            }
          }

          hasMore = orders.length >= 100;
          page++;
          if (page > 50) break; // safety limit
        }
        console.log(`[NoonOrders] FBN done: ${totalFetched} fetched, ${totalNew} new`);
      } catch (err) {
        console.error('[NoonOrders] FBN fetch error:', err);
      }
    }

    // ── FBP orders (Fulfilled by Partner — FBPI inbound orders) ──
    if (order_type === 'fbp' || order_type === 'both') {
      try {
        console.log(`[NoonOrders] Fetching FBP orders for channel ${channel_id}...`);
        const fbpResult = await noonApiRequest(
          credentials, countryCode, 'POST', '/fbpi/v1/fbpi-orders/list',
          { warehouse_code: warehouseCode, created_after: thirtyDaysAgo.toISOString(), created_before: now.toISOString() }
        ) as { orders?: Array<Record<string, unknown>> };

        const fbpOrders = fbpResult?.orders || [];
        totalFetched += fbpOrders.length;

        for (const order of fbpOrders) {
          const noonOrderId = String(order.fbpi_order_nr || order.order_id || order.orderId || '');
          if (!noonOrderId) continue;

          const existing = await query(
            'SELECT id FROM noon_orders WHERE channel_id = $1 AND noon_order_id = $2',
            [channel_id, noonOrderId]
          );
          if (existing.rows.length === 0) {
            await query(
              `INSERT INTO noon_orders (client_id, channel_id, noon_order_id, noon_order_number, status, total_price, customer_name, country_code, order_type, raw_data)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
              [
                channel.client_id, channel_id, noonOrderId,
                String(order.mp_order_nr || order.order_number || order.orderNumber || ''),
                'synced',
                parseFloat(String(order.total_amount || 0)) || 0,
                String(order.customer_name || ''),
                String(order.mp_country_code || countryCode),
                'fbp', JSON.stringify(order),
              ]
            );
            totalNew++;
          }
        }
        console.log(`[NoonOrders] FBP done: ${fbpOrders.length} fetched`);
      } catch (err) {
        console.error('[NoonOrders] FBP fetch error:', err);
      }
    }

    return res.json({ success: true, fetched: totalFetched, new: totalNew, order_type });
  } catch (err) {
    console.error('Noon orders fetch failed:', err);
    return res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to fetch orders' });
  }
});

export default router;
