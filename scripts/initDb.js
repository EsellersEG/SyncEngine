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
      `ALTER TABLE sync_jobs ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES clients(id) ON DELETE CASCADE`,
      `ALTER TABLE sync_jobs ADD COLUMN IF NOT EXISTS processed_count INT DEFAULT 0`,
      `ALTER TABLE sync_jobs ADD COLUMN IF NOT EXISTS skipped_count INT DEFAULT 0`,
      `ALTER TABLE feeds ADD COLUMN IF NOT EXISTS type VARCHAR(20) DEFAULT 'google_sheets'`,
      `ALTER TABLE feeds ADD COLUMN IF NOT EXISTS odoo_url TEXT`,
      `ALTER TABLE feeds ADD COLUMN IF NOT EXISTS odoo_database VARCHAR(255)`,
      `ALTER TABLE feeds ADD COLUMN IF NOT EXISTS odoo_username VARCHAR(255)`,
      `ALTER TABLE feeds ADD COLUMN IF NOT EXISTS odoo_api_key TEXT`,
      `ALTER TABLE feeds ADD COLUMN IF NOT EXISTS odoo_search_by VARCHAR(20) NOT NULL DEFAULT 'automatic'`,
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
      `CREATE TABLE IF NOT EXISTS automations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        trigger_type VARCHAR(50) NOT NULL DEFAULT 'schedule',
        action_type VARCHAR(50) NOT NULL DEFAULT 'import_feed',
        feed_id UUID REFERENCES feeds(id) ON DELETE SET NULL,
        channel_id UUID REFERENCES channels(id) ON DELETE SET NULL,
        interval_minutes INT,
        price_adjustment_percent DECIMAL(5,2) DEFAULT 0,
        rounding_mode VARCHAR(20) NOT NULL DEFAULT 'none',
        is_active BOOLEAN DEFAULT true,
        last_run_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`,
      `ALTER TABLE automations ADD COLUMN IF NOT EXISTS price_adjustment_percent DECIMAL(5,2) DEFAULT 0`,
      `ALTER TABLE automations ADD COLUMN IF NOT EXISTS rounding_mode VARCHAR(20) NOT NULL DEFAULT 'none'`,
      `ALTER TABLE orders ADD COLUMN IF NOT EXISTS odoo_order_name VARCHAR(100)`,
      `ALTER TABLE feeds ADD COLUMN IF NOT EXISTS odoo_warehouse_id INT`,
      `ALTER TABLE feeds ADD COLUMN IF NOT EXISTS odoo_warehouse_name TEXT`,
      `ALTER TABLE feeds ADD COLUMN IF NOT EXISTS order_tax_included_percent DECIMAL(5,2)`,
      `ALTER TABLE clients ADD COLUMN IF NOT EXISTS address TEXT`,
      `ALTER TABLE clients ADD COLUMN IF NOT EXISTS phone VARCHAR(50)`,
      `ALTER TABLE clients ADD COLUMN IF NOT EXISTS email VARCHAR(255)`,
      `ALTER TABLE clients ADD COLUMN IF NOT EXISTS tax_id VARCHAR(100)`,
      `CREATE TABLE IF NOT EXISTS user_feeds (
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        feed_id UUID REFERENCES feeds(id) ON DELETE CASCADE,
        PRIMARY KEY (user_id, feed_id)
      )`,
      `CREATE TABLE IF NOT EXISTS user_channels (
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
        PRIMARY KEY (user_id, channel_id)
      )`,
      `CREATE TABLE IF NOT EXISTS invoices (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
        invoice_number VARCHAR(50) NOT NULL UNIQUE,
        status VARCHAR(20) NOT NULL DEFAULT 'draft',
        issue_date DATE NOT NULL DEFAULT CURRENT_DATE,
        due_date DATE,
        currency VARCHAR(10) NOT NULL DEFAULT 'EGP',
        subtotal DECIMAL(12,2) NOT NULL DEFAULT 0,
        tax_percent DECIMAL(5,2) NOT NULL DEFAULT 0,
        tax_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
        total DECIMAL(12,2) NOT NULL DEFAULT 0,
        notes TEXT,
        paid_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`,
      `CREATE TABLE IF NOT EXISTS invoice_items (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
        description TEXT NOT NULL,
        quantity DECIMAL(10,2) NOT NULL DEFAULT 1,
        unit_price DECIMAL(12,2) NOT NULL DEFAULT 0,
        total DECIMAL(12,2) NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`,
      `CREATE TABLE IF NOT EXISTS settings (
        key VARCHAR(100) PRIMARY KEY,
        value TEXT NOT NULL DEFAULT '',
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`,
      `CREATE TABLE IF NOT EXISTS tasks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title VARCHAR(500) NOT NULL,
        client_id UUID REFERENCES clients(id) ON DELETE SET NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'not_started',
        task_type VARCHAR(255),
        comment TEXT,
        assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
        created_by UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`,
      // Noon integration columns
      `ALTER TABLE channels ADD COLUMN IF NOT EXISTS noon_credentials_json TEXT`,
      `ALTER TABLE channels ADD COLUMN IF NOT EXISTS noon_warehouse_code VARCHAR(100)`,
      `ALTER TABLE channels ADD COLUMN IF NOT EXISTS noon_country_code VARCHAR(10)`,
      `CREATE TABLE IF NOT EXISTS noon_products (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
        sku VARCHAR(255) NOT NULL,
        noon_partner_sku VARCHAR(255) NOT NULL,
        noon_product_id TEXT,
        last_synced_at TIMESTAMPTZ,
        UNIQUE (channel_id, sku)
      )`,
      `CREATE TABLE IF NOT EXISTS noon_content_jobs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
        feed_id UUID REFERENCES feeds(id) ON DELETE SET NULL,
        status VARCHAR(50) DEFAULT 'pending',
        export_job_id TEXT,
        total_products INT DEFAULT 0,
        processed_count INT DEFAULT 0,
        updated_count INT DEFAULT 0,
        failed_count INT DEFAULT 0,
        csv_url TEXT,
        error_message TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        completed_at TIMESTAMPTZ
      )`,
      `CREATE TABLE IF NOT EXISTS noon_orders (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
        channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
        noon_order_id TEXT NOT NULL,
        noon_order_number TEXT,
        status VARCHAR(50) DEFAULT 'pending',
        total_price DECIMAL(10,2),
        customer_name VARCHAR(255),
        country_code VARCHAR(10),
        raw_data JSONB NOT NULL,
        error_message TEXT,
        synced_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(channel_id, noon_order_id)
      )`,
      // Amazon integration columns
      `ALTER TABLE channels ADD COLUMN IF NOT EXISTS amazon_credentials_json TEXT`,
      `ALTER TABLE channels ADD COLUMN IF NOT EXISTS amazon_marketplace_ids TEXT`,
      `ALTER TABLE channels ADD COLUMN IF NOT EXISTS amazon_region VARCHAR(10)`,
      `CREATE TABLE IF NOT EXISTS amazon_products (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
        sku VARCHAR(255) NOT NULL,
        asin VARCHAR(20),
        amazon_product_type VARCHAR(255) DEFAULT 'PRODUCT',
        last_synced_at TIMESTAMPTZ,
        UNIQUE (channel_id, sku)
      )`,
      `CREATE TABLE IF NOT EXISTS amazon_feed_jobs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
        feed_id UUID REFERENCES feeds(id) ON DELETE SET NULL,
        sync_job_id UUID REFERENCES sync_jobs(id) ON DELETE SET NULL,
        amazon_feed_id TEXT,
        amazon_feed_document_id TEXT,
        amazon_result_document_id TEXT,
        status VARCHAR(50) DEFAULT 'pending',
        total_messages INT DEFAULT 0,
        processed_count INT DEFAULT 0,
        successful_count INT DEFAULT 0,
        failed_count INT DEFAULT 0,
        error_message TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        completed_at TIMESTAMPTZ
      )`,
      `CREATE TABLE IF NOT EXISTS amazon_orders (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
        channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
        amazon_order_id TEXT NOT NULL,
        amazon_order_number TEXT,
        status VARCHAR(50) DEFAULT 'pending',
        order_status VARCHAR(50),
        total_price DECIMAL(10,2),
        currency VARCHAR(10),
        customer_name VARCHAR(255),
        marketplace_id VARCHAR(50),
        fulfillment_channel VARCHAR(10),
        raw_data JSONB NOT NULL,
        error_message TEXT,
        synced_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(channel_id, amazon_order_id)
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
