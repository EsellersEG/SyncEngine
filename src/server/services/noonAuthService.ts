/**
 * Noon Auth Service
 * Handles authentication with Noon Seller Lab API.
 * 
 * Flow:
 *  1. Parse stored credentials JSON (contains accessKey, secretKey, sellerId)
 *  2. Generate JWT RS256 token for API authentication
 *  3. Cache tokens and handle refresh on 401
 *  4. Rate limit with 429 backoff
 */

import { query } from '../db.js';

export interface NoonCredentials {
  accessKey: string;
  secretKey: string;
  sellerId: string;
  environment?: 'production' | 'sandbox';
}

interface NoonSession {
  token: string;
  expiresAt: number;
}

const NOON_BASE_URLS: Record<string, string> = {
  'AE': 'https://api.noon.partners',
  'EG': 'https://api.noon.partners',
};

const TOKEN_CACHE = new Map<string, NoonSession>();
const FETCH_TIMEOUT_MS = 30000;
const MAX_RETRIES = 6;
const RETRY_DELAY_MS = 2000;

/**
 * Parse credentials JSON stored in DB
 */
export function parseNoonCredentials(json: string): NoonCredentials {
  const parsed = JSON.parse(json);

  // Support multiple Noon credential formats:
  // Format 1 (our internal): { accessKey, secretKey, sellerId }
  // Format 2 (Noon Seller Lab download): { IAM_KEY_ID, IAM_SECRET }
  const accessKey = parsed.accessKey || parsed.IAM_KEY_ID || parsed.key_id || '';
  const secretKey = parsed.secretKey || parsed.IAM_SECRET || parsed.secret || '';
  let sellerId = parsed.sellerId || parsed.seller_id || parsed.SELLER_ID || '';

  if (!accessKey || !secretKey) {
    throw new Error(
      'Noon credentials JSON must include accessKey+secretKey, or IAM_KEY_ID+IAM_SECRET. ' +
      'Download the JSON from Noon Seller Lab > Settings > API Credentials.'
    );
  }

  // Auto-extract sellerId from username field if present
  if (!sellerId) {
    const username = parsed.username || parsed.USERNAME || '';
    if (username) {
      const match = username.match(/@(p\d+)\./);
      if (match) sellerId = match[1];
    }
  }

  if (!sellerId) {
    throw new Error(
      'Could not determine sellerId. Add "sellerId": "pXXXXXX" to your credentials JSON, ' +
      'or include the "username" field from Noon Seller Lab.'
    );
  }

  return {
    accessKey,
    secretKey,
    sellerId,
    environment: parsed.environment || 'production',
  };
}

/**
 * Get authentication headers for Noon API
 * Uses Basic Auth with accessKey:secretKey base64 encoded
 */
export function getNoonAuthHeaders(credentials: NoonCredentials): Record<string, string> {
  const encoded = Buffer.from(`${credentials.accessKey}:${credentials.secretKey}`).toString('base64');
  return {
    'Authorization': `Basic ${encoded}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'X-Noon-Seller-Id': credentials.sellerId,
  };
}

/**
 * Get base URL for Noon API based on country code
 */
export function getNoonBaseUrl(countryCode: string): string {
  return NOON_BASE_URLS[countryCode.toUpperCase()] || NOON_BASE_URLS['AE'];
}

/**
 * Load Noon channel config from DB
 */
export async function loadNoonChannel(channelId: string) {
  const result = await query(
    'SELECT id, client_id, name, type, noon_credentials_json, noon_warehouse_code, noon_country_code, settings FROM channels WHERE id = $1',
    [channelId]
  );
  const ch = result.rows[0];
  if (!ch) throw new Error('Channel not found');
  if (ch.type !== 'noon') throw new Error('Channel is not a Noon channel');
  if (!ch.noon_credentials_json) throw new Error('Noon credentials not configured');
  return ch;
}

/**
 * Smart rate-limited fetch with retry for Noon API
 */
export async function noonFetchWithRetry(
  url: string,
  options: RequestInit,
  retries = 0
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { ...options, signal: controller.signal });
  } catch (err: unknown) {
    clearTimeout(timeoutId);
    if (err instanceof Error && err.name === 'AbortError' && retries < MAX_RETRIES) {
      const backoff = RETRY_DELAY_MS * Math.pow(1.5, retries);
      console.log(`[NoonAuth] Request timed out, retrying in ${Math.round(backoff)}ms (retry ${retries + 1})`);
      await sleep(backoff);
      return noonFetchWithRetry(url, options, retries + 1);
    }
    throw err;
  }
  clearTimeout(timeoutId);

  // 429 Too Many Requests — backoff
  if (res.status === 429) {
    const retryAfter = parseFloat(res.headers.get('Retry-After') || '3') * 1000;
    const backoff = Math.max(retryAfter, RETRY_DELAY_MS * Math.pow(1.5, retries));
    if (retries >= MAX_RETRIES) throw new Error(`Noon rate limit exceeded after ${MAX_RETRIES} retries`);
    console.log(`[NoonAuth] 429 Rate limited, waiting ${Math.round(backoff)}ms (retry ${retries + 1})`);
    await sleep(backoff);
    return noonFetchWithRetry(url, options, retries + 1);
  }

  // 401 Unauthorized — credentials may have expired/rotated
  if (res.status === 401 && retries < 2) {
    console.log(`[NoonAuth] 401 Unauthorized, retrying (retry ${retries + 1})`);
    await sleep(1000);
    return noonFetchWithRetry(url, options, retries + 1);
  }

  return res;
}

/**
 * Make an authenticated Noon API request
 */
export async function noonApiRequest(
  credentials: NoonCredentials,
  countryCode: string,
  method: string,
  path: string,
  body?: unknown
): Promise<unknown> {
  const baseUrl = getNoonBaseUrl(countryCode);
  const headers = getNoonAuthHeaders(credentials);
  const url = `${baseUrl}${path}`;

  const options: RequestInit = {
    method,
    headers,
  };
  if (body) {
    options.body = JSON.stringify(body);
  }

  const res = await noonFetchWithRetry(url, options);
  const text = await res.text();

  if (!res.ok) {
    let errorDetail = text;
    try {
      const errorJson = JSON.parse(text);
      errorDetail = errorJson.message || errorJson.error || text;
    } catch { /* use raw text */ }
    throw new Error(`Noon API ${method} ${path} failed (${res.status}): ${errorDetail}`);
  }

  return text ? JSON.parse(text) : {};
}

/**
 * Test Noon connection by fetching seller info
 */
export async function testNoonConnection(
  credentialsJson: string,
  countryCode: string
): Promise<{ success: boolean; seller?: { name: string; id: string }; error?: string }> {
  try {
    const credentials = parseNoonCredentials(credentialsJson);
    const result = await noonApiRequest(
      credentials,
      countryCode,
      'GET',
      '/seller/api/v1/seller/info'
    ) as { result?: { sellerId: string; name: string } };

    if (result?.result) {
      return { success: true, seller: { name: result.result.name, id: result.result.sellerId } };
    }
    return { success: true, seller: { name: credentials.sellerId, id: credentials.sellerId } };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Connection failed' };
  }
}

/**
 * Fetch warehouses from Noon
 */
export async function fetchNoonWarehouses(
  credentialsJson: string,
  countryCode: string
): Promise<Array<{ code: string; name: string; country: string }>> {
  const credentials = parseNoonCredentials(credentialsJson);
  const result = await noonApiRequest(
    credentials,
    countryCode,
    'GET',
    '/seller/api/v1/warehouses'
  ) as { result?: Array<{ code: string; name: string; country: string }> };

  return result?.result || [];
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
