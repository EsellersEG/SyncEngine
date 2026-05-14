import { Router } from 'express';
import { query } from '../db.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();
router.use(authenticate);

// GET /api/mappings?feed_id=xxx&channel_id=xxx
router.get('/', async (req, res) => {
  try {
    const { feed_id, channel_id } = req.query;
    const result = await query(
      `SELECT * FROM attribute_mappings
       WHERE ($1::uuid IS NULL OR feed_id = $1::uuid)
         AND ($2::uuid IS NULL OR channel_id = $2::uuid)
       ORDER BY feed_column`,
      [feed_id || null, channel_id || null]
    );
    return res.json(result.rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch mappings' });
  }
});

// POST /api/mappings — upsert a mapping
router.post('/', async (req, res) => {
  try {
    const { feed_id, channel_id, feed_column, target_field, transform } = req.body;
    if (!feed_id || !channel_id || !feed_column || !target_field) {
      return res.status(400).json({ error: 'feed_id, channel_id, feed_column, target_field required' });
    }
    const result = await query(
      `INSERT INTO attribute_mappings (feed_id, channel_id, feed_column, target_field, transform)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [feed_id, channel_id, feed_column, target_field, transform || null]
    );
    return res.status(201).json(result.rows[0] || { message: 'Already exists' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to create mapping' });
  }
});

// PUT /api/mappings/bulk — replace all mappings for a feed+channel pair
router.put('/bulk', async (req, res) => {
  try {
    const { feed_id, channel_id, mappings } = req.body;
    if (!feed_id || !channel_id || !Array.isArray(mappings)) {
      return res.status(400).json({ error: 'feed_id, channel_id, mappings[] required' });
    }

    // Delete existing and re-insert
    await query(
      'DELETE FROM attribute_mappings WHERE feed_id = $1 AND channel_id = $2',
      [feed_id, channel_id]
    );

    if (mappings.length > 0) {
      const values = mappings.map((_: unknown, i: number) => `($${i * 5 + 1}, $${i * 5 + 2}, $${i * 5 + 3}, $${i * 5 + 4}, $${i * 5 + 5})`).join(', ');
      const params = mappings.flatMap((m: { feed_column: string; target_field: string; transform?: string }) => [feed_id, channel_id, m.feed_column, m.target_field, m.transform || null]);
      await query(`INSERT INTO attribute_mappings (feed_id, channel_id, feed_column, target_field, transform) VALUES ${values}`, params);
    }

    return res.json({ success: true, count: mappings.length });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to save mappings' });
  }
});

// DELETE /api/mappings/:id
router.delete('/:id', async (req, res) => {
  try {
    await query('DELETE FROM attribute_mappings WHERE id = $1', [req.params.id]);
    return res.json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to delete mapping' });
  }
});

// POST /api/mappings/auto-map — auto-detect matching columns and create mappings
router.post('/auto-map', async (req, res) => {
  try {
    const { feed_id, channel_id } = req.body;
    if (!feed_id || !channel_id) {
      return res.status(400).json({ error: 'feed_id and channel_id required' });
    }

    // Fetch feed headers from first product
    const headerResult = await query(
      'SELECT raw_data FROM products WHERE feed_id = $1 LIMIT 1',
      [feed_id]
    );
    if (!headerResult.rows[0]) {
      return res.status(400).json({ error: 'No products found in feed. Import the feed first.' });
    }
    const headers = Object.keys(headerResult.rows[0].raw_data);

    // Auto-mapping rules: column name (lowercased) → target Shopify field
    const AUTO_MAP: Record<string, string> = {
      'title': 'title', 'body (html)': 'body_html', 'body_html': 'body_html', 'body html': 'body_html',
      'description': 'body_html', 'vendor': 'vendor', 'tags': 'tags', 'status': 'status', 'handle': 'handle',
      'product type': 'product_type', 'product_type': 'product_type',
      'variant price': 'price', 'variant_price': 'price', 'price': 'price',
      'variant compare at price': 'compare_at_price', 'variant_compare_at_price': 'compare_at_price',
      'compare at price': 'compare_at_price',
      'variant sku': 'sku', 'variant_sku': 'sku', 'sku': 'sku',
      'variant barcode': 'barcode', 'variant_barcode': 'barcode', 'barcode': 'barcode',
      'variant inventory qty': 'inventory_quantity', 'variant_inventory_qty': 'inventory_quantity',
      'variant inventory quantity': 'inventory_quantity', 'inventory_quantity': 'inventory_quantity',
      'quantity': 'inventory_quantity', 'stock': 'inventory_quantity',
      'variant grams': 'weight', 'variant_grams': 'weight', 'weight': 'weight',
      'image src': 'image_url', 'image_src': 'image_url', 'image url': 'image_url',
    };

    // Noon-specific auto-map rules
    const NOON_AUTO_MAP: Record<string, string> = {
      'sku': 'partner_sku', 'partner_sku': 'partner_sku', 'variant_sku': 'partner_sku', 'variant sku': 'partner_sku',
      'quantity': 'qty', 'stock': 'qty', 'inventory_quantity': 'qty', 'qty': 'qty',
      'qty_available': 'qty', 'free_qty': 'qty', 'virtual_available': 'qty',
      'price': 'price', 'variant_price': 'price', 'variant price': 'price', 'list_price': 'price',
      'msrp': 'msrp', 'compare_at_price': 'msrp', 'compare at price': 'msrp', 'variant compare at price': 'msrp',
      'sale_price': 'sale_price', 'sale price': 'sale_price',
      'title': 'title', 'name': 'title',
      'description': 'description', 'body_html': 'description', 'body html': 'description',
      'brand': 'brand', 'vendor': 'brand',
      'image src': 'image_1', 'image_src': 'image_1', 'image url': 'image_1', 'image_url': 'image_1',
      'status': 'is_active', 'is_active': 'is_active', 'active': 'is_active',
      'bullet_point_1': 'bullet_point_1', 'bullet point 1': 'bullet_point_1',
      'bullet_point_2': 'bullet_point_2', 'bullet point 2': 'bullet_point_2',
      'bullet_point_3': 'bullet_point_3', 'bullet point 3': 'bullet_point_3',
      'bullet_point_4': 'bullet_point_4', 'bullet point 4': 'bullet_point_4',
      'bullet_point_5': 'bullet_point_5', 'bullet point 5': 'bullet_point_5',
      'search_keywords': 'search_keywords', 'search keywords': 'search_keywords', 'tags': 'search_keywords',
    };

    // Amazon-specific auto-map rules
    const AMAZON_AUTO_MAP: Record<string, string> = {
      'sku': 'sku', 'variant_sku': 'sku', 'variant sku': 'sku',
      'title': 'item_name', 'name': 'item_name', 'item_name': 'item_name',
      'description': 'product_description', 'body_html': 'product_description', 'body html': 'product_description', 'product_description': 'product_description',
      'brand': 'brand', 'vendor': 'brand',
      'price': 'price', 'variant_price': 'price', 'variant price': 'price', 'list_price': 'price',
      'msrp': 'msrp', 'compare_at_price': 'msrp', 'compare at price': 'msrp', 'variant compare at price': 'msrp',
      'sale_price': 'sale_price', 'sale price': 'sale_price',
      'quantity': 'fulfillment_availability', 'stock': 'fulfillment_availability', 'inventory_quantity': 'fulfillment_availability',
      'qty': 'fulfillment_availability', 'qty_available': 'fulfillment_availability', 'free_qty': 'fulfillment_availability',
      'bullet_point_1': 'bullet_point_1', 'bullet point 1': 'bullet_point_1',
      'bullet_point_2': 'bullet_point_2', 'bullet point 2': 'bullet_point_2',
      'bullet_point_3': 'bullet_point_3', 'bullet point 3': 'bullet_point_3',
      'bullet_point_4': 'bullet_point_4', 'bullet point 4': 'bullet_point_4',
      'bullet_point_5': 'bullet_point_5', 'bullet point 5': 'bullet_point_5',
      'image src': 'main_product_image', 'image_src': 'main_product_image', 'image url': 'main_product_image', 'image_url': 'main_product_image',
      'image_2': 'other_product_image_1', 'image_3': 'other_product_image_2', 'image_4': 'other_product_image_3',
      'image_5': 'other_product_image_4', 'image_6': 'other_product_image_5', 'image_7': 'other_product_image_6', 'image_8': 'other_product_image_7',
      'tags': 'search_terms', 'search_terms': 'search_terms', 'search terms': 'search_terms', 'search_keywords': 'search_terms',
    };

    // Determine which auto-map to use based on channel type
    const channelResult = await query('SELECT type FROM channels WHERE id = $1', [channel_id]);
    const channelType = channelResult.rows[0]?.type;
    const activeAutoMap = channelType === 'amazon' ? AMAZON_AUTO_MAP : channelType === 'noon' ? NOON_AUTO_MAP : AUTO_MAP;

    const mappings: Array<{ feed_column: string; target_field: string }> = [];
    const usedTargets = new Set<string>();

    for (const header of headers) {
      const key = header.toLowerCase().trim();
      const target = activeAutoMap[key];
      if (target && !usedTargets.has(target)) {
        mappings.push({ feed_column: header, target_field: target });
        usedTargets.add(target);
      }
    }

    if (mappings.length === 0) {
      return res.json({ success: true, count: 0, message: 'No matching columns found' });
    }

    // Delete existing and re-insert
    await query('DELETE FROM attribute_mappings WHERE feed_id = $1 AND channel_id = $2', [feed_id, channel_id]);
    const values = mappings.map((_, i) => `($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4})`).join(', ');
    const params = mappings.flatMap(m => [feed_id, channel_id, m.feed_column, m.target_field]);
    await query(`INSERT INTO attribute_mappings (feed_id, channel_id, feed_column, target_field) VALUES ${values}`, params);

    return res.json({ success: true, count: mappings.length, mappings });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to auto-map' });
  }
});

export default router;
