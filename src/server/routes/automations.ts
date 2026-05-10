import { Router } from 'express';
import { query } from '../db.js';
import { authenticate, type AuthRequest } from '../middleware/auth.js';

const router = Router();
router.use(authenticate);

// GET /api/automations
router.get('/', async (req: AuthRequest, res) => {
  try {
    const isAdmin = req.user!.role === 'admin';
    const result = await query(
      `SELECT a.*,
        c.name as client_name,
        f.name as feed_name,
        f.type as feed_type,
        ch.name as channel_name
       FROM automations a
       LEFT JOIN clients c ON a.client_id = c.id
       LEFT JOIN feeds f ON a.feed_id = f.id
       LEFT JOIN channels ch ON a.channel_id = ch.id
       ${isAdmin ? '' : 'JOIN user_clients uc ON uc.client_id = a.client_id AND uc.user_id = $1'}
       ORDER BY a.created_at DESC`,
      isAdmin ? [] : [req.user!.id]
    );
    return res.json(result.rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch automations' });
  }
});

// POST /api/automations
router.post('/', async (req, res) => {
  try {
    const {
      client_id,
      name,
      trigger_type,
      action_type,
      feed_id,
      channel_id,
      interval_minutes,
      price_adjustment_percent,
      rounding_mode,
    } = req.body;
    if (!client_id || !name || !trigger_type || !action_type) {
      return res.status(400).json({ error: 'client_id, name, trigger_type, and action_type required' });
    }
    if (action_type === 'import_feed' && !feed_id) {
      return res.status(400).json({ error: 'feed_id required for import_feed automations' });
    }
    if (action_type === 'sync_to_shopify' && (!feed_id || !channel_id)) {
      return res.status(400).json({ error: 'feed_id and channel_id required for sync_to_shopify automations' });
    }
    const normalizedRoundingMode = rounding_mode === 'up' || rounding_mode === 'down' ? rounding_mode : 'none';
    const result = await query(
      `INSERT INTO automations (client_id, name, trigger_type, action_type, feed_id, channel_id, interval_minutes, price_adjustment_percent, rounding_mode)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [client_id, name, trigger_type, action_type, feed_id || null, channel_id || null, interval_minutes || null, price_adjustment_percent ?? 0, normalizedRoundingMode]
    );
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to create automation' });
  }
});

// PATCH /api/automations/:id
router.patch('/:id', async (req, res) => {
  try {
    const {
      is_active,
      name,
      trigger_type,
      action_type,
      feed_id,
      channel_id,
      interval_minutes,
      price_adjustment_percent,
      rounding_mode,
    } = req.body;
    const normalizedRoundingMode = rounding_mode === 'up' || rounding_mode === 'down'
      ? rounding_mode
      : rounding_mode === 'none'
        ? 'none'
        : null;
    const result = await query(
      `UPDATE automations SET
        is_active = COALESCE($1, is_active),
        name = COALESCE($2, name),
        trigger_type = COALESCE($3, trigger_type),
        action_type = COALESCE($4, action_type),
        feed_id = COALESCE($5, feed_id),
        channel_id = COALESCE($6, channel_id),
        interval_minutes = COALESCE($7, interval_minutes),
        price_adjustment_percent = COALESCE($8, price_adjustment_percent),
        rounding_mode = COALESCE($9, rounding_mode),
        updated_at = NOW()
       WHERE id = $10 RETURNING *`,
      [is_active, name, trigger_type, action_type, feed_id, channel_id, interval_minutes, price_adjustment_percent, normalizedRoundingMode, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });
    return res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to update automation' });
  }
});

// DELETE /api/automations/:id
router.delete('/:id', async (req, res) => {
  try {
    await query('DELETE FROM automations WHERE id = $1', [req.params.id]);
    return res.json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to delete automation' });
  }
});

export default router;
