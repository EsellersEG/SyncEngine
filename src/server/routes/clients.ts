import { Router } from 'express';
import { query } from '../db.js';
import { authenticate, requireAdmin, requireAdminOrEmployee, type AuthRequest } from '../middleware/auth.js';

const router = Router();
router.use(authenticate);

// GET /api/clients
router.get('/', async (req: AuthRequest, res) => {
  try {
    let result;
    if (req.user!.role === 'admin' || req.user!.role === 'employee') {
      if (req.user!.role === 'admin') {
        result = await query(
          `SELECT c.*, u.name as created_by_name,
            (SELECT COUNT(*) FROM feeds WHERE client_id = c.id) as feed_count,
            (SELECT COUNT(*) FROM channels WHERE client_id = c.id) as channel_count
           FROM clients c
           LEFT JOIN users u ON c.created_by = u.id
           ORDER BY c.created_at DESC`
        );
      } else {
        // Employee sees only assigned clients
        result = await query(
          `SELECT c.*, u.name as created_by_name,
            (SELECT COUNT(*) FROM feeds WHERE client_id = c.id) as feed_count,
            (SELECT COUNT(*) FROM channels WHERE client_id = c.id) as channel_count
           FROM clients c
           LEFT JOIN users u ON c.created_by = u.id
           JOIN user_clients uc ON c.id = uc.client_id AND uc.user_id = $1
           WHERE c.is_active = TRUE
           ORDER BY c.created_at DESC`,
          [req.user!.id]
        );
      }
    } else {
      result = await query(
        `SELECT c.*, uc.role as user_role,
          (SELECT COUNT(*) FROM feeds WHERE client_id = c.id) as feed_count,
          (SELECT COUNT(*) FROM channels WHERE client_id = c.id) as channel_count
         FROM clients c
         JOIN user_clients uc ON c.id = uc.client_id AND uc.user_id = $1
         WHERE c.is_active = TRUE
         ORDER BY c.created_at DESC`,
        [req.user!.id]
      );
    }
    return res.json(result.rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch clients' });
  }
});

// GET /api/clients/:id
router.get('/:id', async (req: AuthRequest, res) => {
  try {
    const result = await query(
      `SELECT c.*, u.name as created_by_name FROM clients c
       LEFT JOIN users u ON c.created_by = u.id
       WHERE c.id = $1`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Client not found' });
    return res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch client' });
  }
});

// POST /api/clients — admin or employee
router.post('/', requireAdminOrEmployee, async (req: AuthRequest, res) => {
  try {
    const { name, slug, logo_url } = req.body;
    if (!name || !slug) {
      return res.status(400).json({ error: 'name and slug required' });
    }
    const result = await query(
      `INSERT INTO clients (name, slug, logo_url, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [name, slug.toLowerCase().replace(/[^a-z0-9-]/g, '-'), logo_url || null, req.user!.id]
    );
    return res.status(201).json(result.rows[0]);
  } catch (err: unknown) {
    if ((err as { code?: string }).code === '23505') {
      return res.status(409).json({ error: 'Client slug already exists' });
    }
    console.error(err);
    return res.status(500).json({ error: 'Failed to create client' });
  }
});

// PATCH /api/clients/:id
router.patch('/:id', requireAdmin, async (req, res) => {
  try {
    const { name, logo_url, is_active, address, phone, email, tax_id } = req.body;
    const result = await query(
      `UPDATE clients SET
        name = COALESCE($1, name),
        logo_url = COALESCE($2, logo_url),
        is_active = COALESCE($3, is_active),
        address = COALESCE($4, address),
        phone = COALESCE($5, phone),
        email = COALESCE($6, email),
        tax_id = COALESCE($7, tax_id),
        updated_at = NOW()
       WHERE id = $8 RETURNING *`,
      [name, logo_url, is_active, address ?? null, phone ?? null, email ?? null, tax_id ?? null, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Client not found' });
    return res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to update client' });
  }
});

// GET /api/clients/:id/stats — summary stats for a client
router.get('/:id/stats', async (req, res) => {
  try {
    const [feeds, channels, products, jobs] = await Promise.all([
      query('SELECT COUNT(*) FROM feeds WHERE client_id = $1', [req.params.id]),
      query('SELECT COUNT(*) FROM channels WHERE client_id = $1', [req.params.id]),
      query('SELECT COUNT(*) FROM products WHERE client_id = $1', [req.params.id]),
      query(
        `SELECT COUNT(*) FILTER (WHERE sj.status='completed') as completed,
                COUNT(*) FILTER (WHERE sj.status='failed') as failed,
                COUNT(*) FILTER (WHERE sj.status='running') as running
         FROM sync_jobs sj
         JOIN channels ch ON sj.channel_id = ch.id
         WHERE ch.client_id = $1`,
        [req.params.id]
      ),
    ]);
    return res.json({
      feeds: parseInt(feeds.rows[0].count),
      channels: parseInt(channels.rows[0].count),
      products: parseInt(products.rows[0].count),
      ...jobs.rows[0],
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

export default router;
