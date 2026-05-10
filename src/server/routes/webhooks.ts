/**
 * Shopify Webhooks Route
 * Handles incoming webhooks from Shopify (orders, etc.)
 * NO authentication middleware — uses HMAC verification instead.
 */

import { Router, type Request, type Response } from 'express';
import crypto from 'crypto';
import { query } from '../db.js';
import { createOdooSaleOrder, cancelOdooSaleOrder, type OdooConfig } from '../services/odooService.js';

const router = Router();

// Verify Shopify HMAC signature
function verifyShopifyHmac(body: string, hmacHeader: string, secret: string): boolean {
  const hash = crypto.createHmac('sha256', secret).update(body, 'utf8').digest('base64');
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(hmacHeader));
}

// POST /webhooks/shopify/orders — Shopify order created webhook
router.post('/shopify/orders', async (req: Request, res: Response) => {
  const hmac = req.headers['x-shopify-hmac-sha256'] as string;
  const shopDomain = (req.headers['x-shopify-shop-domain'] as string || '').trim().toLowerCase();

  console.log(`[Webhook] Received order webhook from shop: ${shopDomain}`);

  // Respond immediately (Shopify requires fast response)
  res.status(200).json({ received: true });

  try {
    // Find channel by shop domain (normalize: strip https://, trim, lowercase)
    const channelResult = await query(
      "SELECT c.* FROM channels c WHERE LOWER(TRIM(REPLACE(REPLACE(c.shopify_store_url, 'https://', ''), 'http://', ''))) = $1 AND c.type = 'shopify'",
      [shopDomain]
    );
    const channel = channelResult.rows[0];
    if (!channel) {
      console.warn(`[Webhook] No channel found for shop: ${shopDomain}`);
      return;
    }
    console.log(`[Webhook] Matched channel: ${channel.name} (id: ${channel.id})`);


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

    // Sync to Odoo if config exists (get from Odoo feed for this client)
    const feedResult = await query(
      "SELECT odoo_url, odoo_database, odoo_username, odoo_api_key, odoo_search_by, odoo_warehouse_id, order_tax_included_percent FROM feeds WHERE client_id = $1 AND type = 'odoo' LIMIT 1",
      [channel.client_id]
    );
    const odooFeed = feedResult.rows[0];
    if (!odooFeed) {
      console.log(`[Webhook] No Odoo config found for order ${orderNumber}, saved as pending`);
      return;
    }
    const config: OdooConfig = {
      url: odooFeed.odoo_url,
      database: odooFeed.odoo_database,
      username: odooFeed.odoo_username,
      apiKey: odooFeed.odoo_api_key,
      productSearchBy: odooFeed.odoo_search_by || 'automatic',
      warehouseId: odooFeed.odoo_warehouse_id || undefined,
      orderTaxIncludedPercent: odooFeed.order_tax_included_percent ? Number(odooFeed.order_tax_included_percent) : undefined,
    };
    await syncOrderToOdoo(channel, shopifyOrderId, order, config);
  } catch (err) {
    console.error('[Webhook] Error processing order:', err);
  }
});

// Fetch variant barcodes from Shopify when EAN matching is needed
async function getShopifyVariantBarcodes(
  channel: { shopify_store_url: string; shopify_access_token: string; shopify_api_version: string },
  variantIds: string[]
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (variantIds.length === 0) return map;

  // Query Shopify for variant barcodes
  const gqlQuery = `
    query getVariants($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on ProductVariant {
          id
          barcode
        }
      }
    }`;

  const gids = variantIds.map(id => `gid://shopify/ProductVariant/${id}`);
  const storeDomain = channel.shopify_store_url.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const url = `https://${storeDomain}/admin/api/${channel.shopify_api_version}/graphql.json`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': channel.shopify_access_token,
      },
      body: JSON.stringify({ query: gqlQuery, variables: { ids: gids } }),
    });
    const json = await res.json() as { data?: { nodes: Array<{ id: string; barcode: string | null }> } };
    if (json.data?.nodes) {
      for (const node of json.data.nodes) {
        if (node?.barcode) {
          // Extract numeric variant ID from GID
          const numericId = node.id.replace('gid://shopify/ProductVariant/', '');
          map.set(numericId, node.barcode);
        }
      }
    }
  } catch (err) {
    console.error('[Webhook] Failed to fetch variant barcodes from Shopify:', err);
  }

  return map;
}

interface ChannelInfo {
  id: string;
  shopify_store_url: string;
  shopify_access_token: string;
  shopify_api_version: string;
  client_id: string;
  settings?: Record<string, unknown>;
}

