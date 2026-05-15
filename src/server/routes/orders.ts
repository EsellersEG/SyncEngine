import { Router } from 'express';
import { query } from '../db.js';
import { authenticate, type AuthRequest, requireOrderOwnerOrAdmin } from '../middleware/auth.js';
import { createOdooSaleOrder, type OdooConfig } from '../services/odooService.js';

const router = Router();
router.use(authenticate);

// GET /api/orders/export — download all orders as CSV
router.get('/export', async (req: AuthRequest, res) => {
  try {
    const { channel_id, status } = req.query;
    const isAdmin = req.user!.role === 'admin';

    // Shopify orders
    const shopifyResult = await query(
      `SELECT o.*, ch.name as channel_name, 'shopify' as source
       FROM orders o
       LEFT JOIN channels ch ON o.channel_id = ch.id
       ${isAdmin ? '' : 'JOIN user_clients uc ON uc.client_id = o.client_id AND uc.user_id = $3'}
       WHERE ($1::uuid IS NULL OR o.channel_id = $1::uuid)
         AND ($2::text IS NULL OR o.status = $2::text)
       ORDER BY o.created_at DESC
       LIMIT 10000`,
      isAdmin ? [channel_id || null, status || null] : [channel_id || null, status || null, req.user!.id]
    );

    // Noon orders
    const noonResult = await query(
      `SELECT no.*, ch.name as channel_name, 'noon' as source
       FROM noon_orders no
       LEFT JOIN channels ch ON no.channel_id = ch.id
       ${isAdmin ? '' : 'JOIN user_clients uc ON uc.client_id = no.client_id AND uc.user_id = $3'}
       WHERE ($1::uuid IS NULL OR no.channel_id = $1::uuid)
         AND ($2::text IS NULL OR no.status = $2::text)
       ORDER BY no.created_at DESC
       LIMIT 10000`,
      isAdmin ? [channel_id || null, status || null] : [channel_id || null, status || null, req.user!.id]
    );

    const allOrders = [...shopifyResult.rows, ...noonResult.rows]
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    const escape = (v: unknown) => {
      if (v == null) return '';
      const s = String(v).replace(/"/g, '""');
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s}"` : s;
    };

    const headers = ['Source', 'Order #', 'Customer', 'Total Price', 'Status', 'Odoo Order', 'Channel', 'Error', 'Synced At', 'Created At', 'Items'];
    const rows = allOrders.map(o => {
      const isNoon = o.source === 'noon';
      const items = isNoon
        ? (o.raw_data?.items || []).map((li: { name: string; quantity: number; price: number }) => `${li.name} x${li.quantity} @ ${li.price}`).join(' | ')
        : (o.raw_data?.line_items || []).map((li: { name: string; quantity: number; price: string }) => `${li.name} x${li.quantity} @ ${li.price}`).join(' | ');
      return [
        isNoon ? 'Noon' : 'Shopify',
        isNoon ? (o.noon_order_number || o.noon_order_id) : o.shopify_order_number,
        isNoon ? o.customer_name : o.customer_email,
        o.total_price,
        o.status,
        o.odoo_order_name || o.odoo_order_id || '',
        o.channel_name || '',
        o.error_message || '',
        o.synced_at ? new Date(o.synced_at).toLocaleString() : '',
        new Date(o.created_at).toLocaleString(),
        items,
      ].map(escape).join(',');
    });

    const csv = [headers.join(','), ...rows].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="orders-${new Date().toISOString().slice(0, 10)}.csv"`);
    return res.send(csv);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Export failed' });
  }
});

// GET /api/orders — list orders
router.get('/', async (req: AuthRequest, res) => {
  try {
    const { channel_id, status, source } = req.query;
    const isAdmin = req.user!.role === 'admin';

    // Fetch Shopify→Odoo orders
    const shopifyOrders = (source && source !== 'shopify') ? { rows: [] } : await query(
      `SELECT o.*, ch.name as channel_name, 'shopify' as source
       FROM orders o
       LEFT JOIN channels ch ON o.channel_id = ch.id
       ${isAdmin ? '' : 'JOIN user_clients uc ON uc.client_id = o.client_id AND uc.user_id = $3'}
       WHERE ($1::uuid IS NULL OR o.channel_id = $1::uuid)
         AND ($2::text IS NULL OR o.status = $2::text)
       ORDER BY o.created_at DESC`,
      isAdmin
        ? [channel_id || null, status || null]
        : [channel_id || null, status || null, req.user!.id]
    );

    // Fetch Noon orders
    const noonOrders = (source && source !== 'noon') ? { rows: [] } : await query(
      `SELECT no.id, no.client_id, no.channel_id, no.noon_order_id, no.noon_order_number,
              no.status, no.total_price, no.customer_name, no.country_code,
              no.raw_data, no.error_message, no.synced_at, no.created_at,
              no.order_type, no.shopify_order_id, no.shopify_channel_id,
              ch.name as channel_name, 'noon' as source
       FROM noon_orders no
       LEFT JOIN channels ch ON no.channel_id = ch.id
       ${isAdmin ? '' : 'JOIN user_clients uc ON uc.client_id = no.client_id AND uc.user_id = $3'}
       WHERE ($1::uuid IS NULL OR no.channel_id = $1::uuid)
         AND ($2::text IS NULL OR no.status = $2::text)
       ORDER BY no.created_at DESC`,
      isAdmin
        ? [channel_id || null, status || null]
        : [channel_id || null, status || null, req.user!.id]
    );

    // Merge and sort by created_at descending
    const all = [...shopifyOrders.rows, ...noonOrders.rows]
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    return res.json(all);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// GET /api/orders/:id — single order with full raw_data
router.get('/:id', async (req: AuthRequest, res) => {
  try {
    // Try shopify orders first
    const result = await query(
      `SELECT o.*, ch.name as channel_name, ch.shopify_store_url, 'shopify' as source
       FROM orders o
       LEFT JOIN channels ch ON o.channel_id = ch.id
       WHERE o.id = $1`,
      [req.params.id]
    );
    if (result.rows[0]) return res.json(result.rows[0]);

    // Try noon orders
    const noonResult = await query(
      `SELECT no.*, ch.name as channel_name, 'noon' as source
       FROM noon_orders no
       LEFT JOIN channels ch ON no.channel_id = ch.id
       WHERE no.id = $1`,
      [req.params.id]
    );
    if (noonResult.rows[0]) return res.json(noonResult.rows[0]);

    return res.status(404).json({ error: 'Order not found' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch order' });
  }
});

// POST /api/orders/:id/retry — retry failed order sync to Odoo
router.post('/:id/retry', requireOrderOwnerOrAdmin, async (req: AuthRequest, res) => {
  try {
    const orderResult = await query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
    const order = orderResult.rows[0];
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status === 'synced') return res.status(400).json({ error: 'Order already synced' });

    // Get Odoo config from feed
    const feedResult = await query(
      "SELECT odoo_url, odoo_database, odoo_username, odoo_api_key, odoo_search_by, odoo_warehouse_id, order_tax_included_percent, odoo_force_order FROM feeds WHERE client_id = $1 AND type = 'odoo' LIMIT 1",
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
      warehouseId: odooFeed.odoo_warehouse_id || undefined,
      orderTaxIncludedPercent: odooFeed.order_tax_included_percent ? Number(odooFeed.order_tax_included_percent) : undefined,
      forceOrder: !!odooFeed.odoo_force_order,
    };

    // Get channel for Shopify API access (needed for EAN barcode lookup)
    const channelResult = await query(
      'SELECT shopify_store_url, shopify_access_token, shopify_api_version FROM channels WHERE id = $1',
      [order.channel_id]
    );
    const channel = channelResult.rows[0];

    const rawData = order.raw_data;
    const lineItems = rawData.line_items || [];

    // Always fetch barcodes from Shopify variants — barcode is the most reliable Odoo match key
    let barcodeMap = new Map<string, string>();
    if (channel) {
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
        // Prefer barcode from Shopify, fall back to line item SKU field
        const lookupKey = barcodeMap.get(variantId) || String(li.sku || '');
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
