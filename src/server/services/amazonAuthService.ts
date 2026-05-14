/**
 * Amazon Auth Service
 * Handles SP-API authentication via Login with Amazon (LWA) OAuth 2.0.
 *
 * Flow:
 *  1. Parse stored credentials JSON (client_id, client_secret, refresh_token, seller_id)
 *  2. Exchange refresh_token for access_token via LWA endpoint
 *  3. Cache token with expiry, auto-refresh 5 min before expiry
 *  4. Inject x-amz-access-token header on SP-API calls
 *  5. Retry with backoff on 429 / timeout
 */

import { query } from '../db.js';

export interface AmazonCredentials {
  client_id: string;
  client_secret: string;
  refresh_token: string;
  seller_id: string;
}

interface TokenEntry {
  access_token: string;
  expires_at: number; // epoch ms
}

// ── SP-API endpoint mapping ────────────────────────────────────────────────
const SP_API_ENDPOINTS: Record<string, string> = {
  na: 'https://sellingpartnerapi-na.amazon.com',
  eu: 'https://sellingpartnerapi-eu.amazon.com',
  fe: 'https://sellingpartnerapi-fe.amazon.com',
};

const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';

// Marketplace ID → Region helper (covers user's chosen marketplaces)
const MARKETPLACE_REGION: Record<string, string> = {
  ATVPDKIKX0DER: 'na',  // US
  A2VIGQ35RCS4UG: 'eu',  // AE
  ARBP9OOSHTCHU: 'eu',   // EG
  A1F83G8C2ARO7P: 'eu',  // UK
  A1PA6795UKMFR9: 'eu',  // DE
};

// Marketplace ID → readable label
export const MARKETPLACE_LABELS: Record<string, string> = {
  ATVPDKIKX0DER: 'US',
  A2VIGQ35RCS4UG: 'AE',
  ARBP9OOSHTCHU: 'EG',
  A1F83G8C2ARO7P: 'UK',
  A1PA6795UKMFR9: 'DE',
};

export const REGION_MARKETPLACES: Record<string, { id: string; label: string }[]> = {
  na: [
    { id: 'ATVPDKIKX0DER', label: 'United States (US)' },
  ],
  eu: [
    { id: 'A2VIGQ35RCS4UG', label: 'United Arab Emirates (AE)' },
    { id: 'ARBP9OOSHTCHU', label: 'Egypt (EG)' },
    { id: 'A1F83G8C2ARO7P', label: 'United Kingdom (UK)' },
    { id: 'A1PA6795UKMFR9', label: 'Germany (DE)' },
  ],
  fe: [],
};

// ── Token cache ────────────────────────────────────────────────────────────
const TOKEN_CACHE = new Map<string, TokenEntry>();
const FETCH_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 6;
const RETRY_DELAY_MS = 2_000;
const TOKEN_REFRESH_BUFFER_MS = 5 * 60_000; // refresh 5 min before expiry

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Credential Parsing ─────────────────────────────────────────────────────

export function parseAmazonCredentials(json: string): AmazonCredentials {
  const parsed = JSON.parse(json);
  if (!parsed.client_id || !parsed.client_secret || !parsed.refresh_token || !parsed.seller_id) {
    throw new Error('Amazon credentials must include client_id, client_secret, refresh_token, and seller_id');
  }
  return {
    client_id: parsed.client_id,
    client_secret: parsed.client_secret,
    refresh_token: parsed.refresh_token,
    seller_id: parsed.seller_id,
  };
}

// ── Token Exchange ─────────────────────────────────────────────────────────

