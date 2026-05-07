#!/usr/bin/env node
/**
 * Database initialization script
 * Run: node scripts/initDb.js
 * 
 * This runs the schema.sql file against your DATABASE_URL
 */

import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function init() {
  const client = await pool.connect();
  console.log('✅ Connected to database');

  try {
    const schemaPath = path.join(__dirname, '../prisma/schema.sql');
    const sql = fs.readFileSync(schemaPath, 'utf8');
    
    await client.query(sql);
    console.log('✅ Schema created successfully');
  } catch (err) {
    console.error('❌ Schema error:', err.message);
    // Tables may already exist — that's OK
    if (err.message.includes('already exists')) {
      console.log('ℹ️  Tables already exist, skipping creation');
    } else {
      throw err;
    }
  }

  // Run migrations for missing columns
  try {
    const migrations = [
      `ALTER TABLE sync_jobs ADD COLUMN IF NOT EXISTS processed_count INT DEFAULT 0`,
      `ALTER TABLE sync_jobs ADD COLUMN IF NOT EXISTS skipped_count INT DEFAULT 0`,
      `ALTER TABLE feeds ADD COLUMN IF NOT EXISTS type VARCHAR(20) DEFAULT 'google_sheets'`,
      `ALTER TABLE feeds ADD COLUMN IF NOT EXISTS odoo_url TEXT`,
      `ALTER TABLE feeds ADD COLUMN IF NOT EXISTS odoo_database VARCHAR(255)`,
      `ALTER TABLE feeds ADD COLUMN IF NOT EXISTS odoo_username VARCHAR(255)`,
      `ALTER TABLE feeds ADD COLUMN IF NOT EXISTS odoo_api_key TEXT`,
      `ALTER TABLE feeds ADD COLUMN IF NOT EXISTS sync_interval_minutes INT`,
      `ALTER TABLE feeds ALTER COLUMN spreadsheet_id DROP NOT NULL`,
      `CREATE TABLE IF NOT EXISTS orders (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
        channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
        shopify_order_id TEXT NOT NULL,
        shopify_order_number TEXT,
        odoo_order_id INT,
        status VARCHAR(50) DEFAULT 'pending',
        total_price DECIMAL(10,2),
        customer_email VARCHAR(255),
        raw_data JSONB NOT NULL,
        error_message TEXT,
        synced_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(channel_id, shopify_order_id)
      )`,
    ];
    for (const sql of migrations) {
      await client.query(sql);
    }
    console.log('✅ Migrations applied');
  } catch (err) {
    console.error('⚠️  Migration warning:', err.message);
  }

  client.release();
  await pool.end();
}

init().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
