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

// GET /api/orders/:id — single order with full raw_data
router.get('/:id', async (req: AuthRequest, res) => {
  try {
    const result = await query(
      `SELECT o.*, ch.name as channel_name, ch.shopify_store_url
       FROM orders o
       LEFT JOIN channels ch ON o.channel_id = ch.id
       WHERE o.id = $1`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Order not found' });
    return res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch order' });
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
      "SELECT odoo_url, odoo_database, odoo_username, odoo_api_key, odoo_search_by FROM feeds WHERE client_id = $1 AND type = 'odoo' LIMIT 1",
      [order.client_id]
    );
    const odooFeed = feedResult.rows[0];
    if (!odooFeed) return res.status(400).json({ error: 'No Odoo feed configured for this client' });

    const config: OdooConfig = {
      url: odooFeed.odoo_url,
      database: odooFeed.odoo_database,
      username: odooFeed.odoo_username,
      apiKey: odooFeed.odoo_api_key,
      productSearchBy: odooFeed.odoo_search_by || 'automatic',
    };

    // Get channel for Shopify API access (needed for EAN barcode lookup)
    const channelResult = await query(
      'SELECT shopify_store_url, shopify_access_token, shopify_api_version FROM channels WHERE id = $1',
      [order.channel_id]
    );
    const channel = channelResult.rows[0];

    const rawData = order.raw_data;
    const lineItems = rawData.line_items || [];

    // If EAN mode, fetch barcodes from Shopify
    let barcodeMap = new Map<string, string>();
    if (config.productSearchBy === 'ean' && channel) {
      const variantIds = lineItems
        .map((li: Record<string, unknown>) => String(li.variant_id || ''))
        .filter(Boolean);
      if (variantIds.length > 0) {
        const gids = variantIds.map((id: string) => `gid://shopify/ProductVariant/${id}`);
        const gqlQuery = `query getVariants($ids: [ID!]!) { nodes(ids: $ids) { ... on ProductVariant { id barcode } } }`;
        const storeDomain = channel.shopify_store_url.replace(/^https?:\/\//, '').replace(/\/$/, '');
        const url = `https://${storeDomain}/admin/api/${channel.shopify_api_version}/graphql.json`;
        try {
          const gqlRes = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': channel.shopify_access_token },
            body: JSON.stringify({ query: gqlQuery, variables: { ids: gids } }),
          });
          const json = await gqlRes.json() as { data?: { nodes: Array<{ id: string; barcode: string | null }> } };
          if (json.data?.nodes) {
            for (const node of json.data.nodes) {
              if (node?.barcode) {
                barcodeMap.set(node.id.replace('gid://shopify/ProductVariant/', ''), node.barcode);
              }
            }
          }
        } catch (e) { console.error('[Orders] Failed to fetch barcodes:', e); }
      }
    }

    const result = await createOdooSaleOrder(config, {
      email: String(rawData.email || ''),
      name: String(rawData.name || rawData.order_number || ''),
      total_price: String(rawData.total_price || '0'),
      line_items: lineItems.map((li: Record<string, unknown>) => {
        const variantId = String(li.variant_id || '');
        const lookupKey = (config.productSearchBy === 'ean' && barcodeMap.get(variantId))
          ? barcodeMap.get(variantId)!
          : String(li.sku || '');
        return {
          sku: lookupKey,
          name: String(li.name || ''),
          quantity: Number(li.quantity) || 1,
          price: String(li.price || '0'),
          discount_allocations: li.discount_allocations as Array<{ amount: string }> | undefined,
        };
      }),
      shipping_address: rawData.shipping_address,
    });

    await query(
      "UPDATE orders SET status = 'synced', odoo_order_id = $1, odoo_order_name = $2, synced_at = NOW(), error_message = NULL WHERE id = $3",
      [result.odooOrderId, result.odooOrderName, req.params.id]
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
