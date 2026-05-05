import { Router } from 'express';
import { query } from '../db.js';
import { authenticate } from '../middleware/auth.js';
import type { AuthRequest } from '../middleware/auth.js';

const router = Router();
router.use(authenticate);

// GET /api/feeds?client_id=xxx
router.get('/', async (req: AuthRequest, res) => {
  try {
    const { client_id } = req.query;
    const result = await query(
      `SELECT f.*, 
        (SELECT COUNT(*) FROM products p WHERE p.feed_id = f.id) as product_count
       FROM feeds f
       WHERE ($1::uuid IS NULL OR f.client_id = $1::uuid)
       ORDER BY f.created_at DESC`,
      [client_id || null]
    );
    return res.json(result.rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch feeds' });
  }
});

// POST /api/feeds
router.post('/', async (req: AuthRequest, res) => {
  try {
    const { client_id, name, spreadsheet_id, sheet_name = 'Sheet1', header_row = 1, service_account_json } = req.body;
    if (!client_id || !name || !spreadsheet_id) {
      return res.status(400).json({ error: 'client_id, name, and spreadsheet_id required' });
    }
    const result = await query(
      `INSERT INTO feeds (client_id, name, spreadsheet_id, sheet_name, header_row, service_account_json)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, client_id, name, spreadsheet_id, sheet_name, header_row, is_active, created_at`,
      [client_id, name, spreadsheet_id, sheet_name, header_row, service_account_json || null]
    );
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to create feed' });
  }
});

// PATCH /api/feeds/:id
router.patch('/:id', async (req, res) => {
  try {
    const { name, sheet_name, header_row, is_active } = req.body;
    const result = await query(
      `UPDATE feeds SET
        name = COALESCE($1, name),
        sheet_name = COALESCE($2, sheet_name),
        header_row = COALESCE($3, header_row),
        is_active = COALESCE($4, is_active),
        updated_at = NOW()
       WHERE id = $5 RETURNING *`,
      [name, sheet_name, header_row, is_active, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Feed not found' });
    return res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to update feed' });
  }
});

// DELETE /api/feeds/:id
router.delete('/:id', async (req, res) => {
  try {
    await query('DELETE FROM feeds WHERE id = $1', [req.params.id]);
    return res.json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to delete feed' });
  }
});

// POST /api/feeds/:id/import — trigger import from Google Sheets
router.post('/:id/import', async (req, res) => {
  try {
    const feedResult = await query('SELECT * FROM feeds WHERE id = $1', [req.params.id]);
    const feed = feedResult.rows[0];
    if (!feed) return res.status(404).json({ error: 'Feed not found' });

    // Import is done asynchronously — respond immediately
    res.json({ success: true, message: 'Import started. Check products endpoint for updates.' });

    // Dynamically import service to avoid circular deps
    const { importFeedProducts } = await import('../services/feedService.js');
    await importFeedProducts(feed);
  } catch (err) {
    console.error('Feed import error:', err);
  }
});

// GET /api/feeds/:id/preview — preview first N rows from Google Sheets
router.get('/:id/preview', async (req, res) => {
  try {
    const feedResult = await query('SELECT * FROM feeds WHERE id = $1', [req.params.id]);
    const feed = feedResult.rows[0];
    if (!feed) return res.status(404).json({ error: 'Feed not found' });

    const { previewFeed } = await import('../services/feedService.js');
    const data = await previewFeed(feed, 10);
    return res.json(data);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to preview feed' });
  }
});

export default router;
