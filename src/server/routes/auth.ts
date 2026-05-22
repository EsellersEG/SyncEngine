import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { query } from '../db.js';

const router = Router();

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const result = await query(
      'SELECT id, email, name, role, password_hash, is_active, permissions FROM users WHERE email = $1',
      [email.toLowerCase()]
    );

    const user = result.rows[0];
    if (!user || !user.is_active) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const permissions = user.permissions || [];
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, name: user.name, permissions },
      process.env.JWT_SECRET!,
      { expiresIn: '7d' }
    );

    return res.json({
      token,
      user: { id: user.id, email: user.email, name: user.name, role: user.role, permissions },
    });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/auth/setup-check — is initial setup still allowed?
router.get('/setup-check', async (_req, res) => {
  try {
    const existing = await query("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
    return res.json({ allowed: existing.rows.length === 0 });
  } catch {
    return res.json({ allowed: false });
  }
});

// POST /api/auth/register (admin-only via setup or first user)
router.post('/setup', async (req, res) => {
  try {
    // Check if any admin exists
    const existing = await query("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
    if (existing.rows.length > 0) {
      return res.status(403).json({ error: 'Setup already completed' });
    }

    const { email, password, name } = req.body;
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'email, password and name are required' });
    }

    const hash = await bcrypt.hash(password, 12);
    const result = await query(
      `INSERT INTO users (email, password_hash, name, role)
       VALUES ($1, $2, $3, 'admin') RETURNING id, email, name, role`,
      [email.toLowerCase(), hash, name]
    );

    const user = result.rows[0];
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, name: user.name },
      process.env.JWT_SECRET!,
      { expiresIn: '7d' }
    );

    return res.status(201).json({ token, user });
  } catch (err) {
    console.error('Setup error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/auth/me
router.get('/me', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as { id: string };
    const result = await query(
      'SELECT id, email, name, role, is_active, permissions, created_at FROM users WHERE id = $1',
      [decoded.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' });
    return res.json(result.rows[0]);
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
});

export default router;