export async function getAccessToken(credentials: AmazonCredentials): Promise<string> {
  const cacheKey = `${credentials.client_id}:${credentials.seller_id}`;
  const cached = TOKEN_CACHE.get(cacheKey);
  if (cached && cached.expires_at > Date.now() + TOKEN_REFRESH_BUFFER_MS) {
    return cached.access_token;
  }

  const res = await fetch(LWA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: credentials.refresh_token,
      client_id: credentials.client_id,
      client_secret: credentials.client_secret,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LWA token exchange failed (${res.status}): ${text}`);
  }

  const data = await res.json() as { access_token: string; expires_in: number };
  const entry: TokenEntry = {
    access_token: data.access_token,
    expires_at: Date.now() + data.expires_in * 1000,
  };
  TOKEN_CACHE.set(cacheKey, entry);
  return entry.access_token;
}

/** Invalidate cached token (e.g. after 401) */
function invalidateToken(credentials: AmazonCredentials) {
  const cacheKey = `${credentials.client_id}:${credentials.seller_id}`;
  TOKEN_CACHE.delete(cacheKey);
}

// ── Base URL ───────────────────────────────────────────────────────────────

export function getAmazonBaseUrl(region: string): string {
  return SP_API_ENDPOINTS[region.toLowerCase()] || SP_API_ENDPOINTS['eu'];
}

// ── Fetch with Retry ───────────────────────────────────────────────────────

export async function amazonFetchWithRetry(
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
      console.log(`[AmazonAuth] Request timed out, retrying in ${Math.round(backoff)}ms (retry ${retries + 1})`);
      await sleep(backoff);
      return amazonFetchWithRetry(url, options, retries + 1);
    }
    throw err;
  }
  clearTimeout(timeoutId);

  if (res.status === 429) {
    const retryAfter = parseFloat(res.headers.get('Retry-After') || '3') * 1000;
    const backoff = Math.max(retryAfter, RETRY_DELAY_MS * Math.pow(1.5, retries));
    if (retries >= MAX_RETRIES) throw new Error(`Amazon rate limit exceeded after ${MAX_RETRIES} retries`);
    console.log(`[AmazonAuth] 429 Rate limited, waiting ${Math.round(backoff)}ms (retry ${retries + 1})`);
    await sleep(backoff);
    return amazonFetchWithRetry(url, options, retries + 1);
  }

  if (res.status === 401 && retries < 2) {
    // Token expired — clear cache and retry once
    console.log(`[AmazonAuth] 401 Unauthorized — refreshing token (retry ${retries + 1})`);
    return amazonFetchWithRetry(url, options, retries + 1);
  }

  return res;
}

// ── API Request Helper ─────────────────────────────────────────────────────

export async function amazonApiRequest<T = unknown>(
  credentials: AmazonCredentials,
  region: string,
  method: string,
  path: string,
  body?: unknown,
  queryParams?: Record<string, string>
): Promise<T> {
  const baseUrl = getAmazonBaseUrl(region);
  const url = new URL(path, baseUrl);
  if (queryParams) {
    for (const [k, v] of Object.entries(queryParams)) {
      url.searchParams.set(k, v);
    }
  }

  const accessToken = await getAccessToken(credentials);

  const options: RequestInit = {
    method,
    headers: {
      'x-amz-access-token': accessToken,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
  };
  if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
    options.body = JSON.stringify(body);
  }

  const res = await amazonFetchWithRetry(url.toString(), options);

  if (res.status === 401) {
    // Retry once with fresh token
    invalidateToken(credentials);
    const freshToken = await getAccessToken(credentials);
    const retryOptions = {
      ...options,
      headers: {
        ...options.headers as Record<string, string>,
        'x-amz-access-token': freshToken,
      },
    };
    const retryRes = await amazonFetchWithRetry(url.toString(), retryOptions);
    if (!retryRes.ok) {
      const text = await retryRes.text();
      throw new Error(`Amazon API ${method} ${path} failed after token refresh (${retryRes.status}): ${text}`);
    }
    return retryRes.json() as Promise<T>;
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Amazon API ${method} ${path} failed (${res.status}): ${text}`);
  }

  // Some 204/empty responses
  if (res.status === 204) return {} as T;
  const text = await res.text();
  return text ? JSON.parse(text) as T : ({} as T);
}

// ── Load Channel from DB ───────────────────────────────────────────────────

export async function loadAmazonChannel(channelId: string) {
  const result = await query(
    'SELECT id, client_id, name, type, amazon_credentials_json, amazon_marketplace_ids, amazon_region, settings FROM channels WHERE id = $1',
    [channelId]
  );
  const ch = result.rows[0];
  if (!ch) throw new Error('Channel not found');
  if (ch.type !== 'amazon') throw new Error('Channel is not an Amazon channel');
  if (!ch.amazon_credentials_json) throw new Error('Amazon credentials not configured');
  return ch;
}

// ── Test Connection ────────────────────────────────────────────────────────

export async function testAmazonConnection(
  credentialsJson: string,
  region: string
): Promise<{ success: boolean; marketplaces?: { id: string; country: string }[]; error?: string }> {
  try {
    const credentials = parseAmazonCredentials(credentialsJson);
    const data = await amazonApiRequest<{
      payload: Array<{
        marketplace: { id: string; countryCode: string; name: string };
        participation: { isParticipating: boolean };
      }>;
    }>(credentials, region, 'GET', '/sellers/v1/marketplaceParticipations');

    const marketplaces = (data.payload || [])
      .filter(p => p.participation?.isParticipating)
      .map(p => ({ id: p.marketplace.id, country: p.marketplace.countryCode }));

    return { success: true, marketplaces };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Get Marketplace Participations ─────────────────────────────────────────

export async function getMarketplaceParticipations(
  credentials: AmazonCredentials,
  region: string
): Promise<{ id: string; countryCode: string; name: string; isParticipating: boolean }[]> {
  const data = await amazonApiRequest<{
    payload: Array<{
      marketplace: { id: string; countryCode: string; name: string };
      participation: { isParticipating: boolean };
    }>;
  }>(credentials, region, 'GET', '/sellers/v1/marketplaceParticipations');

  return (data.payload || []).map(p => ({
    id: p.marketplace.id,
    countryCode: p.marketplace.countryCode,
    name: p.marketplace.name,
    isParticipating: p.participation?.isParticipating ?? false,
  }));
}
