import { Router } from 'express';
import { query } from '../db.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();
router.use(authenticate);

// GET /api/channels?client_id=xxx
router.get('/', async (req, res) => {
  try {
    const { client_id } = req.query;
    const result = await query(
      `SELECT ch.*,
        (SELECT COUNT(*) FROM sync_jobs sj WHERE sj.channel_id = ch.id) as total_syncs,
        (SELECT MAX(sj.completed_at) FROM sync_jobs sj WHERE sj.channel_id = ch.id AND sj.status = 'completed') as last_synced_at
       FROM channels ch
       WHERE ($1::uuid IS NULL OR ch.client_id = $1::uuid)
       ORDER BY ch.created_at DESC`,
      [client_id || null]
    );
    // Mask tokens in response
    const masked = result.rows.map(ch => ({
      ...ch,
      shopify_access_token: ch.shopify_access_token ? '••••••••' : null,
    }));
    return res.json(masked);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch channels' });
  }
});

// GET /api/channels/:id
router.get('/:id', async (req, res) => {
  try {
    const result = await query('SELECT * FROM channels WHERE id = $1', [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Channel not found' });
    const ch = { ...result.rows[0], shopify_access_token: ch.shopify_access_token ? '••••••••' : null };
    return res.json(ch);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch channel' });
  }
});

// POST /api/channels
router.post('/', async (req, res) => {
  try {
    const {
      client_id, name, type,
      shopify_store_url, shopify_access_token, shopify_api_version,
      settings = {}
    } = req.body;

    if (!client_id || !name || !type) {
      return res.status(400).json({ error: 'client_id, name, type required' });
    }

    const result = await query(
      `INSERT INTO channels (client_id, name, type, shopify_store_url, shopify_access_token, shopify_api_version, settings)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, client_id, name, type, status, shopify_store_url, shopify_api_version, settings, created_at`,
      [client_id, name, type, shopify_store_url || null, shopify_access_token || null,
       shopify_api_version || '2024-10', JSON.stringify(settings)]
    );
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to create channel' });
  }
});

// PATCH /api/channels/:id
router.patch('/:id', async (req, res) => {
  try {
    const { name, status, shopify_access_token, shopify_api_version, settings } = req.body;
    const result = await query(
      `UPDATE channels SET
        name = COALESCE($1, name),
        status = COALESCE($2, status),
        shopify_access_token = COALESCE($3, shopify_access_token),
        shopify_api_version = COALESCE($4, shopify_api_version),
        settings = COALESCE($5::jsonb, settings),
        updated_at = NOW()
       WHERE id = $6
       RETURNING id, client_id, name, type, status, shopify_store_url, shopify_api_version, settings`,
      [name, status, shopify_access_token, shopify_api_version,
       settings ? JSON.stringify(settings) : null, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Channel not found' });
    return res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to update channel' });
  }
});

// DELETE /api/channels/:id
router.delete('/:id', async (req, res) => {
  try {
    await query('DELETE FROM channels WHERE id = $1', [req.params.id]);
    return res.json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to delete channel' });
  }
});

// POST /api/channels/:id/test — test Shopify connection
router.post('/:id/test', async (req, res) => {
  try {
    const result = await query(
      'SELECT shopify_store_url, shopify_access_token, shopify_api_version FROM channels WHERE id = $1',
      [req.params.id]
    );
    const ch = result.rows[0];
    if (!ch) return res.status(404).json({ error: 'Channel not found' });

    const url = `https://${ch.shopify_store_url}/admin/api/${ch.shopify_api_version}/shop.json`;
    const shopRes = await fetch(url, {
      headers: { 'X-Shopify-Access-Token': ch.shopify_access_token },
    });

    if (!shopRes.ok) {
      await query("UPDATE channels SET status = 'error' WHERE id = $1", [req.params.id]);
      return res.status(400).json({ error: 'Shopify connection failed', details: await shopRes.text() });
    }

    const shopData = await shopRes.json() as { shop: { name: string; email: string } };
    await query("UPDATE channels SET status = 'active' WHERE id = $1", [req.params.id]);
    return res.json({ success: true, shop: shopData.shop });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Connection test failed' });
  }
});

export default router;
