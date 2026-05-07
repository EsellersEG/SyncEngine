/**
 * Shopify Webhooks Route
 * Handles incoming webhooks from Shopify (orders, etc.)
 * NO authentication middleware — uses HMAC verification instead.
 */

import { Router, type Request, type Response } from 'express';
import crypto from 'crypto';
import { query } from '../db.js';
import { createOdooSaleOrder, type OdooConfig } from '../services/odooService.js';

const router = Router();

// Verify Shopify HMAC signature
function verifyShopifyHmac(body: string, hmacHeader: string, secret: string): boolean {
  const hash = crypto.createHmac('sha256', secret).update(body, 'utf8').digest('base64');
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(hmacHeader));
}

// POST /webhooks/shopify/orders — Shopify order created webhook
router.post('/shopify/orders', async (req: Request, res: Response) => {
  const hmac = req.headers['x-shopify-hmac-sha256'] as string;
  const shopDomain = req.headers['x-shopify-shop-domain'] as string;

  // Respond immediately (Shopify requires fast response)
  res.status(200).json({ received: true });

  try {
    // Find channel by shop domain
    const channelResult = await query(
      "SELECT c.*, cl.odoo_config FROM channels c LEFT JOIN clients cl ON c.client_id = cl.id WHERE c.shopify_store_url = $1 AND c.type = 'shopify'",
      [shopDomain]
    );
    const channel = channelResult.rows[0];
    if (!channel) {
      console.warn(`[Webhook] No channel found for shop: ${shopDomain}`);
      return;
    }

    // Verify HMAC if we have a webhook secret in channel settings
    if (channel.settings?.webhook_secret && hmac) {
      const rawBody = (req as unknown as Record<string, unknown>).rawBody as string || JSON.stringify(req.body);
      if (!verifyShopifyHmac(rawBody, hmac, channel.settings.webhook_secret)) {
        console.warn(`[Webhook] HMAC verification failed for shop: ${shopDomain}`);
        return;
      }
    }

    const order = req.body;
    const shopifyOrderId = String(order.id);
    const orderNumber = order.name || `#${order.order_number}`;

    // Check if already processed
    const existing = await query(
      'SELECT id FROM orders WHERE channel_id = $1 AND shopify_order_id = $2',
      [channel.id, shopifyOrderId]
    );
    if (existing.rows.length > 0) {
      console.log(`[Webhook] Order ${orderNumber} already processed, skipping`);
      return;
    }

    // Insert order record
    await query(
      `INSERT INTO orders (client_id, channel_id, shopify_order_id, shopify_order_number, total_price, customer_email, raw_data, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')`,
      [channel.client_id, channel.id, shopifyOrderId, orderNumber, order.total_price, order.email, JSON.stringify(order)]
    );

    // Sync to Odoo if config exists
    const odooConfig = channel.odoo_config as OdooConfig | null;
    if (!odooConfig || !odooConfig.url) {
      // Try to get Odoo config from an Odoo feed for this client
      const feedResult = await query(
        "SELECT odoo_url, odoo_database, odoo_username, odoo_api_key, odoo_search_by FROM feeds WHERE client_id = $1 AND type = 'odoo' LIMIT 1",
        [channel.client_id]
      );
      const odooFeed = feedResult.rows[0];
      if (!odooFeed) {
        console.log(`[Webhook] No Odoo config found for order ${orderNumber}, saved as pending`);
        return;
      }
      // Use feed's Odoo config
      const config: OdooConfig = {
        url: odooFeed.odoo_url,
        database: odooFeed.odoo_database,
        username: odooFeed.odoo_username,
        apiKey: odooFeed.odoo_api_key,
        productSearchBy: odooFeed.odoo_search_by || 'automatic',
      };
      await syncOrderToOdoo(channel.id, shopifyOrderId, order, config);
    } else {
      await syncOrderToOdoo(channel.id, shopifyOrderId, order, odooConfig);
    }
  } catch (err) {
    console.error('[Webhook] Error processing order:', err);
  }
});

async function syncOrderToOdoo(channelId: string, shopifyOrderId: string, order: Record<string, unknown>, config: OdooConfig) {
  try {
    const result = await createOdooSaleOrder(config, {
      email: String(order.email || ''),
      name: String(order.name || order.order_number || ''),
      total_price: String(order.total_price || '0'),
      line_items: ((order.line_items as Array<Record<string, unknown>>) || []).map(li => ({
        sku: String(li.sku || ''),
        name: String(li.name || ''),
        quantity: Number(li.quantity) || 1,
        price: String(li.price || '0'),
        discount_allocations: li.discount_allocations as Array<{ amount: string }> | undefined,
      })),
      shipping_address: order.shipping_address as {
        first_name?: string; last_name?: string; address1?: string;
        address2?: string; city?: string; zip?: string; country?: string; phone?: string;
      } | undefined,
    });

    await query(
      "UPDATE orders SET status = 'synced', odoo_order_id = $1, synced_at = NOW() WHERE channel_id = $2 AND shopify_order_id = $3",
      [result.odooOrderId, channelId, shopifyOrderId]
    );
    console.log(`[Webhook] Order synced to Odoo: ${result.odooOrderName}`);
  } catch (err) {
    await query(
      "UPDATE orders SET status = 'failed', error_message = $1 WHERE channel_id = $2 AND shopify_order_id = $3",
      [String(err), channelId, shopifyOrderId]
    );
    console.error(`[Webhook] Failed to sync order to Odoo:`, err);
  }
}

export default router;
