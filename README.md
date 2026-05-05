# 🚀 Sync-Engine

**Multi-channel commerce synchronization platform** — A mix of Baselinker and ChannelEngine.

Connect Google Sheet feeds to Shopify stores and marketplaces with intelligent, high-performance sync logic.

## Features

- 📊 **Google Sheets Feeds** — Import products with digital fingerprinting (only sync changed rows)
- 🛍️ **Shopify Sync** — Three execution pathways: Turbo Mode, Bulk Ops, Individual Mutations
- 🔄 **Smart Presets** — Price+Stock+Meta, Sync All (No Images), Full Sync
- 👥 **Multi-Client** — Manage multiple client profiles, each with their own feeds and channels
- 🗺️ **Attribute Mapping** — Map any feed column to any Shopify field
- 📈 **Live Monitoring** — Real-time sync progress, logs, and history
- 🔐 **Role-Based Auth** — Admin, Client, and Viewer roles

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Node.js + Express + TypeScript |
| Frontend | React + Vite + Tailwind CSS |
| Database | PostgreSQL |
| APIs | Shopify GraphQL, Google Sheets API v4 |
| Deploy | Railway |

## Quick Start

1. Clone and install:
```bash
git clone https://github.com/EsellersEG/SyncEngine
cd SyncEngine
npm install
```

2. Configure environment:
```bash
cp .env.example .env
# Fill in DATABASE_URL, JWT_SECRET, etc.
```

3. Initialize database:
```bash
node scripts/initDb.js
```

4. Run development server:
```bash
npm run dev
```

5. Open http://localhost:5173 and go to `/setup` to create the first admin account.

## Environment Variables

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | Secret for JWT tokens (use a long random string) |
| `PORT` | Server port (default: 8080) |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Google service account JSON for Sheets API |

## Deployment (Railway)

This app is pre-configured for Railway deployment:

1. Connect your GitHub repo to Railway
2. Add a PostgreSQL plugin
3. Set environment variables (Railway auto-sets `DATABASE_URL`)
4. Deploy — Railway uses `railway.toml` for build/start commands

## Roadmap

- **Phase 1** ✅ Shopify + Google Sheets
- **Phase 2** 🚧 Amazon, Bol.com, Kaufland, Cdiscount
- **Phase 3** 🔮 AI-powered enrichment, bulk marketplace templates
