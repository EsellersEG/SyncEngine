import { Router } from 'express';
import { query } from '../db.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();
router.use(authenticate);

// GET /api/products?client_id=xxx&feed_id=xxx&page=1&limit=50&search=xxx
router.get('/', async (req, res) => {
  try {
    const { client_id, feed_id, page = '1', limit = '50', search } = req.query;
    const offset = (parseInt(page as string) - 1) * parseInt(limit as string);

    const result = await query(
      `SELECT p.*, f.name as feed_name
       FROM products p
       LEFT JOIN feeds f ON p.feed_id = f.id
       WHERE ($1::uuid IS NULL OR p.client_id = $1::uuid)
         AND ($2::uuid IS NULL OR p.feed_id = $2::uuid)
         AND ($3::text IS NULL OR p.sku ILIKE '%' || $3 || '%' OR p.raw_data::text ILIKE '%' || $3 || '%')
       ORDER BY p.last_updated_at DESC
       LIMIT $4 OFFSET $5`,
      [client_id || null, feed_id || null, search || null, parseInt(limit as string), offset]
    );

    const countResult = await query(
      `SELECT COUNT(*) FROM products p
       WHERE ($1::uuid IS NULL OR p.client_id = $1::uuid)
         AND ($2::uuid IS NULL OR p.feed_id = $2::uuid)
         AND ($3::text IS NULL OR p.sku ILIKE '%' || $3 || '%')`,
      [client_id || null, feed_id || null, search || null]
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

export default router;
