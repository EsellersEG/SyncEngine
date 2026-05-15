/**
 * Noon → Shopify Order Sync Service
 *
 * Flow:
 *  1. Fetch Noon orders (FBN and/or FBP) from noon_orders table
 *  2. Create corresponding orders on Shopify via REST API (draft order → complete)
 *     - FBN: inventory_behaviour = 'bypass' (don't decrease Shopify stock — Noon handles fulfillment)
 *     - FBP: inventory_behaviour = 'decrement_obeying_policy' (decrease stock — partner fulfills)
 *  3. When Shopify order is fulfilled with tracking number:
 *     - Push the shipment number to Noon to fulfill the Noon order
 */

import { query } from '../db.js';
import { parseNoonCredentials, noonApiRequest, type NoonCredentials } from './noonAuthService.js';

// ── Shopify REST helper ────────────────────────────────────────────────────

async function shopifyRest(
  channel: { shopify_store_url: string; shopify_access_token: string; shopify_api_version: string },
  method: string,
  path: string,
  body?: unknown
): Promise<unknown> {
  const storeDomain = channel.shopify_store_url.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const url = `https://${storeDomain}/admin/api/${channel.shopify_api_version}${path}`;

  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': channel.shopify_access_token,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Shopify ${method} ${path} failed (${res.status}): ${text.substring(0, 500)}`);
  }

  return text ? JSON.parse(text) : {};
}

// ── Sync Noon orders to Shopify ────────────────────────────────────────────

interface NoonOrderRow {
  id: string;
  client_id: string;
  channel_id: string;
  noon_order_id: string;
  noon_order_number: string;
  order_type: string; // 'fbn' or 'fbp'
  status: string;
  total_price: number;
  customer_name: string;
  country_code: string;
  raw_data: Record<string, unknown>;
  shopify_order_id?: string;
  shopify_channel_id?: string;
}

/**
 * Sync pending Noon orders to Shopify.
 * - FBN orders: created with inventory_behaviour='bypass' (no stock reduction)
 * - FBP orders: created with inventory_behaviour='decrement_obeying_policy' (stock reduces)
 */
export async function syncNoonOrdersToShopify(
  noonChannelId: string,
  shopifyChannelId: string,
  orderType?: 'fbn' | 'fbp' | 'both'
): Promise<{ synced: number; failed: number; skipped: number }> {
  const effectiveType = orderType || 'both';

  // Load Shopify channel
  const shopifyResult = await query('SELECT * FROM channels WHERE id = $1', [shopifyChannelId]);
  const shopifyChannel = shopifyResult.rows[0];
  if (!shopifyChannel || shopifyChannel.type !== 'shopify') {
    throw new Error('Shopify channel not found');
  }

  // Load Noon channel (for SKU mapping)
  const noonResult = await query('SELECT * FROM channels WHERE id = $1', [noonChannelId]);
  const noonChannel = noonResult.rows[0];
  if (!noonChannel) throw new Error('Noon channel not found');

  // Fetch unsynced Noon orders
  let typeFilter = '';
  if (effectiveType === 'fbn') typeFilter = "AND order_type = 'fbn'";
  else if (effectiveType === 'fbp') typeFilter = "AND order_type = 'fbp'";

  const ordersResult = await query(
    `SELECT * FROM noon_orders
     WHERE channel_id = $1
       AND (shopify_order_id IS NULL OR shopify_order_id = '')
       ${typeFilter}
     ORDER BY created_at ASC`,
    [noonChannelId]
  );

  const orders: NoonOrderRow[] = ordersResult.rows;
  console.log(`[NoonOrderSync] Found ${orders.length} unsynced orders to push to Shopify`);

  // Build Shopify SKU map for variant lookup
  const skuMap = await buildShopifySkuMap(shopifyChannel);

  let synced = 0;
  let failed = 0;
  let skipped = 0;

  for (const order of orders) {
    try {
      const result = await createShopifyOrderFromNoon(shopifyChannel, order, skuMap);
      if (result) {
        await query(
          `UPDATE noon_orders SET shopify_order_id = $1, shopify_channel_id = $2, status = 'synced_to_shopify' WHERE id = $3`,
          [result.shopifyOrderId, shopifyChannelId, order.id]
        );
        synced++;
        console.log(`[NoonOrderSync] Noon order ${order.noon_order_id} → Shopify order ${result.orderName}`);
      } else {
        skipped++;
      }
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[NoonOrderSync] Failed to sync order ${order.noon_order_id}:`, msg);
      await query(
        `UPDATE noon_orders SET error_message = $1 WHERE id = $2`,
        [msg.substring(0, 2000), order.id]
      );
    }
  }

  console.log(`[NoonOrderSync] Done: ${synced} synced, ${failed} failed, ${skipped} skipped`);
  return { synced, failed, skipped };
}

// ── Build Shopify SKU → variant map ────────────────────────────────────────

async function buildShopifySkuMap(
  channel: { shopify_store_url: string; shopify_access_token: string; shopify_api_version: string }
): Promise<Map<string, { variantId: string; productId: string }>> {
  const map = new Map<string, { variantId: string; productId: string }>();
  const storeDomain = channel.shopify_store_url.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const apiVersion = channel.shopify_api_version;
  const url = `https://${storeDomain}/admin/api/${apiVersion}/graphql.json`;

  let cursor: string | null = null;
  let hasNext = true;

  while (hasNext) {
    const afterClause = cursor ? `, after: "${cursor}"` : '';
    const gql = `{
      productVariants(first: 250${afterClause}) {
        edges {
          node { id sku product { id } }
          cursor
        }
        pageInfo { hasNextPage }
      }
    }`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': channel.shopify_access_token },
      body: JSON.stringify({ query: gql }),
    });
    const json = await res.json() as {
      data?: {
        productVariants: {
          edges: Array<{ node: { id: string; sku: string; product: { id: string } }; cursor: string }>;
          pageInfo: { hasNextPage: boolean };
        };
      };
    };

    const edges = json.data?.productVariants?.edges || [];
    for (const edge of edges) {
      if (edge.node.sku) {
        map.set(edge.node.sku.toLowerCase(), {
          variantId: edge.node.id,
          productId: edge.node.product.id,
        });
      }
      cursor = edge.cursor;
    }

    hasNext = json.data?.productVariants?.pageInfo?.hasNextPage || false;
  }

  console.log(`[NoonOrderSync] Loaded ${map.size} Shopify SKU→variant mappings`);
  return map;
}

