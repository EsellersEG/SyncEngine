import { google } from 'googleapis';
import crypto from 'crypto';
import { query } from '../db.js';
import { fetchOdooProducts, type OdooConfig } from './odooService.js';
import { runSyncJob } from './shopifySyncService.js';

// In-memory import progress tracking
const importProgress: Map<string, { total: number; processed: number; status: 'running' | 'done' | 'error'; error?: string }> = new Map();

export function getImportProgress(feedId: string) {
  return importProgress.get(feedId) || null;
}

interface FeedRow {
  [key: string]: string | number | null;
}

interface FeedRecord {
  id: string;
  client_id: string;
  type?: string;
  spreadsheet_id: string;
  sheet_name: string;
  header_row: number;
  service_account_json: string;
  odoo_url?: string;
  odoo_database?: string;
  odoo_username?: string;
  odoo_api_key?: string;
  odoo_search_by?: 'automatic' | 'sku' | 'ean' | 'name';
  odoo_warehouse_id?: number | null;
  odoo_warehouse_name?: string | null;
}

function getAuthClient(serviceAccountJson?: string | null) {
  const json = serviceAccountJson || process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!json) {
    throw new Error('No Google service account credentials found. Set GOOGLE_SERVICE_ACCOUNT_JSON environment variable or provide credentials per feed.');
  }
  const credentials = JSON.parse(json);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  return auth;
}

export async function fetchSheetData(feed: FeedRecord): Promise<{ headers: string[]; rows: FeedRow[] }> {
  const auth = getAuthClient(feed.service_account_json);
  const sheets = google.sheets({ version: 'v4', auth });

  let response;
  try {
    response = await sheets.spreadsheets.values.get({
      spreadsheetId: feed.spreadsheet_id,
      range: feed.sheet_name,
    });
  } catch (err: unknown) {
    // If sheet name fails, list actual sheet names to help the user
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('Unable to parse range')) {
      try {
        const meta = await sheets.spreadsheets.get({
          spreadsheetId: feed.spreadsheet_id,
          fields: 'sheets.properties.title',
        });
        const sheetNames = meta.data.sheets?.map(s => s.properties?.title).filter(Boolean) || [];
        throw new Error(`Sheet tab "${feed.sheet_name}" not found. Available tabs: ${sheetNames.join(', ')}`);
      } catch (metaErr) {
        if (metaErr instanceof Error && metaErr.message.includes('not found')) throw metaErr;
        throw new Error(`Unable to parse range: ${feed.sheet_name}. Check that the sheet tab name is correct.`);
      }
    }
    throw err;
  }

  const rawRows = response.data.values || [];
  if (rawRows.length === 0) return { headers: [], rows: [] };

  const headerIndex = feed.header_row - 1;
  const headers = rawRows[headerIndex]?.map((h: string) => String(h).trim()) || [];
  const dataRows = rawRows.slice(headerIndex + 1);

  const rows: FeedRow[] = dataRows.map(row => {
    const obj: FeedRow = {};
    headers.forEach((header: string, i: number) => {
      obj[header] = row[i] !== undefined ? String(row[i]) : null;
    });
    return obj;
  });

  return { headers, rows };
}

export async function previewFeed(feed: FeedRecord, limit = 10) {
  if (feed.type === 'odoo') {
    const config: OdooConfig = { url: feed.odoo_url!, database: feed.odoo_database!, username: feed.odoo_username!, apiKey: feed.odoo_api_key!, productSearchBy: feed.odoo_search_by || 'automatic', warehouseId: feed.odoo_warehouse_id || undefined };
    const { headers, rows } = await fetchOdooProducts(config);
    return { headers, rows: rows.slice(0, limit), total: rows.length };
  }
  const { headers, rows } = await fetchSheetData(feed);
  return { headers, rows: rows.slice(0, limit), total: rows.length };
}

export function computeFingerprint(row: FeedRow): string {
  const normalized = JSON.stringify(row, Object.keys(row).sort());
  return crypto.createHash('md5').update(normalized).digest('hex');
}

function detectSkuColumn(headers: string[]): string | null {
  const skuPatterns = ['sku', 'ean', 'barcode', 'product_id', 'id', 'asin'];
  for (const pattern of skuPatterns) {
    const match = headers.find(h => h.toLowerCase().includes(pattern));
    if (match) return match;
  }
  return null;
}

