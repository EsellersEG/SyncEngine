import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';
import { query } from '../db.js';

export interface AuthRequest extends Request {
  user?: {
    id: string;
    email: string;
    role: string;
    name: string;
  };
}

export const authenticate = (req: AuthRequest, res: Response, next: NextFunction): void => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized: No token provided' });
    return;
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as AuthRequest['user'];
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }
};

export const requireAdmin = (req: AuthRequest, res: Response, next: NextFunction): void => {
  if (req.user?.role !== 'admin') {
    res.status(403).json({ error: 'Forbidden: Admin access required' });
    return;
  }
  next();
};

export const requireAdminOrEmployee = (req: AuthRequest, res: Response, next: NextFunction): void => {
  if (req.user?.role !== 'admin' && req.user?.role !== 'employee') {
    res.status(403).json({ error: 'Forbidden: Admin or Employee access required' });
    return;
  }
  next();
};

// Block ALL write operations for client users, except order retry
export const blockClientWrites = (req: AuthRequest, res: Response, next: NextFunction): void => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (!req.user || req.user.role !== 'client') return next();
  // Allow order retry: POST /api/orders/:id/retry
  if (req.method === 'POST' && /^\/api\/orders\/[^/]+\/retry$/.test(req.originalUrl)) return next();
  res.status(403).json({ error: 'Forbidden: Clients have view-only access' });
};

// Allow only order owner or admin
export const requireOrderOwnerOrAdmin = async (req: AuthRequest, res: Response, next: NextFunction) => {
  const orderId = req.params.id;
  if (req.user?.role === 'admin') return next();
  if (!orderId) return res.status(400).json({ error: 'Order ID required' });
  const result = await query('SELECT client_id FROM orders WHERE id = $1', [orderId]);
  if (!result.rows[0]) return res.status(404).json({ error: 'Order not found' });
  const clientId = result.rows[0].client_id;
  const uc = await query('SELECT 1 FROM user_clients WHERE user_id = $1 AND client_id = $2', [req.user!.id, clientId]);
  if (uc.rows.length) return next();
  return res.status(403).json({ error: 'Forbidden: Not your order' });
};
