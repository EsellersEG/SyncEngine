/**
 * Noon Auth Service
 * Handles authentication with Noon Seller Lab API.
 * 
 * Flow:
 *  1. Parse stored credentials JSON (contains key_id, private_key, channel_identifier)
 *  2. Generate JWT RS256 token signed with private key
 *  3. Cache tokens and handle refresh on 401
 *  4. Rate limit with 429 backoff
 */

import jwt from 'jsonwebtoken';
import { query } from '../db.js';

export interface NoonCredentials {
  keyId: string;              // noon-partners-key-id-XXXX
  privateKey: string;         // PEM RSA private key
  channelIdentifier: string;  // user@pXXXXXX.idp.noon.partners
  sellerId: string;           // pXXXXXX (extracted from channelIdentifier)
  projectCode?: string;       // PRJ170961
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

  // Noon Seller Lab JSON: { key_id, private_key, channel_identifier, project_code, type }
  const keyId = parsed.key_id || parsed.keyId || parsed.accessKey || '';
  const privateKey = parsed.private_key || parsed.privateKey || '';
  const channelIdentifier = parsed.channel_identifier || parsed.channelIdentifier || parsed.username || '';
  const projectCode = parsed.project_code || parsed.projectCode || '';

  if (!keyId) {
    throw new Error('Noon credentials JSON must include "key_id". Download the JSON from Noon Seller Lab > Settings > API Credentials.');
  }

  if (!privateKey) {
    throw new Error('Noon credentials JSON must include "private_key" (PEM RSA key). Download the JSON from Noon Seller Lab > Settings > API Credentials.');
  }

  if (!channelIdentifier) {
    throw new Error('Noon credentials JSON must include "channel_identifier" (e.g. user@pXXXXXX.idp.noon.partners).');
  }

  // Extract sellerId from channel_identifier: syncengine@p170961.idp.noon.partners → p170961
  let sellerId = parsed.sellerId || parsed.seller_id || '';
  if (!sellerId) {
    const match = channelIdentifier.match(/@(p\d+)\./);
    if (match) sellerId = match[1];
  }
  if (!sellerId) {
    throw new Error('Could not extract sellerId from channel_identifier. Ensure it has format user@pXXXXXX.idp.noon.partners.');
  }

  return {
    keyId,
    privateKey,
    channelIdentifier,
    sellerId,
    projectCode,
  };
}

/**
 * Generate a JWT token for Noon API authentication.
 * Signs with RS256 using the private key from credentials.
 */
function generateNoonJwt(credentials: NoonCredentials): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: credentials.channelIdentifier,
    iat: now,
    exp: now + 300, // 5 minutes
  };
  return jwt.sign(payload, credentials.privateKey, {
    algorithm: 'RS256',
    header: {
      alg: 'RS256',
      typ: 'JWT',
      kid: credentials.keyId,
    },
  });
}

/**
 * Get authentication headers for Noon API.
 * Generates a JWT Bearer token signed with the RSA private key.
 */
export function getNoonAuthHeaders(credentials: NoonCredentials): Record<string, string> {
  // Check cache first
  const cacheKey = credentials.keyId;
  const cached = TOKEN_CACHE.get(cacheKey);
  const now = Date.now();
  let token: string;

  if (cached && cached.expiresAt > now + 30_000) {
    // Use cached token if it has >30s remaining
    token = cached.token;
  } else {
    // Generate fresh JWT
    token = generateNoonJwt(credentials);
    TOKEN_CACHE.set(cacheKey, { token, expiresAt: now + 270_000 }); // ~4.5 min
    console.log(`[NoonAuth] Generated new JWT for ${credentials.channelIdentifier}`);
  }

  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
}

/**
 * Invalidate cached token (call on 401 to force refresh)
 */
function invalidateNoonToken(credentials: NoonCredentials): void {
  TOKEN_CACHE.delete(credentials.keyId);
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

  // 401 Unauthorized — token expired, invalidate cache and retry
  if (res.status === 401 && retries < 2) {
    console.log(`[NoonAuth] 401 Unauthorized, invalidating token and retrying (retry ${retries + 1})`);
    // Invalidate from options headers isn't practical — caller should handle
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
  const url = `${baseUrl}${path}`;

  // First attempt
  let headers = getNoonAuthHeaders(credentials);
  let options: RequestInit = { method, headers };
  if (body) options.body = JSON.stringify(body);

  let res = await noonFetchWithRetry(url, options);

  // On 401, invalidate token cache and retry with fresh JWT
  if (res.status === 401) {
    console.log(`[NoonAuth] 401 on ${method} ${path}, refreshing JWT...`);
    invalidateNoonToken(credentials);
    headers = getNoonAuthHeaders(credentials);
    options = { method, headers };
    if (body) options.body = JSON.stringify(body);
    res = await noonFetchWithRetry(url, options);
  }

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