export async function importFeedProducts(feed: FeedRecord) {
  console.log(`[FeedService] Importing feed: ${feed.id} (type: ${feed.type || 'google_sheets'})`);
  importProgress.set(feed.id, { total: 0, processed: 0, status: 'running' });

  try {
    let headers: string[];
    let rows: FeedRow[];
    let skuColumn: string | null;

    if (feed.type === 'odoo') {
      // Odoo feed — fetch via XML-RPC
      const config: OdooConfig = { url: feed.odoo_url!, database: feed.odoo_database!, username: feed.odoo_username!, apiKey: feed.odoo_api_key!, productSearchBy: feed.odoo_search_by || 'automatic', warehouseId: feed.odoo_warehouse_id || undefined };
      const result = await fetchOdooProducts(config);
      headers = result.headers;
      rows = result.rows;
      skuColumn = detectOdooSkuColumn(rows, feed.odoo_search_by || 'automatic');
    } else {
      // Google Sheets feed
      const result = await fetchSheetData(feed);
      headers = result.headers;
      rows = result.rows;
      skuColumn = detectSkuColumn(headers);
    }

    if (!skuColumn) {
      console.error(`[FeedService] No SKU column found in feed ${feed.id}`);
      importProgress.set(feed.id, { total: 0, processed: 0, status: 'error', error: 'No SKU column found' });
      throw new Error('No SKU column found (looked for: sku, ean, barcode, product_id, id, asin)');
    }

    importProgress.set(feed.id, { total: rows.length, processed: 0, status: 'running' });

    let created = 0;
    let updated = 0;
    let skipped = 0;
    const changedSkus: string[] = [];

    for (const row of rows) {
      const sku = String(row[skuColumn] || '').trim();
      if (!sku) { skipped++; importProgress.set(feed.id, { total: rows.length, processed: created + updated + skipped, status: 'running' }); continue; }

      const fingerprint = computeFingerprint(row);

      try {
        // Check if product exists
        const existing = await query(
          'SELECT id, fingerprint FROM products WHERE feed_id = $1 AND sku = $2',
          [feed.id, sku]
        );

        if (existing.rows[0]) {
          if (existing.rows[0].fingerprint === fingerprint) {
            skipped++;
          } else {
            await query(
              `UPDATE products SET fingerprint = $1, raw_data = $2, last_updated_at = NOW()
               WHERE id = $3`,
              [fingerprint, JSON.stringify(row), existing.rows[0].id]
            );
            updated++;
            changedSkus.push(sku);
          }
        } else {
          await query(
            `INSERT INTO products (client_id, feed_id, sku, fingerprint, raw_data)
             VALUES ($1, $2, $3, $4, $5)`,
            [feed.client_id, feed.id, sku, fingerprint, JSON.stringify(row)]
          );
          created++;
          changedSkus.push(sku);
        }
      } catch (err) {
        console.error(`[FeedService] Error processing SKU ${sku}:`, err);
      }

      importProgress.set(feed.id, { total: rows.length, processed: created + updated + skipped, status: 'running' });
    }

    // Update feed metadata
    await query(
      'UPDATE feeds SET last_sync_at = NOW(), last_row_count = $1 WHERE id = $2',
      [rows.length, feed.id]
    );

    importProgress.set(feed.id, { total: rows.length, processed: rows.length, status: 'done' });
    // Clean up progress after 30 seconds
    setTimeout(() => importProgress.delete(feed.id), 30000);

    console.log(`[FeedService] Import complete — created: ${created}, updated: ${updated}, skipped: ${skipped}`);

    // Notify after_import automations on every completed import.
    // If nothing changed, we still update the automation run timestamp.
    if (feed.client_id) {
      triggerAutoSync(feed, changedSkus).catch(err => {
        console.error('[FeedService] Auto-sync trigger failed:', err);
      });
    }

    return { created, updated, skipped, total: rows.length };
  } catch (err) {
    const current = importProgress.get(feed.id);
    importProgress.set(feed.id, { total: current?.total || 0, processed: current?.processed || 0, status: 'error', error: String(err) });
    setTimeout(() => importProgress.delete(feed.id), 30000);
    throw err;
  }
}

