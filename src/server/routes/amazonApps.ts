/**
 * Amazon Apps CRUD routes (admin-only)
 * Manages SP-API app credentials stored in DB
 */

import { Router } from 'express';
import { query } from '../db.js';
import { authenticate, type AuthRequest } from '../middleware/auth.js';

const router = Router();
router.use(authenticate);

// GET /api/amazon/apps — list all Amazon apps
router.get('/', async (req: AuthRequest, res) => {
  try {
    if (req.user!.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    const result = await query(
      `SELECT id, name, app_id, client_id, region, is_default, created_at, updated_at
       FROM amazon_apps ORDER BY created_at DESC`
    );
    return res.json(result.rows);
  } catch (err) {
    console.error('Failed to list Amazon apps:', err);
    return res.status(500).json({ error: 'Failed to list Amazon apps' });
  }
});

// POST /api/amazon/apps — create a new Amazon app
router.post('/', async (req: AuthRequest, res) => {
  try {
    if (req.user!.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    const { name, app_id, client_id, client_secret, region = 'eu', is_default } = req.body;
    if (!name || !app_id || !client_id || !client_secret) {
      return res.status(400).json({ error: 'name, app_id, client_id, and client_secret required' });
    }

    // If setting as default, unset other defaults
    if (is_default) {
      await query('UPDATE amazon_apps SET is_default = false WHERE is_default = true');
    }

    const result = await query(
      `INSERT INTO amazon_apps (name, app_id, client_id, client_secret, region, is_default)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, name, app_id, client_id, region, is_default, created_at`,
      [name, app_id, client_id, client_secret, region, !!is_default]
    );
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Failed to create Amazon app:', err);
    return res.status(500).json({ error: 'Failed to create Amazon app' });
  }
});

// PATCH /api/amazon/apps/:id — update an Amazon app
router.patch('/:id', async (req: AuthRequest, res) => {
  try {
    if (req.user!.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    const { name, app_id, client_id, client_secret, region, is_default } = req.body;

    // If setting as default, unset other defaults
    if (is_default) {
      await query('UPDATE amazon_apps SET is_default = false WHERE is_default = true AND id != $1', [req.params.id]);
    }

    const result = await query(
      `UPDATE amazon_apps SET
        name = COALESCE($1, name),
        app_id = COALESCE($2, app_id),
        client_id = COALESCE($3, client_id),
        client_secret = COALESCE(NULLIF($4, ''), client_secret),
        region = COALESCE($5, region),
        is_default = COALESCE($6, is_default),
        updated_at = NOW()
       WHERE id = $7
       RETURNING id, name, app_id, client_id, region, is_default, created_at, updated_at`,
      [name || null, app_id || null, client_id || null, client_secret || null, region || null, is_default !== undefined ? !!is_default : null, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Amazon app not found' });
    return res.json(result.rows[0]);
  } catch (err) {
    console.error('Failed to update Amazon app:', err);
    return res.status(500).json({ error: 'Failed to update Amazon app' });
  }
});

// DELETE /api/amazon/apps/:id — delete an Amazon app
router.delete('/:id', async (req: AuthRequest, res) => {
  try {
    if (req.user!.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    await query('DELETE FROM amazon_apps WHERE id = $1', [req.params.id]);
    return res.json({ success: true });
  } catch (err) {
    console.error('Failed to delete Amazon app:', err);
    return res.status(500).json({ error: 'Failed to delete Amazon app' });
  }
});

// GET /api/amazon/apps/:id/oauth-urls — get the OAuth URLs for this app
router.get('/:id/oauth-urls', async (req: AuthRequest, res) => {
  try {
    if (req.user!.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    const result = await query('SELECT id, app_id, region FROM amazon_apps WHERE id = $1', [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Amazon app not found' });

    const app = result.rows[0];
    const baseUrl = process.env.APP_BASE_URL || 'https://syncengine-production.up.railway.app';

    return res.json({
      oauth_login_uri: `${baseUrl}/api/amazon/oauth/login`,
      oauth_redirect_uri: `${baseUrl}/api/amazon/oauth/callback`,
      seller_central_authorize_url: `https://sellercentral.amazon.com/apps/authorize/consent?application_id=${app.app_id}&version=beta&state=${app.id}`,
    });
  } catch (err) {
    console.error('Failed to get OAuth URLs:', err);
    return res.status(500).json({ error: 'Failed to get OAuth URLs' });
  }
});

// GET /api/amazon/apps/oauth-tokens — list pending OAuth tokens (not yet linked)
router.get('/oauth-tokens', async (req: AuthRequest, res) => {
  try {
    if (req.user!.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    const result = await query(
      `SELECT ot.seller_id, ot.created_at, ot.linked_channel_id, a.name as app_name
       FROM amazon_oauth_tokens ot
       LEFT JOIN amazon_apps a ON a.id = ot.app_id
       ORDER BY ot.created_at DESC`
    );
    return res.json(result.rows);
  } catch (err) {
    console.error('Failed to list OAuth tokens:', err);
    return res.status(500).json({ error: 'Failed to list OAuth tokens' });
  }
});

export default router;
