/**
 * Amazon Feeds Service — JSON_LISTINGS_FEED submission & tracking
 *
 * Implements the SP-API Feeds API workflow:
 *  1. createFeedDocument → get presigned upload URL
 *  2. Upload JSON_LISTINGS_FEED payload to presigned URL
 *  3. createFeed with feedDocumentId + marketplace IDs
 *  4. Poll getFeed for status (DONE / FATAL)
 *  5. Download processing report from result feedDocumentId
 *
 * Feed message format:
 *  { messageId, sku, operationType (PATCH/PUT/DELETE), productType, patches/attributes }
 */

import {
  type AmazonCredentials,
  amazonApiRequest,
  getAmazonBaseUrl,
  getAccessToken,
  amazonFetchWithRetry,
} from './amazonAuthService.js';

const MAX_MESSAGES_PER_FEED = 10_000;

// ── Types ──────────────────────────────────────────────────────────────────

export interface FeedMessage {
  messageId: number;
  sku: string;
  operationType: 'PATCH' | 'PUT' | 'DELETE';
  productType: string;
  patches?: Array<{
    op: 'replace' | 'add' | 'delete';
    path: string;
    value?: unknown[];
  }>;
  attributes?: Record<string, unknown>;
}

interface CreateFeedDocumentResponse {
  feedDocumentId: string;
  url: string;
}

interface CreateFeedResponse {
  feedId: string;
}

export interface FeedStatus {
  feedId: string;
  feedType: string;
  processingStatus: 'CANCELLED' | 'DONE' | 'FATAL' | 'IN_PROGRESS' | 'IN_QUEUE';
  resultFeedDocumentId?: string;
  createdTime?: string;
  processingEndTime?: string;
}

export interface FeedResultSummary {
  numberOfRecordsProcessed?: number;
  numberOfRecordsWithError?: number;
  errors?: Array<{ sku?: string; code?: string; message?: string; severity?: string }>;
}

// ── Feed Document Upload ───────────────────────────────────────────────────

async function createFeedDocument(
  credentials: AmazonCredentials,
  region: string
): Promise<CreateFeedDocumentResponse> {
  return amazonApiRequest<CreateFeedDocumentResponse>(
    credentials, region, 'POST',
    '/feeds/2021-06-30/documents',
    { contentType: 'application/json; charset=UTF-8' }
  );
}