function detectOdooSkuColumn(rows: FeedRow[], mode: FeedRecord['odoo_search_by']): string | null {
  const populatedCounts = {
    default_code: rows.filter(row => String(row.default_code || '').trim() !== '').length,
    barcode: rows.filter(row => String(row.barcode || '').trim() !== '').length,
    name: rows.filter(row => String(row.name || '').trim() !== '').length,
  };

  switch (mode) {
    case 'sku':
      return populatedCounts.default_code > 0 ? 'default_code' : populatedCounts.barcode > 0 ? 'barcode' : populatedCounts.name > 0 ? 'name' : null;
    case 'ean':
      return populatedCounts.barcode > 0 ? 'barcode' : populatedCounts.default_code > 0 ? 'default_code' : populatedCounts.name > 0 ? 'name' : null;
    case 'name':
      return populatedCounts.name > 0 ? 'name' : populatedCounts.default_code > 0 ? 'default_code' : populatedCounts.barcode > 0 ? 'barcode' : null;
    case 'automatic':
    default:
      if (populatedCounts.barcode > 0) return 'barcode';
      if (populatedCounts.default_code > 0) return 'default_code';
      if (populatedCounts.name > 0) return 'name';
      return null;
  }
}

/**
 * Auto-sync only the changed/created products to Shopify channels
 * that have an 'after_import' automation configured for this feed.
 */
async function triggerAutoSync(feed: FeedRecord, changedSkus: string[]) {
  // Find 'after_import' automations for this feed
  const automationsResult = await query(
    `SELECT a.*, ch.id as ch_id, ch.name as ch_name,
            ch.shopify_store_url, ch.shopify_access_token, ch.shopify_api_version, ch.settings
     FROM automations a
     JOIN channels ch ON a.channel_id = ch.id
     WHERE a.feed_id = $1
       AND a.trigger_type = 'after_import'
       AND a.action_type = 'sync_to_shopify'
       AND a.is_active = true`,
    [feed.id]
  );

  if (automationsResult.rows.length === 0) {
    console.log('[FeedService] No after_import automations for this feed');
    return;
  }

  await query(
    'UPDATE automations SET last_run_at = NOW() WHERE feed_id = $1 AND trigger_type = $2 AND action_type = $3 AND is_active = true',
    [feed.id, 'after_import', 'sync_to_shopify']
  );

  if (changedSkus.length === 0) {
    console.log('[FeedService] Import completed with no changed SKUs; after_import automations marked as run but no Shopify sync job created');
    return;
  }

  for (const automation of automationsResult.rows) {
    const channelId = automation.ch_id;
    const channelName = automation.ch_name;
    const preset = feed.type === 'odoo' ? 'price_stock_meta' : 'sync_all';

    // Check if there's already a running job for this channel
    const running = await query(
      "SELECT id FROM sync_jobs WHERE channel_id = $1 AND status = 'running'",
      [channelId]
    );
    if (running.rows.length > 0) {
      console.log(`[FeedService] Auto-sync skipped for channel ${channelName} — job already running`);
      continue;
    }

    // Create a sync job for the changed SKUs only
    const jobResult = await query(
      `INSERT INTO sync_jobs (channel_id, feed_id, preset, total_products, status, client_id)
       VALUES ($1, $2, $3, $4, 'pending', $5)
       RETURNING id`,
      [channelId, feed.id, preset, changedSkus.length, feed.client_id]
    );
    const jobId = jobResult.rows[0].id;

    console.log(`[FeedService] Auto-sync triggered → Job ${jobId} for channel ${channelName} (${changedSkus.length} changed products)`);
    runSyncJob({
      jobId,
      channel: {
        id: channelId,
        shopify_store_url: automation.shopify_store_url,
        shopify_access_token: automation.shopify_access_token,
        shopify_api_version: automation.shopify_api_version,
        settings: automation.settings,
      },
      feedId: feed.id,
      preset,
      skus: changedSkus,
      priceAdjustmentPercent: Number(automation.price_adjustment_percent || 0),
      priceRoundingMode: automation.rounding_mode === 'up' || automation.rounding_mode === 'down' ? automation.rounding_mode : 'none',
    }).catch(err => {
      console.error(`[FeedService] Auto-sync job ${jobId} failed:`, err);
    });
  }
    // Run async — no skus filter so ALL products get synced
    runSyncJob({
      jobId,
      channel: {
        id: channelId,
        shopify_store_url: automation.shopify_store_url,
        shopify_access_token: automation.shopify_access_token,
        shopify_api_version: automation.shopify_api_version,
        settings: automation.settings,
      },
      feedId: feed.id,
      preset,
      priceAdjustmentPercent: Number(automation.price_adjustment_percent || 0),
      priceRoundingMode: automation.rounding_mode === 'up' || automation.rounding_mode === 'down' ? automation.rounding_mode : 'none',
    }).catch(err => {
      console.error(`[FeedService] Auto-sync job ${jobId} failed:`, err);
    });
  }
}
