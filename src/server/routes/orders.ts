import { Router } from 'express';
import { query } from '../db.js';
import { authenticate, type AuthRequest } from '../middleware/auth.js';
import { createOdooSaleOrder, type OdooConfig } from '../services/odooService.js';

const router = Router();
router.use(authenticate);

// GET /api/orders — list orders
router.get('/', async (req: AuthRequest, res) => {
  try {
    const { channel_id, status, limit = '100' } = req.query;
    const result = await query(
      `SELECT o.*, ch.name as channel_name
       FROM orders o
       LEFT JOIN channels ch ON o.channel_id = ch.id
       WHERE ($1::uuid IS NULL OR o.channel_id = $1::uuid)
         AND ($2::text IS NULL OR o.status = $2::text)
       ORDER BY o.created_at DESC
       LIMIT $3`,
      [channel_id || null, status || null, parseInt(limit as string)]
    );
    return res.json(result.rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// POST /api/orders/:id/retry — retry failed order sync to Odoo
router.post('/:id/retry', async (req: AuthRequest, res) => {
  try {
    const orderResult = await query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
    const order = orderResult.rows[0];
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status === 'synced') return res.status(400).json({ error: 'Order already synced' });

    // Get Odoo config from feed
    const feedResult = await query(
      "SELECT odoo_url, odoo_database, odoo_username, odoo_api_key FROM feeds WHERE client_id = $1 AND type = 'odoo' LIMIT 1",
      [order.client_id]
    );
    const odooFeed = feedResult.rows[0];
    if (!odooFeed) return res.status(400).json({ error: 'No Odoo feed configured for this client' });

    const config: OdooConfig = {
      url: odooFeed.odoo_url,
      database: odooFeed.odoo_database,
      username: odooFeed.odoo_username,
      apiKey: odooFeed.odoo_api_key,
    };

    const rawData = order.raw_data;
    const result = await createOdooSaleOrder(config, {
      email: String(rawData.email || ''),
      name: String(rawData.name || rawData.order_number || ''),
      total_price: String(rawData.total_price || '0'),
      line_items: (rawData.line_items || []).map((li: Record<string, unknown>) => ({
        sku: String(li.sku || ''),
        name: String(li.name || ''),
        quantity: Number(li.quantity) || 1,
        price: String(li.price || '0'),
        discount_allocations: li.discount_allocations as Array<{ amount: string }> | undefined,
      })),
      shipping_address: rawData.shipping_address,
    });

    await query(
      "UPDATE orders SET status = 'synced', odoo_order_id = $1, synced_at = NOW(), error_message = NULL WHERE id = $2",
      [result.odooOrderId, req.params.id]
    );

    return res.json({ success: true, odooOrderId: result.odooOrderId, odooOrderName: result.odooOrderName });
  } catch (err) {
    await query(
      "UPDATE orders SET error_message = $1 WHERE id = $2",
      [String(err), req.params.id]
    );
    console.error('Order retry failed:', err);
    return res.status(500).json({ error: err instanceof Error ? err.message : 'Retry failed' });
  }
});

export default router;
