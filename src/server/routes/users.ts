import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { query } from '../db.js';
import { authenticate, requireAdmin, type AuthRequest } from '../middleware/auth.js';

const router = Router();
router.use(authenticate);

// GET /api/users — list all users with their assigned client count
router.get('/', requireAdmin, async (_req, res) => {
  try {
    const result = await query(
      `SELECT u.id, u.email, u.name, u.role, u.is_active, u.created_at,
              COUNT(DISTINCT uc.client_id) AS client_count
       FROM users u
       LEFT JOIN user_clients uc ON uc.user_id = u.id
       GROUP BY u.id
       ORDER BY u.created_at DESC`
    );
    return res.json(result.rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// GET /api/users/:id/assignments — get client assignments for a user
router.get('/:id/assignments', requireAdmin, async (req, res) => {
  try {
    const result = await query('SELECT client_id FROM user_clients WHERE user_id = $1', [req.params.id]);
    return res.json({
      client_ids: result.rows.map(r => r.client_id),
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch assignments' });
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

// PATCH /api/users/:id — update user (name, role, is_active, optional new password)
router.patch('/:id', requireAdmin, async (req, res) => {
  try {
    const { name, role, is_active, password } = req.body;
    let passwordClause = '';
    const params: unknown[] = [name, role, is_active];
    if (password && String(password).length >= 8) {
      const hash = await bcrypt.hash(password, 12);
      passwordClause = ', password_hash = $4';
      params.push(hash, req.params.id);
    } else {
      params.push(req.params.id);
    }
    const result = await query(
      `UPDATE users SET
        name = COALESCE($1, name),
        role = COALESCE($2, role),
        is_active = COALESCE($3, is_active)${passwordClause},
        updated_at = NOW()
       WHERE id = $${params.length}
       RETURNING id, email, name, role, is_active`,
      params
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' });
    return res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to update user' });
  }
});

// PUT /api/users/:id/assignments — replace all client assignments
router.put('/:id/assignments', requireAdmin, async (req, res) => {
  try {
    const { client_ids = [] } = req.body as { client_ids: string[] };
    const userId = req.params.id;

    // Replace client assignments
    await query('DELETE FROM user_clients WHERE user_id = $1', [userId]);
    for (const cid of client_ids) {
      await query('INSERT INTO user_clients (user_id, client_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, cid]);
    }

    return res.json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to update assignments' });
  }
});

export default router;
