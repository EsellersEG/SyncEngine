-- Amazon Apps table for storing SP-API app credentials
CREATE TABLE IF NOT EXISTS amazon_apps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  app_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  client_secret TEXT NOT NULL,
  region TEXT DEFAULT 'eu',
  is_default BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Table for storing OAuth tokens before they're linked to a channel
CREATE TABLE IF NOT EXISTS amazon_oauth_tokens (
  seller_id TEXT PRIMARY KEY,
  refresh_token TEXT NOT NULL,
  app_id UUID REFERENCES amazon_apps(id) ON DELETE CASCADE,
  client_id TEXT,
  linked_channel_id UUID REFERENCES channels(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast lookup
CREATE INDEX IF NOT EXISTS idx_amazon_apps_app_id ON amazon_apps(app_id);
CREATE INDEX IF NOT EXISTS idx_amazon_oauth_tokens_app_id ON amazon_oauth_tokens(app_id);
