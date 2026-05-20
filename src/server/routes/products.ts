import { Router } from 'express';
import { query } from '../db.js';
import { authenticate, requireAdmin, type AuthRequest } from '../middleware/auth.js';

const router = Router();
router.use(authenticate);

// GET /api/products/export — download products as CSV
router.get('/export', async (req: AuthRequest, res) => {
  try {
    const { client_id, feed_id, search } = req.query;
    const isAdmin = req.user!.role === 'admin';
    const ucJoin = isAdmin ? '' : 'JOIN user_clients uc ON uc.client_id = p.client_id AND uc.user_id = $4';

    const result = await query(
      `SELECT p.sku, p.status, p.last_updated_at, p.raw_data, f.name as feed_name
       FROM products p
       LEFT JOIN feeds f ON p.feed_id = f.id
       ${ucJoin}
       WHERE ($1::uuid IS NULL OR p.client_id = $1::uuid)
         AND ($2::uuid IS NULL OR p.feed_id = $2::uuid)
         AND ($3::text IS NULL OR p.sku ILIKE '%' || $3 || '%')
       ORDER BY p.last_updated_at DESC`,
      isAdmin
        ? [client_id || null, feed_id || null, search || null]
        : [client_id || null, feed_id || null, search || null, req.user!.id]
    );

    // Collect all raw_data keys across products for dynamic columns
    const allKeys = new Set<string>();
    for (const row of result.rows) {
      if (row.raw_data && typeof row.raw_data === 'object') {
        Object.keys(row.raw_data).forEach(k => allKeys.add(k));
      }
    }
    const dynamicKeys = Array.from(allKeys).sort();
    const headers = ['sku', 'status', 'feed_name', 'last_updated_at', ...dynamicKeys];

    const escCSV = (val: unknown) => {
      const s = String(val ?? '');
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const rows = result.rows.map(r => {
      const base = [r.sku, r.status, r.feed_name || '', r.last_updated_at || ''];
      const dynamic = dynamicKeys.map(k => r.raw_data?.[k] ?? '');
      return [...base, ...dynamic].map(escCSV).join(',');
    });

    const csv = [headers.map(escCSV).join(','), ...rows].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="products-${new Date().toISOString().slice(0, 10)}.csv"`);
    return res.send(csv);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Export failed' });
  }
});

// GET /api/products?client_id=xxx&feed_id=xxx&page=1&limit=50&search=xxx
router.get('/', async (req: AuthRequest, res) => {
  try {
    const { client_id, feed_id, page = '1', limit = '50', search } = req.query;
    const offset = (parseInt(page as string) - 1) * parseInt(limit as string);
    const isAdmin = req.user!.role === 'admin';
    const ucJoin = isAdmin ? '' : 'JOIN user_clients uc ON uc.client_id = p.client_id AND uc.user_id = $6';

    const result = await query(
      `SELECT p.*, f.name as feed_name
       FROM products p
       LEFT JOIN feeds f ON p.feed_id = f.id
       ${ucJoin}
       WHERE ($1::uuid IS NULL OR p.client_id = $1::uuid)
         AND ($2::uuid IS NULL OR p.feed_id = $2::uuid)
         AND ($3::text IS NULL OR p.sku ILIKE '%' || $3 || '%' OR p.raw_data::text ILIKE '%' || $3 || '%')
       ORDER BY p.last_updated_at DESC
       LIMIT $4 OFFSET $5`,
      isAdmin
        ? [client_id || null, feed_id || null, search || null, parseInt(limit as string), offset]
        : [client_id || null, feed_id || null, search || null, parseInt(limit as string), offset, req.user!.id]
    );

    const countResult = await query(
      `SELECT COUNT(*) FROM products p
       ${ucJoin.replace('$6', '$4')}
       WHERE ($1::uuid IS NULL OR p.client_id = $1::uuid)
         AND ($2::uuid IS NULL OR p.feed_id = $2::uuid)
         AND ($3::text IS NULL OR p.sku ILIKE '%' || $3 || '%')`,
      isAdmin
        ? [client_id || null, feed_id || null, search || null]
        : [client_id || null, feed_id || null, search || null, req.user!.id]
    );

    return res.json({
      products: result.rows,
      total: parseInt(countResult.rows[0].count),
      page: parseInt(page as string),
      limit: parseInt(limit as string),
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch products' });
  }
});

// GET /api/products/:id
router.get('/:id', async (req, res) => {
  try {
    const result = await query('SELECT * FROM products WHERE id = $1', [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Product not found' });
    return res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch product' });
  }
});

// DELETE /api/products/:id — delete a single product (admin only, already enforced)
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const result = await query('DELETE FROM products WHERE id = $1 RETURNING id, sku', [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Product not found' });
    return res.json({ success: true, deleted: 1 });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to delete product' });
  }
});

// DELETE /api/products — bulk delete by feed_id, client_id, or search (admin only, already enforced)
router.delete('/', requireAdmin, async (req: AuthRequest, res) => {
  try {
    const { feed_id, client_id, search } = req.query;
    if (!feed_id && !client_id && !search) {
      return res.status(400).json({ error: 'At least one filter (feed_id, client_id, or search) is required' });
    }
    const result = await query(
      `DELETE FROM products
       WHERE ($1::uuid IS NULL OR feed_id = $1::uuid)
         AND ($2::uuid IS NULL OR client_id = $2::uuid)
         AND ($3::text IS NULL OR sku ILIKE '%' || $3 || '%')`,
      [feed_id || null, client_id || null, search || null]
    );
    return res.json({ success: true, deleted: result.rowCount });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to delete products' });
  }
});

export default router;
