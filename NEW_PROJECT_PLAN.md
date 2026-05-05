# 🚀 New Project Starter Plan: SyncFlow Architecture

This plan provides a step-by-step guide to initializing a new project using the same architecture as the Shopify Inventory Sync tool (Express + React + PostgreSQL + Vite).

---

## Phase 1: Project Initialization

### 1. Create Directory & Initialize NPM
```powershell
mkdir my-sync-app
cd my-sync-app
npm init -y
```

### 2. Install Dependencies
```powershell
# Backend & Utilities
npm install express pg dotenv cors jsonwebtoken bcryptjs googleapis
npm install -D tsx typescript @types/node @types/express @types/pg @types/cors @types/jsonwebtoken @types/bcryptjs esbuild

# Frontend (Vite + React)
npm install react react-dom react-router-dom lucide-react motion
npm install -D vite @vitejs/plugin-react tailwindcss @tailwindcss/vite autoprefixer
```

### 3. Create Directory Structure
```powershell
mkdir src src/components src/pages src/lib src/hooks scripts prisma
```

---

## Phase 2: Backend Setup (`server.ts`)

Create a `server.ts` in the root with this minimal boilerplate:

```typescript
import express from 'express';
import pg from 'pg';
import dotenv from 'dotenv';
import cors from 'cors';
import path from 'path';

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// Simple Health Check
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// Serve Frontend in Production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static('dist'));
  app.get('*', (req, res) => res.sendFile(path.resolve('dist', 'index.html')));
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
```

---

## Phase 3: Frontend Setup (Vite & Tailwind)

### 1. Configure `vite.config.ts`
```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': 'http://localhost:8080'
    }
  }
});
```

### 2. Create `src/lib/api.ts`
This is your "Axios-like" wrapper for backend calls:

```typescript
export const api = {
  async fetch(url: string, options: any = {}) {
    const token = localStorage.getItem('token');
    const headers = {
      'Content-Type': 'application/json',
      ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
      ...options.headers
    };
    const res = await fetch(url, { ...options, headers });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },
  get(url: string) { return this.fetch(url, { method: 'GET' }); },
  post(url: string, body: any) { return this.fetch(url, { method: 'POST', body: JSON.stringify(body) }); }
};
```

---

## Phase 4: Build & Dev Scripts

Update your `package.json` scripts:

```json
"scripts": {
  "dev": "tsx server.ts",
  "build": "vite build && esbuild server.ts --bundle --platform=node --outfile=dist/server.cjs --external:express --external:pg --external:dotenv --external:cors",
  "start": "node dist/server.cjs"
}
```

---

## Phase 5: Environment Setup (`.env`)

Create a `.env` file with these keys:

```text
DATABASE_URL=postgres://user:pass@localhost:5432/dbname
JWT_SECRET=your_super_secret_key
PORT=8080
NODE_ENV=development

# If using Shopify/Google
SHOPIFY_API_KEY=...
GOOGLE_SERVICE_ACCOUNT_JSON='{"type": "service_account", ...}'
```

---

## Next Steps
1. **Database:** Run your first `CREATE TABLE` commands in PostgreSQL.
2. **Auth:** Implement `/api/login` and `/api/register` in `server.ts`.
3. **Pages:** Create your first component in `src/pages/Dashboard.tsx` and link it in `App.tsx`.
