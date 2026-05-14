-- =============================================
-- Amazon SP-API Integration Migration
-- =============================================

-- Add Amazon-specific columns to channels table
ALTER TABLE channels ADD COLUMN IF NOT EXISTS amazon_credentials_json TEXT;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS amazon_marketplace_ids TEXT;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS amazon_region VARCHAR(10);

-- Amazon products mapping table (SKU → ASIN tracking)
CREATE TABLE IF NOT EXISTS amazon_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
  sku VARCHAR(255) NOT NULL,
  asin VARCHAR(20),
  amazon_product_type VARCHAR(255) DEFAULT 'PRODUCT',
  last_synced_at TIMESTAMPTZ,
  UNIQUE (channel_id, sku)
);
CREATE INDEX IF NOT EXISTS idx_amazon_products_channel_sku ON amazon_products(channel_id, sku);

-- Amazon feed submission tracking
CREATE TABLE IF NOT EXISTS amazon_feed_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
  feed_id UUID REFERENCES feeds(id) ON DELETE SET NULL,
  sync_job_id UUID REFERENCES sync_jobs(id) ON DELETE SET NULL,
  amazon_feed_id TEXT,
  amazon_feed_document_id TEXT,
  amazon_result_document_id TEXT,
  status VARCHAR(50) DEFAULT 'pending', -- 'pending', 'uploading', 'submitted', 'processing', 'done', 'fatal', 'cancelled'
  total_messages INT DEFAULT 0,
  processed_count INT DEFAULT 0,
  successful_count INT DEFAULT 0,
  failed_count INT DEFAULT 0,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_amazon_feed_jobs_channel ON amazon_feed_jobs(channel_id);
CREATE INDEX IF NOT EXISTS idx_amazon_feed_jobs_sync ON amazon_feed_jobs(sync_job_id);

-- Amazon orders table (FBA + FBM)
CREATE TABLE IF NOT EXISTS amazon_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
  channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
  amazon_order_id TEXT NOT NULL,
  amazon_order_number TEXT,
  status VARCHAR(50) DEFAULT 'pending', -- 'pending', 'synced', 'failed', 'cancelled'
  order_status VARCHAR(50), -- Amazon status: Unshipped, Shipped, Canceled, etc.
  total_price DECIMAL(10,2),
  currency VARCHAR(10),
  customer_name VARCHAR(255),
  marketplace_id VARCHAR(50),
  fulfillment_channel VARCHAR(10), -- 'MFN' (FBM) or 'AFN' (FBA)
  raw_data JSONB NOT NULL,
  error_message TEXT,
  synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(channel_id, amazon_order_id)
);
CREATE INDEX IF NOT EXISTS idx_amazon_orders_client ON amazon_orders(client_id);
CREATE INDEX IF NOT EXISTS idx_amazon_orders_channel ON amazon_orders(channel_id);
CREATE INDEX IF NOT EXISTS idx_amazon_orders_status ON amazon_orders(status);