// ── Create Shopify order from Noon order ───────────────────────────────────

async function createShopifyOrderFromNoon(
  shopifyChannel: { shopify_store_url: string; shopify_access_token: string; shopify_api_version: string },
  noonOrder: NoonOrderRow,
  skuMap: Map<string, { variantId: string; productId: string }>
): Promise<{ shopifyOrderId: string; orderName: string } | null> {
  const raw = noonOrder.raw_data;

  // Extract line items from Noon order raw data
  const items = extractNoonLineItems(raw);
  if (items.length === 0) {
    console.warn(`[NoonOrderSync] Order ${noonOrder.noon_order_id} has no line items, skipping`);
    return null;
  }

  // Build Shopify line items
  const lineItems: Array<{ variant_id?: number; title: string; quantity: number; price: string }> = [];

  for (const item of items) {
    const sku = (item.sku || '').toLowerCase();
    const shopifyMatch = skuMap.get(sku);

    if (shopifyMatch) {
      // Extract numeric variant ID from GID
      const numericId = shopifyMatch.variantId.replace('gid://shopify/ProductVariant/', '');
      lineItems.push({
        variant_id: parseInt(numericId),
        title: item.name || item.sku,
        quantity: item.quantity,
        price: item.price,
      });
    } else {
      // No Shopify variant match — create as custom line item
      lineItems.push({
        title: item.name || `SKU: ${item.sku}`,
        quantity: item.quantity,
        price: item.price,
      });
    }
  }

  // FBN = bypass inventory (Noon handles stock), FBP = decrement inventory
  const inventoryBehaviour = noonOrder.order_type === 'fbn' ? 'bypass' : 'decrement_obeying_policy';

  // Build the order payload
  const orderPayload: Record<string, unknown> = {
    order: {
      line_items: lineItems,
      inventory_behaviour: inventoryBehaviour,
      financial_status: 'paid',
      tags: `noon,${noonOrder.order_type},noon-${noonOrder.noon_order_id}`,
      note: `Noon ${noonOrder.order_type.toUpperCase()} Order: ${noonOrder.noon_order_id}`,
      send_receipt: false,
      send_fulfillment_receipt: false,
    },
  };

  // Add customer/shipping info if available
  const shipping = extractNoonShipping(raw);
  if (shipping) {
    (orderPayload.order as Record<string, unknown>).shipping_address = shipping;
    (orderPayload.order as Record<string, unknown>).email = shipping.email || '';
  }

  // Create order on Shopify
  const result = await shopifyRest(shopifyChannel, 'POST', '/orders.json', orderPayload) as {
    order: { id: number; name: string };
  };

  return {
    shopifyOrderId: String(result.order.id),
    orderName: result.order.name,
  };
}

// ── Extract line items from Noon order raw_data ────────────────────────────

