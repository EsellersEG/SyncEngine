/**
 * Noon Content Pipeline Service
 *
 * CSV-based content sync for Noon catalog:
 *  1. Export current catalog from Noon (to get template format)
 *  2. Apply mapped content fields (title, bullet points, images)
 *  3. Generate upload-ready CSV
 *  4. Track job progress in noon_content_jobs table
 */

import { query } from '../db.js';
import {
  parseNoonCredentials,
  noonApiRequest,
  type NoonCredentials,
} from './noonAuthService.js';

const BATCH_TIME_LIMIT_MS = 330_000;

interface ContentMapping {
  feed_column: string;
  target_field: string;
}

// Noon content CSV columns
const NOON_CONTENT_FIELDS = [
  'partner_sku',
  'title',
  'title_ar',
  'brand',
  'category',
  'bullet_point_1',
  'bullet_point_2',
  'bullet_point_3',
  'bullet_point_4',
  'bullet_point_5',
  'description',
  'image_1',
  'image_2',
  'image_3',
  'image_4',
  'image_5',
  'image_6',
  'image_7',
  'image_8',
  'search_keywords',
];

/**
 * Start a content export job — requests Noon to generate a catalog export
 */
export async function startContentExport(
  channelId: string,
  feedId: string
): Promise<{ contentJobId: string }> {
  const channelResult = await query(
    'SELECT * FROM channels WHERE id = $1',
    [channelId]
  );
  const channel = channelResult.rows[0];
  if (!channel) throw new Error('Channel not found');
  if (!channel.noon_credentials_json) throw new Error('Noon credentials not configured');

  const credentials = parseNoonCredentials(channel.noon_credentials_json);
  const countryCode = channel.noon_country_code || 'AE';

  // Create content job record
  const jobResult = await query(
    `INSERT INTO noon_content_jobs (channel_id, feed_id, status) VALUES ($1, $2, 'exporting') RETURNING id`,
    [channelId, feedId]
  );
  const contentJobId = jobResult.rows[0].id;

  try {
    // Request catalog export from Noon
    const exportResult = await noonApiRequest(
      credentials,
      countryCode,
      'POST',
      '/seller/api/v1/catalog/export',
      { format: 'csv' }
    ) as { result?: { jobId: string } };

    const noonExportJobId = exportResult?.result?.jobId;
    if (noonExportJobId) {
      await query(
        'UPDATE noon_content_jobs SET export_job_id = $1 WHERE id = $2',
        [noonExportJobId, contentJobId]
      );
    }

    return { contentJobId };
  } catch (err) {
    await query(
      "UPDATE noon_content_jobs SET status = 'failed', error_message = $1, completed_at = NOW() WHERE id = $2",
      [err instanceof Error ? err.message : 'Export request failed', contentJobId]
    );
    throw err;
  }
}

/**
 * Check export job status
 */
export async function checkContentExportStatus(contentJobId: string): Promise<{
  status: string;
  downloadUrl?: string;
  error?: string;
}> {
  const jobResult = await query(
    'SELECT * FROM noon_content_jobs WHERE id = $1',
    [contentJobId]
  );
  const job = jobResult.rows[0];
  if (!job) throw new Error('Content job not found');

  if (job.status !== 'exporting' || !job.export_job_id) {
    return { status: job.status, error: job.error_message };
  }

  // Check with Noon
  const channelResult = await query(
    'SELECT * FROM channels WHERE id = $1',
    [job.channel_id]
  );
  const channel = channelResult.rows[0];
  const credentials = parseNoonCredentials(channel.noon_credentials_json);
  const countryCode = channel.noon_country_code || 'AE';

  try {
    const statusResult = await noonApiRequest(
      credentials,
      countryCode,
      'GET',
      `/seller/api/v1/catalog/export/${job.export_job_id}/status`
    ) as { result?: { status: string; downloadUrl?: string } };

    if (statusResult?.result?.status === 'completed' && statusResult.result.downloadUrl) {
      await query(
        "UPDATE noon_content_jobs SET status = 'processing', csv_url = $1 WHERE id = $2",
        [statusResult.result.downloadUrl, contentJobId]
      );
      return { status: 'processing', downloadUrl: statusResult.result.downloadUrl };
    }

    if (statusResult?.result?.status === 'failed') {
      await query(
        "UPDATE noon_content_jobs SET status = 'failed', error_message = 'Noon export failed', completed_at = NOW() WHERE id = $1",
        [contentJobId]
      );
      return { status: 'failed', error: 'Noon catalog export failed' };
    }

    return { status: 'exporting' };
  } catch (err) {
    return { status: 'exporting', error: err instanceof Error ? err.message : 'Status check failed' };
  }
}

