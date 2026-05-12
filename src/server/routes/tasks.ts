import { Router } from 'express';
import { query } from '../db.js';
import { authenticate, requireAdminOrEmployee, type AuthRequest } from '../middleware/auth.js';

const router = Router();
router.use(authenticate);
router.use(requireAdminOrEmployee);

// GET /api/tasks
router.get('/', async (req: AuthRequest, res) => {
  try {
    const { client_id, status } = req.query;
    const isAdmin = req.user!.role === 'admin';
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (client_id) {
      conditions.push(`t.client_id = $${idx++}::uuid`);
      params.push(client_id);
    }
    if (status) {
      conditions.push(`t.status = $${idx++}`);
      params.push(status);
    }
    // Employees see only tasks for their assigned clients or tasks assigned to them
    if (!isAdmin) {
      conditions.push(`(t.client_id IN (SELECT uc.client_id FROM user_clients uc WHERE uc.user_id = $${idx}::uuid) OR t.assigned_to = $${idx}::uuid OR t.created_by = $${idx}::uuid)`);
      params.push(req.user!.id);
      idx++;
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await query(
      `SELECT t.*, c.name as client_name, 
              u1.name as assigned_to_name, u2.name as created_by_name
       FROM tasks t
       LEFT JOIN clients c ON c.id = t.client_id
       LEFT JOIN users u1 ON u1.id = t.assigned_to
       LEFT JOIN users u2 ON u2.id = t.created_by
       ${where}
       ORDER BY t.created_at DESC`,
      params
    );
    return res.json(result.rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch tasks' });
  }
});

// POST /api/tasks
router.post('/', async (req: AuthRequest, res) => {
  try {
    const { title, client_id, status = 'not_started', task_type, comment, assigned_to } = req.body;
    if (!title) return res.status(400).json({ error: 'Title is required' });

    const result = await query(
      `INSERT INTO tasks (title, client_id, status, task_type, comment, assigned_to, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [title, client_id || null, status, task_type || null, comment || null, assigned_to || null, req.user!.id]
    );

    // Re-fetch with joins
    const full = await query(
      `SELECT t.*, c.name as client_name, u1.name as assigned_to_name, u2.name as created_by_name
       FROM tasks t LEFT JOIN clients c ON c.id = t.client_id
       LEFT JOIN users u1 ON u1.id = t.assigned_to LEFT JOIN users u2 ON u2.id = t.created_by
       WHERE t.id = $1`,
      [result.rows[0].id]
    );
    return res.status(201).json(full.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to create task' });
  }
});

// PATCH /api/tasks/:id
router.patch('/:id', async (req: AuthRequest, res) => {
  try {
    const { title, client_id, status, task_type, comment, assigned_to } = req.body;
    const result = await query(
      `UPDATE tasks SET
        title = COALESCE($1, title),
        client_id = $2,
        status = COALESCE($3, status),
        task_type = $4,
        comment = $5,
        assigned_to = $6,
        updated_at = NOW()
       WHERE id = $7
       RETURNING *`,
      [title, client_id ?? null, status, task_type ?? null, comment ?? null, assigned_to ?? null, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Task not found' });

    const full = await query(
      `SELECT t.*, c.name as client_name, u1.name as assigned_to_name, u2.name as created_by_name
       FROM tasks t LEFT JOIN clients c ON c.id = t.client_id
       LEFT JOIN users u1 ON u1.id = t.assigned_to LEFT JOIN users u2 ON u2.id = t.created_by
       WHERE t.id = $1`,
      [req.params.id]
    );
    return res.json(full.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to update task' });
  }
});

// DELETE /api/tasks/:id
router.delete('/:id', async (req: AuthRequest, res) => {
  try {
    // Only admin or task creator can delete
    const task = await query('SELECT created_by FROM tasks WHERE id = $1', [req.params.id]);
    if (!task.rows[0]) return res.status(404).json({ error: 'Task not found' });

    if (req.user!.role !== 'admin' && task.rows[0].created_by !== req.user!.id) {
      return res.status(403).json({ error: 'Only admin or task creator can delete' });
    }

    await query('DELETE FROM tasks WHERE id = $1', [req.params.id]);
    return res.json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to delete task' });
  }
});

export default router;
