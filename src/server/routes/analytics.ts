import { Router } from 'express';
import { query } from '../db.js';
import { authenticate } from '../middleware/auth.js';
import type { AuthRequest } from '../middleware/auth.js';

const router = Router();
router.use(authenticate);

// GET /api/analytics?client_id=xxx&from=2024-01-01&to=2024-12-31
router.get('/', async (req: AuthRequest, res) => {
  try {
    const { client_id, from, to } = req.query;
    const isAdmin = req.user!.role === 'admin';
    const isClient = req.user!.role === 'client';

    // For client users, resolve their client_id
    let resolvedClientId = client_id as string | null;
    if (isClient) {
      const ucResult = await query('SELECT client_id FROM user_clients WHERE user_id = $1 LIMIT 1', [req.user!.id]);
      if (!ucResult.rows[0]) return res.status(403).json({ error: 'No client assigned' });
      resolvedClientId = ucResult.rows[0].client_id;
    }

    if (!resolvedClientId) {
      return res.status(400).json({ error: 'client_id required' });
    }

    // Date range filters
    const fromDate = from ? String(from) : null;
    const toDate = to ? String(to) : null;

    const dateFilter = `
      ${fromDate ? `AND o.created_at >= $2::timestamptz` : ''}
      ${toDate ? `AND o.created_at <= $3::timestamptz` : ''}
    `;
    const dateParams = [
      resolvedClientId,
      ...(fromDate ? [fromDate] : []),
      ...(toDate ? [toDate] : []),
    ];
    // Build param index offset for date filters
    const pFrom = fromDate ? 2 : null;
    const pTo = toDate ? (fromDate ? 3 : 2) : null;

    // Build a stable date condition and params array
    const buildDateCondition = (alias: string) => {
      const parts: string[] = [];
      if (fromDate) parts.push(`${alias}.created_at >= '${escapeDateParam(fromDate)}'::timestamptz`);
      if (toDate) parts.push(`${alias}.created_at <= '${escapeDateParam(toDate)}'::timestamptz`);
      return parts.length > 0 ? 'AND ' + parts.join(' AND ') : '';
    };

    const dateCondition = buildDateCondition('o');
    const jobDateCondition = buildDateCondition('sj');

    // ─── Detect store currency from most recent order ──────────────────
    const currencyResult = await query(
      `SELECT raw_data->>'currency' as currency FROM orders WHERE client_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [resolvedClientId]
    );
    const storeCurrency = currencyResult.rows[0]?.currency || 'USD';

    // ─── Order Analysis ───────────────────────────────────────────────────

    // Summary stats
    const summaryResult = await query(
      `SELECT 
        COUNT(*)::int as total_orders,
        COALESCE(SUM(total_price), 0)::decimal as total_revenue,
        COALESCE(AVG(total_price), 0)::decimal as avg_order_value
       FROM orders o
       WHERE o.client_id = $1 ${dateCondition}`,
      [resolvedClientId]
    );

    // Order sync status breakdown
    const statusResult = await query(
      `SELECT o.status, COUNT(*)::int as count
       FROM orders o
       WHERE o.client_id = $1 ${dateCondition}
       GROUP BY o.status
       ORDER BY count DESC`,
      [resolvedClientId]
    );

    // Financial status breakdown (from raw_data)
    const financialStatusResult = await query(
      `SELECT raw_data->>'financial_status' as financial_status, COUNT(*)::int as count
       FROM orders o
       WHERE o.client_id = $1 ${dateCondition}
       GROUP BY raw_data->>'financial_status'
       ORDER BY count DESC`,
      [resolvedClientId]
    );

    // Fulfillment/shipping status breakdown
    const fulfillmentStatusResult = await query(
      `SELECT COALESCE(raw_data->>'fulfillment_status', 'unfulfilled') as fulfillment_status, COUNT(*)::int as count
       FROM orders o
       WHERE o.client_id = $1 ${dateCondition}
       GROUP BY raw_data->>'fulfillment_status'
       ORDER BY count DESC`,
      [resolvedClientId]
    );

    // Order distribution by city (top 15)
    const cityResult = await query(
      `SELECT COALESCE(raw_data->'shipping_address'->>'city', 'Unknown') as city, COUNT(*)::int as order_count
       FROM orders o
       WHERE o.client_id = $1 ${dateCondition}
       GROUP BY raw_data->'shipping_address'->>'city'
       ORDER BY order_count DESC
       LIMIT 15`,
      [resolvedClientId]
    );

    // ─── Top 10 Products ──────────────────────────────────────────────────
    const topProductsResult = await query(
      `SELECT 
        item->>'name' as product_name,
        SUM((item->>'quantity')::int) as qty_sold,
        SUM((item->>'price')::decimal * (item->>'quantity')::int) as revenue
       FROM orders o, jsonb_array_elements(raw_data->'line_items') as item
       WHERE o.client_id = $1 ${dateCondition}
       GROUP BY item->>'name'
       ORDER BY qty_sold DESC
       LIMIT 10`,
      [resolvedClientId]
    );

    // ─── Top 10 Brands ────────────────────────────────────────────────────
    const topBrandsResult = await query(
      `SELECT 
        COALESCE(NULLIF(item->>'vendor', ''), 'Unknown') as brand,
        SUM((item->>'quantity')::int) as qty_sold,
        SUM((item->>'price')::decimal * (item->>'quantity')::int) as revenue
       FROM orders o, jsonb_array_elements(raw_data->'line_items') as item
       WHERE o.client_id = $1 ${dateCondition}
       GROUP BY item->>'vendor'
       ORDER BY revenue DESC
       LIMIT 10`,
      [resolvedClientId]
    );

    // ─── Sync Job Analysis ────────────────────────────────────────────────
    const syncSummaryResult = await query(
      `SELECT 
        COUNT(*)::int as total_jobs,
        COUNT(*) FILTER (WHERE sj.status = 'completed')::int as completed,
        COUNT(*) FILTER (WHERE sj.status = 'failed')::int as failed,
        COUNT(*) FILTER (WHERE sj.status = 'running')::int as running,
        AVG(EXTRACT(EPOCH FROM (sj.completed_at - sj.started_at))) as avg_duration_seconds
       FROM sync_jobs sj
       WHERE sj.client_id = $1 ${jobDateCondition}`,
      [resolvedClientId]
    );

    // Last sync per feed
    const lastSyncResult = await query(
      `SELECT sj.feed_id, f.name as feed_name, MAX(sj.completed_at) as last_sync
       FROM sync_jobs sj
       LEFT JOIN feeds f ON f.id = sj.feed_id
       WHERE sj.client_id = $1
       GROUP BY sj.feed_id, f.name
       ORDER BY last_sync DESC NULLS LAST`,
      [resolvedClientId]
    );

    // ─── Error Analysis ───────────────────────────────────────────────────
    const recentOrderErrors = await query(
      `SELECT shopify_order_number, error_message, created_at
       FROM orders o
       WHERE o.client_id = $1 AND o.status = 'failed' ${dateCondition}
       ORDER BY o.created_at DESC
       LIMIT 10`,
      [resolvedClientId]
    );

    const recentSyncErrors = await query(
      `SELECT sj.id, sj.preset, sj.error_message, sj.created_at, ch.name as channel_name
       FROM sync_jobs sj
       LEFT JOIN channels ch ON ch.id = sj.channel_id
       WHERE sj.client_id = $1 AND sj.status = 'failed' ${jobDateCondition}
       ORDER BY sj.created_at DESC
       LIMIT 10`,
      [resolvedClientId]
    );

    // ─── Inventory/Product Stats ──────────────────────────────────────────
    const productStatsResult = await query(
      `SELECT 
        COUNT(*)::int as total_products,
        COUNT(*) FILTER (WHERE status = 'active')::int as active,
        COUNT(*) FILTER (WHERE status = 'archived')::int as archived,
        COUNT(*) FILTER (WHERE status = 'error')::int as error
       FROM products
       WHERE client_id = $1`,
      [resolvedClientId]
    );

    // ─── Orders Over Time (for chart) ─────────────────────────────────────
    const ordersOverTimeResult = await query(
      `SELECT DATE(o.created_at) as date, COUNT(*)::int as order_count, COALESCE(SUM(total_price), 0)::decimal as revenue
       FROM orders o
       WHERE o.client_id = $1 ${dateCondition}
       GROUP BY DATE(o.created_at)
       ORDER BY date ASC`,
      [resolvedClientId]
    );

    const summary = summaryResult.rows[0] || { total_orders: 0, total_revenue: 0, avg_order_value: 0 };

    return res.json({
      currency: storeCurrency,
      summary: {
        total_orders: summary.total_orders,
        total_revenue: parseFloat(summary.total_revenue) || 0,
        avg_order_value: parseFloat(summary.avg_order_value) || 0,
      },
      order_status: statusResult.rows,
      financial_status: financialStatusResult.rows,
      fulfillment_status: fulfillmentStatusResult.rows,
      city_distribution: cityResult.rows,
      top_products: topProductsResult.rows.map(r => ({ ...r, qty_sold: parseInt(r.qty_sold), revenue: parseFloat(r.revenue) })),
      top_brands: topBrandsResult.rows.map(r => ({ ...r, qty_sold: parseInt(r.qty_sold), revenue: parseFloat(r.revenue) })),
      sync_jobs: {
        ...syncSummaryResult.rows[0],
        avg_duration_seconds: syncSummaryResult.rows[0]?.avg_duration_seconds ? parseFloat(syncSummaryResult.rows[0].avg_duration_seconds) : null,
        last_sync_per_feed: lastSyncResult.rows,
      },
      errors: {
        recent_order_errors: recentOrderErrors.rows,
        recent_sync_errors: recentSyncErrors.rows,
      },
      products: productStatsResult.rows[0] || { total_products: 0, active: 0, archived: 0, error: 0 },
      orders_over_time: ordersOverTimeResult.rows.map(r => ({ date: r.date, order_count: r.order_count, revenue: parseFloat(r.revenue) })),
    });
  } catch (err) {
    console.error('Analytics error:', err);
    return res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

// Simple date sanitizer to prevent SQL injection when interpolating dates
function escapeDateParam(val: string): string {
  // Only allow ISO date/datetime characters
  return val.replace(/[^0-9\-T:.Z+ ]/g, '');
}

export default router;
