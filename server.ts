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

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// ── Middleware ─────────────────────────────────────────────────────────────
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));

// ── API Routes ─────────────────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/clients', clientRoutes);
app.use('/api/feeds', feedRoutes);
app.use('/api/channels', channelRoutes);
app.use('/api/products', productRoutes);
app.use('/api/sync', syncRoutes);
app.use('/api/mappings', mappingRoutes);

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
app.listen(PORT, () => {
  console.log(`🚀 Sync-Engine server running on port ${PORT}`);
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
});

export default app;
