/**
 * Amazon Orders Service — Order polling & sync
 *
 * Uses SP-API Orders API:
 *  - GET /orders/v0/orders — list orders with pagination
 *  - GET /orders/v0/orders/{orderId}/orderItems — get line items
 *
 * Supports both FBA (AFN) and FBM (MFN) orders.
 */

import { query } from '../db.js';
import {
  parseAmazonCredentials,
  amazonApiRequest,
  type AmazonCredentials,
} from './amazonAuthService.js';

interface AmazonOrder {
  AmazonOrderId: string;
  SellerOrderId?: string;
  OrderStatus: string;
  OrderTotal?: { Amount: string; CurrencyCode: string };
  BuyerInfo?: { BuyerName?: string };
  MarketplaceId: string;
  FulfillmentChannel: string; // 'MFN' or 'AFN'
  PurchaseDate: string;
  LastUpdateDate: string;
}

interface GetOrdersResponse {
  payload: {
    Orders: AmazonOrder[];
    NextToken?: string;
    CreatedBefore?: string;
  };
}

interface OrderItem {
  ASIN: string;
  SellerSKU: string;
  Title: string;
  QuantityOrdered: number;
  QuantityShipped: number;
  ItemPrice?: { Amount: string; CurrencyCode: string };
}

interface GetOrderItemsResponse {
  payload: {
    OrderItems: OrderItem[];
    NextToken?: string;
  };
}

// ── Fetch Orders ───────────────────────────────────────────────────────────

export async function fetchAmazonOrders(
  credentials: AmazonCredentials,
  region: string,
  marketplaceIds: string[],
  createdAfter: string,
  maxPages = 10
): Promise<AmazonOrder[]> {
  const allOrders: AmazonOrder[] = [];
  let nextToken: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    const params: Record<string, string> = nextToken
      ? { NextToken: nextToken }
      : {
          MarketplaceIds: marketplaceIds.join(','),
          CreatedAfter: createdAfter,
          OrderStatuses: 'Unshipped,PartiallyShipped,Shipped,InvoiceUnconfirmed',
        };

    const data = await amazonApiRequest<GetOrdersResponse>(
      credentials, region, 'GET', '/orders/v0/orders', undefined, params
    );

    if (data.payload?.Orders) {
      allOrders.push(...data.payload.Orders);
    }

    nextToken = data.payload?.NextToken;
    if (!nextToken) break;
  }

  return allOrders;
}

// ── Fetch Order Items ──────────────────────────────────────────────────────

export async function fetchOrderItems(
  credentials: AmazonCredentials,
  region: string,
  orderId: string
): Promise<OrderItem[]> {
  const data = await amazonApiRequest<GetOrderItemsResponse>(
    credentials, region, 'GET', `/orders/v0/orders/${orderId}/orderItems`
  );
  return data.payload?.OrderItems || [];
}

// ── Sync Orders to DB ──────────────────────────────────────────────────────

export async function syncAmazonOrders(channelId: string): Promise<{
  fetched: number;
  newOrders: number;
  updatedOrders: number;
  errors: number;
}> {
  const chResult = await query(
    'SELECT id, client_id, amazon_credentials_json, amazon_marketplace_ids, amazon_region FROM channels WHERE id = $1',
    [channelId]
  );
  const ch = chResult.rows[0];
  if (!ch || !ch.amazon_credentials_json) {
    throw new Error('Amazon channel not found or not configured');
  }

  const credentials = parseAmazonCredentials(ch.amazon_credentials_json);
  const region = ch.amazon_region || 'eu';
  const marketplaceIds = (ch.amazon_marketplace_ids || '').split(',').map((s: string) => s.trim()).filter(Boolean);

  if (marketplaceIds.length === 0) {
    throw new Error('No marketplace IDs configured');
  }

  // Determine the "created after" window — last 24h or since last order
  const lastOrderResult = await query(
    'SELECT MAX(created_at) as last_at FROM amazon_orders WHERE channel_id = $1',
    [channelId]
  );
  const lastAt = lastOrderResult.rows[0]?.last_at;
  const createdAfter = lastAt
    ? new Date(new Date(lastAt).getTime() - 60_000).toISOString() // overlap 1 min
    : new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const orders = await fetchAmazonOrders(credentials, region, marketplaceIds, createdAfter);

  let newOrders = 0;
  let updatedOrders = 0;
  let errors = 0;

  for (const order of orders) {
    try {
      const result = await query(
        `INSERT INTO amazon_orders (
          client_id, channel_id, amazon_order_id, amazon_order_number,
          status, order_status, total_price, currency, customer_name,
          marketplace_id, fulfillment_channel, raw_data, synced_at
        ) VALUES ($1, $2, $3, $4, 'synced', $5, $6, $7, $8, $9, $10, $11, NOW())
        ON CONFLICT (channel_id, amazon_order_id) DO UPDATE SET
          order_status = EXCLUDED.order_status,
          total_price = EXCLUDED.total_price,
          customer_name = EXCLUDED.customer_name,
          raw_data = EXCLUDED.raw_data,
          synced_at = NOW()
        RETURNING (xmax = 0) as is_new`,
        [
          ch.client_id,
          channelId,
          order.AmazonOrderId,
          order.SellerOrderId || order.AmazonOrderId,
          order.OrderStatus,
          order.OrderTotal?.Amount ? parseFloat(order.OrderTotal.Amount) : null,
          order.OrderTotal?.CurrencyCode || null,
          order.BuyerInfo?.BuyerName || null,
          order.MarketplaceId,
          order.FulfillmentChannel,
          JSON.stringify(order),
        ]
      );

      if (result.rows[0]?.is_new) {
        newOrders++;
      } else {
        updatedOrders++;
      }
    } catch (err) {
      console.error(`[AmazonOrders] Error upserting order ${order.AmazonOrderId}:`, err);
      errors++;
    }
  }

  console.log(`[AmazonOrders] Channel ${channelId}: fetched ${orders.length}, new ${newOrders}, updated ${updatedOrders}, errors ${errors}`);

  return { fetched: orders.length, newOrders, updatedOrders, errors };
}
