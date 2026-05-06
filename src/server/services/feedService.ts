import { google } from 'googleapis';
import crypto from 'crypto';
import { query } from '../db.js';

interface FeedRow {
  [key: string]: string | number | null;
}

interface FeedRecord {
  id: string;
  client_id: string;
  spreadsheet_id: string;
  sheet_name: string;
  header_row: number;
  service_account_json: string;
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

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: feed.spreadsheet_id,
    range: feed.sheet_name,
  });

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
  console.log(`[FeedService] Importing feed: ${feed.id}`);
  const { headers, rows } = await fetchSheetData(feed);

  const skuColumn = detectSkuColumn(headers);
  if (!skuColumn) {
    console.error(`[FeedService] No SKU column found in feed ${feed.id}`);
    throw new Error('No SKU column found (looked for: sku, ean, barcode, product_id, id, asin)');
  }

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const row of rows) {
    const sku = String(row[skuColumn] || '').trim();
    if (!sku) { skipped++; continue; }

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
          continue; // No change
        }
        // Update
        await query(
          `UPDATE products SET fingerprint = $1, raw_data = $2, last_updated_at = NOW()
           WHERE id = $3`,
          [fingerprint, JSON.stringify(row), existing.rows[0].id]
        );
        updated++;
      } else {
        // Insert
        await query(
          `INSERT INTO products (client_id, feed_id, sku, fingerprint, raw_data)
           VALUES ($1, $2, $3, $4, $5)`,
          [feed.client_id, feed.id, sku, fingerprint, JSON.stringify(row)]
        );
        created++;
      }
    } catch (err) {
      console.error(`[FeedService] Error processing SKU ${sku}:`, err);
    }
  }

  // Update feed metadata
  await query(
    'UPDATE feeds SET last_sync_at = NOW(), last_row_count = $1 WHERE id = $2',
    [rows.length, feed.id]
  );

  console.log(`[FeedService] Import complete — created: ${created}, updated: ${updated}, skipped: ${skipped}`);
  return { created, updated, skipped, total: rows.length };
}
