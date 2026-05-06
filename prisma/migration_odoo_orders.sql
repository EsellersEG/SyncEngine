-- Migration: Add Odoo support to feeds + Orders table
-- Run this against the live PostgreSQL database

-- Add new columns to feeds table
ALTER TABLE feeds ADD COLUMN IF NOT EXISTS type VARCHAR(20) DEFAULT 'google_sheets';
ALTER TABLE feeds ADD COLUMN IF NOT EXISTS odoo_url TEXT;
ALTER TABLE feeds ADD COLUMN IF NOT EXISTS odoo_database VARCHAR(255);
ALTER TABLE feeds ADD COLUMN IF NOT EXISTS odoo_username VARCHAR(255);
ALTER TABLE feeds ADD COLUMN IF NOT EXISTS odoo_api_key TEXT;
ALTER TABLE feeds ADD COLUMN IF NOT EXISTS sync_interval_minutes INT;

-- Make spreadsheet_id nullable (Odoo feeds don't have it)
ALTER TABLE feeds ALTER COLUMN spreadsheet_id DROP NOT NULL;

-- Create orders table
CREATE TABLE IF NOT EXISTS orders (
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
);
CREATE INDEX IF NOT EXISTS idx_orders_client ON orders(client_id);
CREATE INDEX IF NOT EXISTS idx_orders_channel ON orders(channel_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
