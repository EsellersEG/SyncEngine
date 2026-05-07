-- =============================================
-- Sync-Engine Database Schema
-- =============================================

-- Users & Auth
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name VARCHAR(255) NOT NULL,
  role VARCHAR(50) NOT NULL DEFAULT 'client', -- 'admin', 'client', 'viewer'
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Client Profiles
CREATE TABLE clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(100) UNIQUE NOT NULL,
  logo_url TEXT,
  created_by UUID REFERENCES users(id),
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Many-to-Many: Users ↔ Clients
CREATE TABLE user_clients (
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
  role VARCHAR(50) DEFAULT 'viewer', -- 'manager', 'viewer'
  PRIMARY KEY (user_id, client_id)
);

-- Feeds (Google Sheets / Odoo connections)
CREATE TABLE feeds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  type VARCHAR(20) DEFAULT 'google_sheets', -- 'google_sheets', 'odoo'
  spreadsheet_id TEXT,
  sheet_name VARCHAR(255) DEFAULT 'Sheet1',
  header_row INT DEFAULT 1,
  service_account_json TEXT, -- encrypted JSON
  -- Odoo specific
  odoo_url TEXT,
  odoo_database VARCHAR(255),
  odoo_username VARCHAR(255),
  odoo_api_key TEXT,
  -- Scheduling
  sync_interval_minutes INT,
  last_sync_at TIMESTAMPTZ,
  last_row_count INT DEFAULT 0,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Channels (Shopify stores / marketplaces)
CREATE TABLE channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  type VARCHAR(50) NOT NULL, -- 'shopify', 'amazon', 'bol', 'kaufland', 'cdiscount'
  status VARCHAR(50) DEFAULT 'active', -- 'active', 'paused', 'error'
  -- Shopify specific
  shopify_store_url TEXT,
  shopify_access_token TEXT, -- encrypted
  shopify_api_version VARCHAR(20) DEFAULT '2024-10',
  -- Common
  settings JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Products imported from feeds
CREATE TABLE products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
  feed_id UUID REFERENCES feeds(id) ON DELETE CASCADE,
  sku VARCHAR(255) NOT NULL,
  fingerprint TEXT NOT NULL, -- MD5 hash of row for change detection
  raw_data JSONB NOT NULL, -- original feed row data
  status VARCHAR(50) DEFAULT 'active', -- 'active', 'archived', 'error'
  first_seen_at TIMESTAMPTZ DEFAULT NOW(),
  last_updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (feed_id, sku)
);

-- Attribute Mappings (Feed column → Channel field)
CREATE TABLE attribute_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feed_id UUID REFERENCES feeds(id) ON DELETE CASCADE,
  channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
  feed_column VARCHAR(255) NOT NULL,  -- e.g. "Price_EUR"
  target_field VARCHAR(255) NOT NULL, -- e.g. "variant.price"
  transform TEXT, -- optional JS/JSON transform expression
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Sync Jobs
CREATE TABLE sync_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
  channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
  feed_id UUID REFERENCES feeds(id),
  triggered_by UUID REFERENCES users(id),
  preset VARCHAR(100), -- 'price_stock_meta', 'sync_all_no_images', 'sync_all', 'custom'
  fields TEXT[], -- specific fields if custom
  status VARCHAR(50) DEFAULT 'pending', -- 'pending','running','completed','failed','cancelled'
  total_products INT DEFAULT 0,
  processed_count INT DEFAULT 0,
  created_count INT DEFAULT 0,
  updated_count INT DEFAULT 0,
  failed_count INT DEFAULT 0,
  skipped_count INT DEFAULT 0,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Sync Log Entries (per-product log within a job)
CREATE TABLE sync_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID REFERENCES sync_jobs(id) ON DELETE CASCADE,
  sku VARCHAR(255),
  action VARCHAR(50), -- 'created', 'updated', 'skipped', 'failed'
  message TEXT,
  details JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Shopify Products (SKU → Shopify GID mapping)
CREATE TABLE shopify_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
  sku VARCHAR(255) NOT NULL,
  shopify_product_id TEXT NOT NULL,
  shopify_variant_id TEXT NOT NULL,
  shopify_inventory_item_id TEXT,
  last_synced_at TIMESTAMPTZ,
  UNIQUE (channel_id, sku)
);

-- Indexes
CREATE INDEX idx_products_client ON products(client_id);
CREATE INDEX idx_products_feed ON products(feed_id);
CREATE INDEX idx_products_sku ON products(sku);
CREATE INDEX idx_sync_jobs_channel ON sync_jobs(channel_id);
CREATE INDEX idx_sync_logs_job ON sync_logs(job_id);
CREATE INDEX idx_shopify_products_channel_sku ON shopify_products(channel_id, sku);

-- Orders (Shopify → Odoo sync)
CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
  channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
  shopify_order_id TEXT NOT NULL,
  shopify_order_number TEXT,
  odoo_order_id INT,
  status VARCHAR(50) DEFAULT 'pending', -- 'pending', 'synced', 'failed'
  total_price DECIMAL(10,2),
  customer_email VARCHAR(255),
  raw_data JSONB NOT NULL,
  error_message TEXT,
  synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(channel_id, shopify_order_id)
);
CREATE INDEX idx_orders_client ON orders(client_id);
CREATE INDEX idx_orders_channel ON orders(channel_id);
CREATE INDEX idx_orders_status ON orders(status);

-- Automations
CREATE TABLE automations (
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
  is_active BOOLEAN DEFAULT TRUE,
  last_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_automations_client ON automations(client_id);
CREATE INDEX idx_automations_feed ON automations(feed_id);
CREATE INDEX idx_automations_channel ON automations(channel_id);
