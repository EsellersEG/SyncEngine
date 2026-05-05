import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { query } from '../db.js';
import { authenticate, requireAdmin, type AuthRequest } from '../middleware/auth.js';

const router = Router();
router.use(authenticate);

// GET /api/users — admin sees all, client sees their own
router.get('/', requireAdmin, async (_req, res) => {
  try {
    const result = await query(
      'SELECT id, email, name, role, is_active, created_at FROM users ORDER BY created_at DESC'
    );
    return res.json(result.rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// POST /api/users — admin creates users
router.post('/', requireAdmin, async (req: AuthRequest, res) => {
  try {
    const { email, password, name, role = 'client' } = req.body;
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'email, password, name required' });
    }
    const hash = await bcrypt.hash(password, 12);
    const result = await query(
      `INSERT INTO users (email, password_hash, name, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, name, role, is_active, created_at`,
      [email.toLowerCase(), hash, name, role]
    );
    return res.status(201).json(result.rows[0]);
  } catch (err: unknown) {
    if ((err as { code?: string }).code === '23505') {
      return res.status(409).json({ error: 'Email already exists' });
    }
    console.error(err);
    return res.status(500).json({ error: 'Failed to create user' });
  }
});

// PATCH /api/users/:id — update user
router.patch('/:id', requireAdmin, async (req, res) => {
  try {
    const { name, role, is_active } = req.body;
    const result = await query(
      `UPDATE users SET
        name = COALESCE($1, name),
        role = COALESCE($2, role),
        is_active = COALESCE($3, is_active),
        updated_at = NOW()
       WHERE id = $4
       RETURNING id, email, name, role, is_active`,
      [name, role, is_active, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' });
    return res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to update user' });
  }
});

// POST /api/users/:id/assign-client — assign user to client
router.post('/:id/assign-client', requireAdmin, async (req, res) => {
  try {
    const { client_id, role = 'viewer' } = req.body;
    await query(
      `INSERT INTO user_clients (user_id, client_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, client_id) DO UPDATE SET role = $3`,
      [req.params.id, client_id, role]
    );
    return res.json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to assign client' });
  }
});

export default router;