/**
 * Generate upload-ready CSV from feed data using mappings
 */
export async function generateContentCsv(
  channelId: string,
  feedId: string,
  contentJobId: string
): Promise<string> {
  const startTime = Date.now();

  // Load mappings
  const mappingsResult = await query(
    'SELECT feed_column, target_field FROM attribute_mappings WHERE feed_id = $1 AND channel_id = $2',
    [feedId, channelId]
  );
  const mappings: ContentMapping[] = mappingsResult.rows;

  // Filter to only content-related mappings
  const contentMappings = mappings.filter(m =>
    NOON_CONTENT_FIELDS.includes(m.target_field) ||
    m.target_field.startsWith('bullet_point_') ||
    m.target_field.startsWith('image_')
  );

  // Load products
  const productsResult = await query(
    "SELECT sku, raw_data FROM products WHERE feed_id = $1 AND status = 'active'",
    [feedId]
  );
  const products = productsResult.rows;

  // Load Noon SKU mappings
  const noonSkuResult = await query(
    'SELECT sku, noon_partner_sku FROM noon_products WHERE channel_id = $1',
    [channelId]
  );
  const noonSkuMap = new Map<string, string>();
  for (const np of noonSkuResult.rows) {
    noonSkuMap.set(np.sku, np.noon_partner_sku);
  }

  await query(
    'UPDATE noon_content_jobs SET total_products = $1, status = $2 WHERE id = $3',
    [products.length, 'processing', contentJobId]
  );

  // Build CSV
  const csvRows: string[] = [];
  // Header
  csvRows.push(NOON_CONTENT_FIELDS.join(','));

  let processedCount = 0;
  let updatedCount = 0;

  for (const product of products) {
    if (Date.now() - startTime > BATCH_TIME_LIMIT_MS) {
      console.log(`[NoonContent] Hit time limit at product ${processedCount}/${products.length}`);
      break;
    }

    const partnerSku = noonSkuMap.get(product.sku) || product.sku;
    const row: string[] = [];

    for (const field of NOON_CONTENT_FIELDS) {
      if (field === 'partner_sku') {
        row.push(escapeCsvField(partnerSku));
        continue;
      }

      const mapping = contentMappings.find(m => m.target_field === field);
      if (mapping) {
        const value = String(product.raw_data[mapping.feed_column] || '');
        row.push(escapeCsvField(value));
      } else {
        row.push('');
      }
    }

    csvRows.push(row.join(','));
    processedCount++;
    updatedCount++;
  }

  const csv = csvRows.join('\n');

  await query(
    "UPDATE noon_content_jobs SET status = 'completed', processed_count = $1, updated_count = $2, completed_at = NOW() WHERE id = $3",
    [processedCount, updatedCount, contentJobId]
  );

  return csv;
}

/**
 * Get content job status
 */
export async function getContentJobStatus(contentJobId: string) {
  const result = await query(
    'SELECT * FROM noon_content_jobs WHERE id = $1',
    [contentJobId]
  );
  return result.rows[0] || null;
}

/**
 * List content jobs for a channel
 */
export async function listContentJobs(channelId: string, limit = 20) {
  const result = await query(
    'SELECT * FROM noon_content_jobs WHERE channel_id = $1 ORDER BY created_at DESC LIMIT $2',
    [channelId, limit]
  );
  return result.rows;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function escapeCsvField(value: string): string {
  if (!value) return '';
  // Escape if contains comma, quote, or newline
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}