async function syncOrderToOdoo(channel: ChannelInfo, shopifyOrderId: string, order: Record<string, unknown>, config: OdooConfig) {
  try {
    const lineItems = (order.line_items as Array<Record<string, unknown>>) || [];

    // Always fetch barcodes from Shopify variants — barcode is the most reliable Odoo match key
    const variantIds = lineItems.map(li => String(li.variant_id || '')).filter(Boolean);
    let barcodeMap = new Map<string, string>();
    if (variantIds.length > 0) {
      barcodeMap = await getShopifyVariantBarcodes(channel, variantIds);
      console.log(`[Webhook] Fetched ${barcodeMap.size} barcodes from Shopify for order matching`);
    }

    const result = await createOdooSaleOrder(config, {
      email: String(order.email || ''),
      name: String(order.name || order.order_number || ''),
      total_price: String(order.total_price || '0'),
      line_items: lineItems.map(li => {
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
      shipping_address: order.shipping_address as {
        first_name?: string; last_name?: string; address1?: string;
        address2?: string; city?: string; zip?: string; country?: string; phone?: string;
      } | undefined,
    });

    await query(
      "UPDATE orders SET status = 'synced', odoo_order_id = $1, odoo_order_name = $2, synced_at = NOW() WHERE channel_id = $3 AND shopify_order_id = $4",
      [result.odooOrderId, result.odooOrderName, channel.id, shopifyOrderId]
    );
    console.log(`[Webhook] Order synced to Odoo: ${result.odooOrderName}`);
  } catch (err) {
    await query(
      "UPDATE orders SET status = 'failed', error_message = $1 WHERE channel_id = $2 AND shopify_order_id = $3",
      [String(err), channel.id, shopifyOrderId]
    );
    console.error(`[Webhook] Failed to sync order to Odoo:`, err);
  }
}

// POST /webhooks/shopify/orders/cancelled — Shopify order cancelled webhook
router.post('/shopify/orders/cancelled', async (req: Request, res: Response) => {
  const hmac = req.headers['x-shopify-hmac-sha256'] as string;
  const shopDomain = (req.headers['x-shopify-shop-domain'] as string || '').trim().toLowerCase();

  res.status(200).json({ received: true });

  try {
    const channelResult = await query(
      "SELECT c.* FROM channels c WHERE LOWER(TRIM(REPLACE(REPLACE(c.shopify_store_url, 'https://', ''), 'http://', ''))) = $1 AND c.type = 'shopify'",
      [shopDomain]
    );
    const channel = channelResult.rows[0];
    if (!channel) {
      console.warn(`[Webhook] Cancellation: no channel found for shop: ${shopDomain}`);
      return;
    }

    if (channel.settings?.webhook_secret && hmac) {
      const rawBody = (req as unknown as Record<string, unknown>).rawBody as string || JSON.stringify(req.body);
      if (!verifyShopifyHmac(rawBody, hmac, channel.settings.webhook_secret)) {
        console.warn(`[Webhook] Cancellation: HMAC verification failed for shop: ${shopDomain}`);
        return;
      }
    }

    const order = req.body;
    const shopifyOrderId = String(order.id);
    const orderNumber = order.name || `#${order.order_number}`;

    // Find our stored order record
    const orderResult = await query(
      'SELECT id, odoo_order_id, status FROM orders WHERE channel_id = $1 AND shopify_order_id = $2',
      [channel.id, shopifyOrderId]
    );
    const orderRow = orderResult.rows[0];
    if (!orderRow) {
      console.log(`[Webhook] Cancellation: order ${orderNumber} not found in DB, skipping`);
      return;
    }
    if (orderRow.status === 'cancelled') {
      console.log(`[Webhook] Cancellation: order ${orderNumber} already cancelled`);
      return;
    }

    // Update our status immediately
    await query("UPDATE orders SET status = 'cancelled' WHERE id = $1", [orderRow.id]);

    // Cancel in Odoo if we have an Odoo order ID
    if (orderRow.odoo_order_id) {
      const feedResult = await query(
        "SELECT odoo_url, odoo_database, odoo_username, odoo_api_key FROM feeds WHERE client_id = $1 AND type = 'odoo' LIMIT 1",
        [channel.client_id]
      );
      const odooFeed = feedResult.rows[0];
      if (odooFeed) {
        const config: OdooConfig = {
          url: odooFeed.odoo_url,
          database: odooFeed.odoo_database,
          username: odooFeed.odoo_username,
          apiKey: odooFeed.odoo_api_key,
        };
        try {
          await cancelOdooSaleOrder(config, Number(orderRow.odoo_order_id));
          console.log(`[Webhook] Cancelled Odoo order ${orderRow.odoo_order_id} for Shopify order ${orderNumber}`);
        } catch (err) {
          console.error(`[Webhook] Failed to cancel Odoo order ${orderRow.odoo_order_id}:`, err);
        }
      }
    }
  } catch (err) {
    console.error('[Webhook] Error processing cancellation:', err);
  }
});

export default router;
