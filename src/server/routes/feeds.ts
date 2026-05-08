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
    const {
      client_id,
      name,
      type = 'google_sheets',
      spreadsheet_id,
      sheet_name = 'Sheet1',
      header_row = 1,
      service_account_json,
      odoo_url,
      odoo_database,
      odoo_username,
      odoo_api_key,
      odoo_search_by,
      odoo_warehouse_id,
      sync_interval_minutes,
    } = req.body;
    if (!client_id || !name) {
      return res.status(400).json({ error: 'client_id and name required' });
    }
    if (type === 'google_sheets' && !spreadsheet_id) {
      return res.status(400).json({ error: 'spreadsheet_id required for Google Sheets feed' });
    }
    if (type === 'odoo' && (!odoo_url || !odoo_database || !odoo_username || !odoo_api_key)) {
      return res.status(400).json({ error: 'odoo_url, odoo_database, odoo_username, and odoo_api_key required for Odoo feed' });
    }
    const normalizedOdooSearchBy = odoo_search_by === 'sku' || odoo_search_by === 'ean' || odoo_search_by === 'name'
      ? odoo_search_by
      : 'automatic';
    const result = await query(
      `INSERT INTO feeds (client_id, name, type, spreadsheet_id, sheet_name, header_row, service_account_json, odoo_url, odoo_database, odoo_username, odoo_api_key, odoo_search_by, odoo_warehouse_id, sync_interval_minutes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING *`,
      [client_id, name, type, spreadsheet_id || '', sheet_name, header_row, service_account_json || null, odoo_url || null, odoo_database || null, odoo_username || null, odoo_api_key || null, normalizedOdooSearchBy, odoo_warehouse_id ? parseInt(odoo_warehouse_id) : null, sync_interval_minutes || null]
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
    const {
      name,
      type,
      spreadsheet_id,
      sheet_name,
      header_row,
      is_active,
      odoo_url,
      odoo_database,
      odoo_username,
      odoo_api_key,
      odoo_search_by,
      odoo_warehouse_id,
      sync_interval_minutes,
    } = req.body;
    const normalizedOdooSearchBy = odoo_search_by === 'sku' || odoo_search_by === 'ean' || odoo_search_by === 'name'
      ? odoo_search_by
      : odoo_search_by === 'automatic'
        ? 'automatic'
        : null;
    const result = await query(
      `UPDATE feeds SET
        name = COALESCE($1, name),
        type = COALESCE($2, type),
        spreadsheet_id = COALESCE($3, spreadsheet_id),
        sheet_name = COALESCE($4, sheet_name),
        header_row = COALESCE($5, header_row),
        is_active = COALESCE($6, is_active),
        odoo_url = COALESCE($7, odoo_url),
        odoo_database = COALESCE($8, odoo_database),
        odoo_username = COALESCE($9, odoo_username),
        odoo_api_key = COALESCE(NULLIF($10, ''), odoo_api_key),
        odoo_search_by = COALESCE($11, odoo_search_by),
        odoo_warehouse_id = $12,
        sync_interval_minutes = $13,
        updated_at = NOW()
       WHERE id = $14 RETURNING *`,
      [name, type, spreadsheet_id, sheet_name, header_row, is_active, odoo_url, odoo_database, odoo_username, odoo_api_key, normalizedOdooSearchBy, odoo_warehouse_id !== undefined ? (odoo_warehouse_id ? parseInt(odoo_warehouse_id) : null) : null, sync_interval_minutes ?? null, req.params.id]
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

// GET /api/feeds/:id/import-status — check import progress
router.get('/:id/import-status', async (req, res) => {
  try {
    const { getImportProgress } = await import('../services/feedService.js');
    const progress = getImportProgress(req.params.id);
    if (!progress) return res.json({ status: 'idle' });
    return res.json(progress);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to get import status' });
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

// POST /api/feeds/test-odoo — test Odoo connection
router.post('/test-odoo', async (req: AuthRequest, res) => {
  try {
    const { url, database, username, api_key } = req.body;
    if (!url || !database || !username || !api_key) {
      return res.status(400).json({ error: 'url, database, username, and api_key required' });
    }
    const { testOdooConnection } = await import('../services/odooService.js');
    const result = await testOdooConnection({ url, database, username, apiKey: api_key });
    return res.json(result);
  } catch (err) {
    console.error('Odoo connection test failed:', err);
    return res.status(400).json({ error: err instanceof Error ? err.message : 'Connection failed' });
  }
});

// POST /api/feeds/odoo-warehouses — list Odoo warehouses
router.post('/odoo-warehouses', async (req: AuthRequest, res) => {
  try {
    const { url, database, username, api_key } = req.body;
    if (!url || !database || !username || !api_key) {
      return res.status(400).json({ error: 'url, database, username, and api_key required' });
    }
    const { fetchOdooWarehouses } = await import('../services/odooService.js');
    const warehouses = await fetchOdooWarehouses({ url, database, username, apiKey: api_key });
    return res.json(warehouses);
  } catch (err) {
    console.error('Odoo warehouses fetch failed:', err);
    return res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to fetch warehouses' });
  }
});

export default router;