async function uploadFeedPayload(
  url: string,
  payload: string
): Promise<void> {
  const res = await amazonFetchWithRetry(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: payload,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Feed document upload failed (${res.status}): ${text}`);
  }
}

async function createFeed(
  credentials: AmazonCredentials,
  region: string,
  feedDocumentId: string,
  marketplaceIds: string[]
): Promise<CreateFeedResponse> {
  return amazonApiRequest<CreateFeedResponse>(
    credentials, region, 'POST',
    '/feeds/2021-06-30/feeds',
    {
      feedType: 'JSON_LISTINGS_FEED',
      marketplaceIds,
      inputFeedDocumentId: feedDocumentId,
    }
  );
}

// ── Submit Listings Feed ───────────────────────────────────────────────────

export async function submitListingsFeed(
  credentials: AmazonCredentials,
  region: string,
  sellerId: string,
  marketplaceIds: string[],
  messages: FeedMessage[]
): Promise<{ feedId: string; feedDocumentId: string }> {
  if (messages.length === 0) throw new Error('No feed messages to submit');

  // Build JSON_LISTINGS_FEED payload
  const payload = {
    header: {
      sellerId,
      version: '2.0',
      issueLocale: 'en_US',
    },
    messages: messages.map(m => {
      const msg: Record<string, unknown> = {
        messageId: m.messageId,
        sku: m.sku,
        operationType: m.operationType,
        productType: m.productType,
      };
      if (m.operationType === 'PATCH' && m.patches) {
        msg.patches = m.patches;
      }
      if (m.operationType === 'PUT' && m.attributes) {
        msg.attributes = m.attributes;
      }
      return msg;
    }),
  };

  const payloadStr = JSON.stringify(payload);

  // Step 1: Create feed document (get upload URL)
  const doc = await createFeedDocument(credentials, region);

  // Step 2: Upload payload
  await uploadFeedPayload(doc.url, payloadStr);

  // Step 3: Create feed
  const feed = await createFeed(credentials, region, doc.feedDocumentId, marketplaceIds);

  return { feedId: feed.feedId, feedDocumentId: doc.feedDocumentId };
}

// ── Check Feed Status ──────────────────────────────────────────────────────

export async function checkFeedStatus(
  credentials: AmazonCredentials,
  region: string,
  feedId: string
): Promise<FeedStatus> {
  return amazonApiRequest<FeedStatus>(
    credentials, region, 'GET',
    `/feeds/2021-06-30/feeds/${feedId}`
  );
}

// ── Get Feed Results ───────────────────────────────────────────────────────

export async function getFeedResults(
  credentials: AmazonCredentials,
  region: string,
  resultFeedDocumentId: string
): Promise<FeedResultSummary> {
  // Get download URL
  const doc = await amazonApiRequest<{ url: string }>(
    credentials, region, 'GET',
    `/feeds/2021-06-30/documents/${resultFeedDocumentId}`
  );

  // Download result
  const res = await amazonFetchWithRetry(doc.url, { method: 'GET' });
  if (!res.ok) {
    throw new Error(`Failed to download feed results (${res.status})`);
  }

  const text = await res.text();
  try {
    return JSON.parse(text) as FeedResultSummary;
  } catch {
    // Some results may not be valid JSON
    return { errors: [{ message: text.slice(0, 1000) }] };
  }
}

// ── Message Builders ───────────────────────────────────────────────────────

interface ProductRow {
  [key: string]: string | number | null | undefined;
}

interface AttributeMapping {
  feed_column: string;
  target_field: string;
}

function getMappedValue(row: ProductRow, mappings: AttributeMapping[], targetField: string): string | null {
  const mapping = mappings.find(m => m.target_field === targetField);
  if (!mapping) return null;
  const val = row[mapping.feed_column];
  return val != null ? String(val) : null;
}

/**
 * Build PATCH messages for stock/fulfillment_availability
 */
export function buildStockPatchMessages(
  products: ProductRow[],
  mappings: AttributeMapping[],
  startMessageId = 1,
  fulfillmentChannelCode = 'DEFAULT'
): FeedMessage[] {
  const messages: FeedMessage[] = [];
  let msgId = startMessageId;

  for (const row of products) {
    const sku = getMappedValue(row, mappings, 'sku');
    const qty = getMappedValue(row, mappings, 'fulfillment_availability');
    if (!sku || qty == null) continue;

    const quantity = Math.max(0, Math.floor(Number(qty) || 0));

    messages.push({
      messageId: msgId++,
      sku,
      operationType: 'PATCH',
      productType: 'PRODUCT',
      patches: [{
        op: 'replace',
        path: '/attributes/fulfillment_availability',
        value: [{
          fulfillment_channel_code: fulfillmentChannelCode,
          quantity,
        }],
      }],
    });
  }

  return messages;
}

/**
 * Build PATCH messages for pricing (purchasable_offer)
 */
export function buildPricePatchMessages(
  products: ProductRow[],
  mappings: AttributeMapping[],
  marketplaceId: string,
  currency: string,
  startMessageId = 1,
  priceAdjustmentPercent = 0,
  priceRoundingMode: 'none' | 'up' | 'down' = 'none'
): FeedMessage[] {
  const messages: FeedMessage[] = [];
  let msgId = startMessageId;

  for (const row of products) {
    const sku = getMappedValue(row, mappings, 'sku');
    const priceStr = getMappedValue(row, mappings, 'price');
    if (!sku || priceStr == null) continue;

    let price = parseFloat(priceStr);
    if (isNaN(price) || price <= 0) continue;

    // Price adjustment
    if (priceAdjustmentPercent !== 0) {
      price = price * (1 + priceAdjustmentPercent / 100);
    }
    if (priceRoundingMode === 'up') price = Math.ceil(price);
    else if (priceRoundingMode === 'down') price = Math.floor(price);
    price = Math.round(price * 100) / 100;

    const offer: Record<string, unknown> = {
      marketplace_id: marketplaceId,
      currency,
      our_price: [{ schedule: [{ value_with_tax: price }] }],
    };

    // Compare at price / MSRP
    const msrpStr = getMappedValue(row, mappings, 'msrp');
    if (msrpStr) {
      const msrp = parseFloat(msrpStr);
      if (!isNaN(msrp) && msrp > 0) {
        offer.list_price = [{ value_with_tax: msrp, currency }];
      }
    }

    messages.push({
      messageId: msgId++,
      sku,
      operationType: 'PATCH',
      productType: 'PRODUCT',
      patches: [{
        op: 'replace',
        path: '/attributes/purchasable_offer',
        value: [offer],
      }],
    });
  }

  return messages;
}

/**
 * Build PATCH messages for content (title, bullets, description, images)
 */
export function buildContentPatchMessages(
  products: ProductRow[],
  mappings: AttributeMapping[],
  marketplaceId: string,
  startMessageId = 1,
  includeImages = false
): FeedMessage[] {
  const messages: FeedMessage[] = [];
  let msgId = startMessageId;

  for (const row of products) {
    const sku = getMappedValue(row, mappings, 'sku');
    if (!sku) continue;

    const patches: FeedMessage['patches'] = [];

    // Title
    const title = getMappedValue(row, mappings, 'item_name');
    if (title) {
      patches.push({
        op: 'replace',
        path: '/attributes/item_name',
        value: [{ value: title, marketplace_id: marketplaceId }],
      });
    }

    // Brand
    const brand = getMappedValue(row, mappings, 'brand');
    if (brand) {
      patches.push({
        op: 'replace',
        path: '/attributes/brand',
        value: [{ value: brand }],
      });
    }

    // Description
    const desc = getMappedValue(row, mappings, 'product_description');
    if (desc) {
      patches.push({
        op: 'replace',
        path: '/attributes/product_description',
        value: [{ value: desc, marketplace_id: marketplaceId }],
      });
    }

    // Bullet points (1-5)
    for (let i = 1; i <= 5; i++) {
      const bp = getMappedValue(row, mappings, `bullet_point_${i}`);
      if (bp) {
        patches.push({
          op: 'replace',
          path: '/attributes/bullet_point',
          value: [{ value: bp, marketplace_id: marketplaceId }],
        });
        break; // Amazon bullet_point is an array — we set all at once below
      }
    }

    // Collect all bullet points as array
    const bulletValues: unknown[] = [];
    for (let i = 1; i <= 5; i++) {
      const bp = getMappedValue(row, mappings, `bullet_point_${i}`);
      if (bp) bulletValues.push({ value: bp, marketplace_id: marketplaceId });
    }
    if (bulletValues.length > 0) {
      // Remove the individual bullet patch above and use array
      const bpIndex = patches.findIndex(p => p.path === '/attributes/bullet_point');
      if (bpIndex >= 0) patches.splice(bpIndex, 1);
      patches.push({
        op: 'replace',
        path: '/attributes/bullet_point',
        value: bulletValues,
      });
    }

    // Search terms
    const searchTerms = getMappedValue(row, mappings, 'search_terms');
    if (searchTerms) {
      patches.push({
        op: 'replace',
        path: '/attributes/generic_keyword',
        value: [{ value: searchTerms, marketplace_id: marketplaceId }],
      });
    }

    // Images (only if toggled on)
    if (includeImages) {
      const mainImage = getMappedValue(row, mappings, 'main_product_image');
      if (mainImage) {
        patches.push({
          op: 'replace',
          path: '/attributes/main_product_image_locator',
          value: [{ media_location: mainImage, marketplace_id: marketplaceId }],
        });
      }

      const otherImages: unknown[] = [];
      for (let i = 1; i <= 7; i++) {
        const img = getMappedValue(row, mappings, `other_product_image_${i}`);
        if (img) {
          otherImages.push({ media_location: img, marketplace_id: marketplaceId });
        }
      }
      if (otherImages.length > 0) {
        patches.push({
          op: 'replace',
          path: '/attributes/other_product_image_locator',
          value: otherImages,
        });
      }
    }

    if (patches.length === 0) continue;

    messages.push({
      messageId: msgId++,
      sku,
      operationType: 'PATCH',
      productType: 'PRODUCT',
      patches,
    });
  }

  return messages;
}

/**
 * Split messages into chunks that fit within feed size limits
 */
export function chunkMessages(messages: FeedMessage[], maxPerFeed = MAX_MESSAGES_PER_FEED): FeedMessage[][] {
  const chunks: FeedMessage[][] = [];
  for (let i = 0; i < messages.length; i += maxPerFeed) {
    chunks.push(messages.slice(i, i + maxPerFeed));
  }
  return chunks;
}
