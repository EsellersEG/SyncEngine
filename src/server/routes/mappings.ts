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

export default router;
