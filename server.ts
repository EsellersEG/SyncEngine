import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Routes
import authRoutes from './src/server/routes/auth.js';
import clientRoutes from './src/server/routes/clients.js';
import feedRoutes from './src/server/routes/feeds.js';
import channelRoutes from './src/server/routes/channels.js';
import productRoutes from './src/server/routes/products.js';
import syncRoutes from './src/server/routes/sync.js';
import mappingRoutes from './src/server/routes/mappings.js';
import userRoutes from './src/server/routes/users.js';
import orderRoutes from './src/server/routes/orders.js';
import webhookRoutes from './src/server/routes/webhooks.js';
import automationRoutes from './src/server/routes/automations.js';
import invoiceRoutes from './src/server/routes/invoices.js';
import taskRoutes from './src/server/routes/tasks.js';
import noonRoutes from './src/server/routes/noon.js';
import amazonRoutes from './src/server/routes/amazon.js';
import { startScheduler } from './src/server/services/scheduler.js';
import { query } from './src/server/db.js';
import { blockClientWrites, type AuthRequest } from './src/server/middleware/auth.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// ── Middleware ─────────────────────────────────────────────────────────────
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}));

// Capture raw body for webhook HMAC verification
app.use('/webhooks', express.json({
  limit: '10mb',
  verify: (req, _res, buf) => { (req as unknown as Record<string, unknown>).rawBody = buf.toString('utf8'); },
}));
app.use(express.json({ limit: '10mb' }));

// Block all write operations for client users (except order retry)
app.use('/api', blockClientWrites as unknown as import('express').RequestHandler);

// ── API Routes ─────────────────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/clients', clientRoutes);
app.use('/api/feeds', feedRoutes);
app.use('/api/channels', channelRoutes);
app.use('/api/products', productRoutes);
app.use('/api/sync', syncRoutes);
app.use('/api/mappings', mappingRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/automations', automationRoutes);
app.use('/api/invoices', invoiceRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/noon', noonRoutes);
app.use('/api/amazon', amazonRoutes);
app.use('/webhooks', webhookRoutes);

// ── Health Check ───────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', version: '1.0.0', timestamp: new Date().toISOString() });
});

// ── Serve Frontend ─────────────────────────────────────────────────────────
// The server is bundled to dist/server.js, so dist/client is a sibling folder.
// We use import.meta.url so this works correctly regardless of cwd.
const __serverDir = path.dirname(fileURLToPath(import.meta.url));
const clientPath = path.join(__serverDir, 'client');
console.log(`Serving frontend from: ${clientPath}`);
app.use(express.static(clientPath));
app.get('/{*path}', (_req, res) => {
  res.sendFile(path.join(clientPath, 'index.html'));
});

// ── Start Server ───────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '8080', 10);
app.listen(PORT, async () => {
  console.log(`🚀 Sync-Engine server running on port ${PORT}`);
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);

  // Clean up orphaned running/pending jobs from previous deploys/crashes
  try {
    const cleaned = await query(
      `UPDATE sync_jobs SET status = 'failed', completed_at = NOW(),
              error_message = 'Server restarted during sync — job was interrupted'
       WHERE status IN ('running', 'pending')
         AND started_at < NOW() - INTERVAL '10 minutes'
       RETURNING id`
    );
    if (cleaned.rows.length > 0) {
      console.log(`[Startup] Cleaned ${cleaned.rows.length} orphaned sync jobs: ${cleaned.rows.map((r: { id: string }) => r.id).join(', ')}`);
    }
    // Also clean pending jobs that never started (no started_at)
    const cleanedPending = await query(
      `UPDATE sync_jobs SET status = 'failed', completed_at = NOW(),
              error_message = 'Server restarted — job never started'
       WHERE status = 'pending'
         AND created_at < NOW() - INTERVAL '10 minutes'
       RETURNING id`
    );
    if (cleanedPending.rows.length > 0) {
      console.log(`[Startup] Cleaned ${cleanedPending.rows.length} stale pending jobs`);
    }
  } catch (err) {
    console.error('[Startup] Failed to clean orphaned jobs:', err);
  }

  startScheduler();
});

export default app;
