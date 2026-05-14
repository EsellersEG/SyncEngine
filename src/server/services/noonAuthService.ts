/**
 * Noon Auth Service
 * Handles authentication with Noon Partner API (noon-api-gateway.noon.partners).
 *
 * Flow (per official docs):
 *  1. Parse stored credentials JSON (key_id, private_key, channel_identifier, project_code)
 *  2. Generate JWT with claims: sub=key_id, iat, jti=uuid — signed RS256
 *  3. POST JWT to /identity/public/v1/api/login → get session cookies
 *  4. Cache cookies, include them on every subsequent request
 *  5. On 401, re-login to refresh session
 */

import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { query } from '../db.js';

export interface NoonCredentials {
  keyId: string;              // noon-partners-key-id-XXXX
  privateKey: string;         // PEM RSA private key
  channelIdentifier: string;  // user@pXXXXXX.idp.noon.partners
  sellerId: string;           // pXXXXXX (extracted from channelIdentifier)
  projectCode?: string;       // PRJ170961
}

interface NoonSession {
  cookies: string;   // "name1=value1; name2=value2"
  expiresAt: number;
}

const NOON_BASE_URL = 'https://noon-api-gateway.noon.partners';
const SESSION_CACHE = new Map<string, NoonSession>();
const FETCH_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 6;
const RETRY_DELAY_MS = 2_000;
const SESSION_TTL_MS = 25 * 60 * 1000; // 25 min (sessions last ~30 min)

// ── Credential parsing ───────────────────────────────────────────────────

export function parseNoonCredentials(json: string): NoonCredentials {
  const parsed = JSON.parse(json);

  const keyId = parsed.key_id || parsed.keyId || '';
  const privateKey = parsed.private_key || parsed.privateKey || '';
  const channelIdentifier = parsed.channel_identifier || parsed.channelIdentifier || '';
  const projectCode = parsed.project_code || parsed.projectCode || '';

  if (!keyId) {
    throw new Error('Noon credentials JSON must include "key_id". Download the JSON from Noon Seller Lab > Settings > API Credentials.');
  }
  if (!privateKey) {
    throw new Error('Noon credentials JSON must include "private_key" (PEM RSA key). Download the JSON from Noon Seller Lab.');
  }
  if (!channelIdentifier) {
    throw new Error('Noon credentials JSON must include "channel_identifier" (e.g. user@pXXXXXX.idp.noon.partners).');
  }

  let sellerId = parsed.sellerId || parsed.seller_id || '';
  if (!sellerId) {
    const match = channelIdentifier.match(/@(p\d+)\./);
    if (match) sellerId = match[1];
  }
  if (!sellerId) {
    throw new Error('Could not extract sellerId from channel_identifier. Ensure it has format user@pXXXXXX.idp.noon.partners.');
  }

  return { keyId, privateKey, channelIdentifier, sellerId, projectCode };
}

// ── JWT generation (sub=key_id, iat, jti=uuid, RS256) ────────────────────

function generateNoonJwt(credentials: NoonCredentials): string {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { sub: credentials.keyId, iat: now, jti: randomUUID() },
    credentials.privateKey,
    { algorithm: 'RS256' }
  );
}

// ── Session login (cookie-based) ─────────────────────────────────────────

async function loginToNoon(credentials: NoonCredentials): Promise<string> {
  const token = generateNoonJwt(credentials);
  const res = await fetch(`${NOON_BASE_URL}/identity/public/v1/api/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'SyncEngine/1.0.0',
    },
    body: JSON.stringify({
      token,
      default_project_code: credentials.projectCode || null,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    let detail = text;
    try { detail = JSON.parse(text).message || text; } catch { /* raw */ }
    throw new Error(`Noon login failed (${res.status}): ${detail}`);
  }

  // Extract session cookies from Set-Cookie headers
  const setCookieHeaders: string[] =
    typeof (res.headers as any).getSetCookie === 'function'
      ? (res.headers as any).getSetCookie()
      : (res.headers.get('set-cookie') || '').split(/,(?=[^ ])/);

  const cookies = setCookieHeaders
    .map((c: string) => c.split(';')[0].trim())
    .filter(Boolean)
    .join('; ');

  if (!cookies) {
    throw new Error('Noon login succeeded but no session cookies returned');
  }

  console.log(`[NoonAuth] Logged in as ${credentials.channelIdentifier}`);
  return cookies;
}

async function getNoonSessionCookies(credentials: NoonCredentials): Promise<string> {
  const cacheKey = credentials.keyId;
  const cached = SESSION_CACHE.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.cookies;
  }
  const cookies = await loginToNoon(credentials);
  SESSION_CACHE.set(cacheKey, { cookies, expiresAt: Date.now() + SESSION_TTL_MS });
  return cookies;
}

function invalidateNoonSession(credentials: NoonCredentials): void {
  SESSION_CACHE.delete(credentials.keyId);
}

// ── Base URL ─────────────────────────────────────────────────────────────

export function getNoonBaseUrl(_countryCode?: string): string {
  return NOON_BASE_URL;
}

// ── Load channel from DB ─────────────────────────────────────────────────

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

// ── Fetch with retry + rate limit ────────────────────────────────────────

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

  return res;
}

// ── Authenticated API request ────────────────────────────────────────────

export async function noonApiRequest(
  credentials: NoonCredentials,
  _countryCode: string,
  method: string,
  path: string,
  body?: unknown
): Promise<unknown> {
  const url = `${NOON_BASE_URL}${path}`;

  const makeOptions = (cookies: string): RequestInit => {
    const opts: RequestInit = {
      method,
      headers: {
        'Cookie': cookies,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'SyncEngine/1.0.0',
      },
    };
    if (body) opts.body = JSON.stringify(body);
    return opts;
  };

  let cookies = await getNoonSessionCookies(credentials);
  let res = await noonFetchWithRetry(url, makeOptions(cookies));

  // On 401, re-login and retry once
  if (res.status === 401) {
    console.log(`[NoonAuth] 401 on ${method} ${path}, re-logging in...`);
    invalidateNoonSession(credentials);
    cookies = await getNoonSessionCookies(credentials);
    res = await noonFetchWithRetry(url, makeOptions(cookies));
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

// ── Test connection ──────────────────────────────────────────────────────

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
      '/identity/v1/whoami'
    ) as { user_code?: string; username?: string };

    return {
      success: true,
      seller: {
        name: result?.username || credentials.channelIdentifier,
        id: result?.user_code || credentials.sellerId,
      },
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Connection failed' };
  }
}

// ── Fetch warehouses ─────────────────────────────────────────────────────

export async function fetchNoonWarehouses(
  credentialsJson: string,
  countryCode: string
): Promise<Array<{ code: string; name: string; country: string }>> {
  const credentials = parseNoonCredentials(credentialsJson);
  const result = await noonApiRequest(
    credentials,
    countryCode,
    'POST',
    '/warehouse_platform/v1/warehouses/list',
    { next_token: null }
  ) as { warehouses?: Array<{ warehouse_code: string; display_name: string; fulfillment_system_code: string; is_active: boolean }> };

  return (result?.warehouses || []).map(w => ({
    code: w.warehouse_code,
    name: w.display_name,
    country: countryCode,
  }));
}

// ── Helpers ──────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