function extractNoonLineItems(
  raw: Record<string, unknown>
): Array<{ sku: string; name: string; quantity: number; price: string }> {
  // Noon FBN order structure: items or line_items or order_items
  const items =
    (raw.items as Array<Record<string, unknown>>) ||
    (raw.line_items as Array<Record<string, unknown>>) ||
    (raw.order_items as Array<Record<string, unknown>>) ||
    (raw.order_line as Array<Record<string, unknown>>) ||
    [];

  return items.map(item => ({
    sku: String(item.partner_sku || item.sku || item.seller_sku || ''),
    name: String(item.title || item.product_name || item.name || item.item_name || ''),
    quantity: parseInt(String(item.quantity || item.qty || item.ordered_qty || 1)),
    price: String(item.sale_price || item.unit_price || item.price || '0'),
  }));
}

// ── Extract shipping info from Noon order ──────────────────────────────────

function extractNoonShipping(raw: Record<string, unknown>): Record<string, string> | null {
  const addr =
    (raw.shipping_address as Record<string, unknown>) ||
    (raw.delivery_address as Record<string, unknown>) ||
    (raw.address as Record<string, unknown>);

  if (!addr) return null;

  return {
    first_name: String(addr.first_name || addr.name || '').split(' ')[0] || '',
    last_name: String(addr.last_name || '').split(' ').slice(1).join(' ') || String(addr.name || '').split(' ').slice(1).join(' ') || '',
    address1: String(addr.address_line_1 || addr.address1 || addr.street || ''),
    address2: String(addr.address_line_2 || addr.address2 || ''),
    city: String(addr.city || addr.area || ''),
    country: String(addr.country_code || addr.country || ''),
    phone: String(addr.phone || addr.mobile || ''),
    email: String(raw.customer_email || raw.email || ''),
  };
}

// ── Fulfill Noon order when Shopify is fulfilled ───────────────────────────

/**
 * Called when a Shopify fulfillment webhook fires.
 * Finds the matching Noon order and pushes the tracking/shipment number to Noon.
 */
export async function fulfillNoonOrderFromShopify(
  shopifyOrderId: string,
  shopifyChannelId: string,
  trackingNumber: string,
  trackingCompany?: string
): Promise<void> {
  // Find the noon_order linked to this Shopify order
  const noonOrderResult = await query(
    `SELECT no.*, ch.noon_credentials_json, ch.noon_country_code, ch.noon_warehouse_code
     FROM noon_orders no
     JOIN channels ch ON ch.id = no.channel_id
     WHERE no.shopify_order_id = $1 AND no.shopify_channel_id = $2`,
    [shopifyOrderId, shopifyChannelId]
  );

  const noonOrder = noonOrderResult.rows[0];
  if (!noonOrder) {
    console.log(`[NoonFulfill] No Noon order found for Shopify order ${shopifyOrderId}`);
    return;
  }

  if (noonOrder.status === 'fulfilled') {
    console.log(`[NoonFulfill] Noon order ${noonOrder.noon_order_id} already fulfilled`);
    return;
  }

  if (!noonOrder.noon_credentials_json) {
    console.error(`[NoonFulfill] No Noon credentials for channel ${noonOrder.channel_id}`);
    return;
  }

  const credentials = parseNoonCredentials(noonOrder.noon_credentials_json);
  const countryCode = noonOrder.noon_country_code || 'AE';

  try {
    if (noonOrder.order_type === 'fbp') {
      // FBP: Send shipment to Noon
      console.log(`[NoonFulfill] Fulfilling FBP order ${noonOrder.noon_order_id} with shipment ${trackingNumber}`);

      await noonApiRequest(
        credentials,
        countryCode,
        'POST',
        '/fbpi/v1/fbpi-orders/ship',
        {
          fbpi_order_nr: noonOrder.noon_order_id,
          shipment_nr: trackingNumber,
          shipping_provider: trackingCompany || 'other',
        }
      );
    } else if (noonOrder.order_type === 'fbn') {
      // FBN: Noon already handles fulfillment — just update our status
      console.log(`[NoonFulfill] FBN order ${noonOrder.noon_order_id} — marking as fulfilled (Noon handles shipping)`);
    }

    await query(
      `UPDATE noon_orders SET status = 'fulfilled', synced_at = NOW() WHERE id = $1`,
      [noonOrder.id]
    );

    console.log(`[NoonFulfill] Noon order ${noonOrder.noon_order_id} fulfilled successfully`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[NoonFulfill] Failed to fulfill Noon order ${noonOrder.noon_order_id}:`, msg);
    await query(
      `UPDATE noon_orders SET error_message = $1 WHERE id = $2`,
      [msg.substring(0, 2000), noonOrder.id]
    );
    throw err;
  }
}
