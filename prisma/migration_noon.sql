-- =============================================
-- Noon Integration Migration
-- =============================================

-- Add Noon-specific columns to channels table
ALTER TABLE channels ADD COLUMN IF NOT EXISTS noon_credentials_json TEXT;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS noon_warehouse_code VARCHAR(100);
ALTER TABLE channels ADD COLUMN IF NOT EXISTS noon_country_code VARCHAR(10);

-- Noon products mapping table (SKU → Noon partner_sku tracking)
CREATE TABLE IF NOT EXISTS noon_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
  sku VARCHAR(255) NOT NULL,
  noon_partner_sku VARCHAR(255) NOT NULL,
  noon_product_id TEXT,
  last_synced_at TIMESTAMPTZ,
  UNIQUE (channel_id, sku)
);
CREATE INDEX IF NOT EXISTS idx_noon_products_channel_sku ON noon_products(channel_id, sku);

-- Noon content jobs table (for CSV content pipeline)
CREATE TABLE IF NOT EXISTS noon_content_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
  feed_id UUID REFERENCES feeds(id) ON DELETE SET NULL,
  status VARCHAR(50) DEFAULT 'pending', -- 'pending', 'exporting', 'processing', 'uploading', 'completed', 'failed'
  export_job_id TEXT, -- Noon catalog export job ID
  total_products INT DEFAULT 0,
  processed_count INT DEFAULT 0,
  updated_count INT DEFAULT 0,
  failed_count INT DEFAULT 0,
  csv_url TEXT, -- download URL for generated CSV
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_noon_content_jobs_channel ON noon_content_jobs(channel_id);

-- Noon orders table (FBN model)
CREATE TABLE IF NOT EXISTS noon_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
  channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
  noon_order_id TEXT NOT NULL,
  noon_order_number TEXT,
  status VARCHAR(50) DEFAULT 'pending', -- 'pending', 'synced', 'failed', 'cancelled'
  total_price DECIMAL(10,2),
  customer_name VARCHAR(255),
  country_code VARCHAR(10),
  raw_data JSONB NOT NULL,
  error_message TEXT,
  synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(channel_id, noon_order_id)
);
CREATE INDEX IF NOT EXISTS idx_noon_orders_client ON noon_orders(client_id);
CREATE INDEX IF NOT EXISTS idx_noon_orders_channel ON noon_orders(channel_id);
CREATE INDEX IF NOT EXISTS idx_noon_orders_status ON noon_orders(status);
