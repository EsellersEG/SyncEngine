/**
 * Amazon SP-API OAuth Routes (unauthenticated — called by Amazon)
 *
 * Flow:
 *  1. Seller clicks "Authorize" on Amazon → Amazon redirects to GET /api/amazon/oauth/login
 *  2. We look up the app from DB using state (app UUID), redirect seller to Amazon consent
 *  3. After consent, Amazon redirects to GET /api/amazon/oauth/callback with spapi_oauth_code
 *  4. We exchange code for refresh_token via LWA and store it in amazon_oauth_tokens
 */

import { Router } from 'express';
import { query } from '../db.js';

const router = Router();

const APP_BASE_URL = process.env.APP_BASE_URL || 'https://syncengine-production.up.railway.app';
const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';

/**
 * Look up Amazon app credentials from DB.
 * If appId (our internal UUID) is provided, use that.
 * Otherwise fall back to the default app or ENV vars.
 */
async function getAppCredentials(appId?: string) {
  if (appId) {
    const result = await query('SELECT * FROM amazon_apps WHERE id = $1', [appId]);
    if (result.rows[0]) return result.rows[0];
  }
  // Fall back to default app
  const result = await query('SELECT * FROM amazon_apps WHERE is_default = true LIMIT 1');
  if (result.rows[0]) return result.rows[0];
  // Final fallback to ENV vars (for backward compat)
  return {
    id: null,
    client_id: process.env.AMAZON_CLIENT_ID || '',
    client_secret: process.env.AMAZON_CLIENT_SECRET || '',
    app_id: process.env.AMAZON_APP_ID || '',
  };
}

// GET /api/amazon/oauth/login
// Amazon sends sellers here after they click "Authorize" in Seller Central
router.get('/login', async (req, res) => {
  try {
    const {
      amazon_callback_uri,
      amazon_state,
      selling_partner_id,
      version,
      state: appState, // our app UUID passed as state in the authorize URL
    } = req.query;

    if (!amazon_callback_uri || !amazon_state) {
      return res.status(400).send('Missing amazon_callback_uri or amazon_state');
    }

    // Build the Amazon consent URL — redirect seller back to Amazon's consent page
    const consentUrl = new URL(String(amazon_callback_uri));
    consentUrl.searchParams.set('redirect_uri', `${APP_BASE_URL}/api/amazon/oauth/callback`);
    consentUrl.searchParams.set('amazon_state', String(amazon_state));
    // Pass both selling_partner_id and our app UUID in state (separated by |)
    const stateValue = `${selling_partner_id || ''}|${appState || ''}`;
    consentUrl.searchParams.set('state', stateValue);
    if (version) {
      consentUrl.searchParams.set('version', String(version));
    }

    console.log(`[Amazon OAuth] Login redirect for seller ${selling_partner_id}, app=${appState}`);
    return res.redirect(consentUrl.toString());
  } catch (err) {
    console.error('[Amazon OAuth] Login error:', err);
    return res.status(500).send('OAuth login failed');
  }
});

// GET /api/amazon/oauth/callback
// Amazon redirects here after seller grants consent, with spapi_oauth_code + state
router.get('/callback', async (req, res) => {
  try {
    const {
      spapi_oauth_code,
      state,
      selling_partner_id,
    } = req.query;

    if (!spapi_oauth_code) {
      return res.status(400).send('Missing spapi_oauth_code — authorization was not granted');
    }

    // Parse state: could be "seller_id|app_uuid" (from /login redirect)
    // or just "app_uuid" (from direct Seller Central website workflow)
    const stateStr = String(state || '');
    const stateParts = stateStr.split('|');
    let sellerPartnerId: string;
    let appUuid: string;

    if (stateParts.length >= 2) {
      // Came through /login: state = "seller_id|app_uuid"
      sellerPartnerId = String(selling_partner_id || stateParts[0] || '');
      appUuid = stateParts[1];
    } else {
      // Direct website workflow: state = "app_uuid", selling_partner_id is a query param
      sellerPartnerId = String(selling_partner_id || '');
      appUuid = stateStr;
    }

    // Look up app credentials from DB
    const app = await getAppCredentials(appUuid || undefined);
    if (!app.client_id || !app.client_secret) {
      console.error(`[Amazon OAuth] No app credentials found for appUuid=${appUuid}`);
      return res.status(500).send('No Amazon app credentials configured');
    }

    // Exchange authorization code for refresh_token
    const tokenRes = await fetch(LWA_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: String(spapi_oauth_code),
        redirect_uri: `${APP_BASE_URL}/api/amazon/oauth/callback`,
        client_id: app.client_id,
        client_secret: app.client_secret,
      }),
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      console.error(`[Amazon OAuth] Token exchange failed (${tokenRes.status}):`, errText);
      return res.status(400).send(`Token exchange failed: ${errText}`);
    }

    const tokenData = await tokenRes.json() as {
      access_token: string;
      refresh_token: string;
      token_type: string;
      expires_in: number;
    };

    console.log(`[Amazon OAuth] Successfully obtained refresh_token for seller ${sellerPartnerId}`);

    // Store the refresh_token
    if (sellerPartnerId) {
      // Try to find an existing amazon channel with this seller_id
      const existingChannel = await query(
        `SELECT id, amazon_credentials_json FROM channels
         WHERE type = 'amazon'
           AND amazon_credentials_json::jsonb->>'seller_id' = $1
         LIMIT 1`,
        [sellerPartnerId]
      );

      if (existingChannel.rows.length > 0) {
        // Update existing channel with new refresh_token
        const channel = existingChannel.rows[0];
        const creds = JSON.parse(channel.amazon_credentials_json || '{}');
        creds.refresh_token = tokenData.refresh_token;
        creds.client_id = app.client_id;
        creds.client_secret = app.client_secret;
        creds.seller_id = sellerPartnerId;

        await query(
          `UPDATE channels SET amazon_credentials_json = $1, status = 'active', updated_at = NOW() WHERE id = $2`,
          [JSON.stringify(creds), channel.id]
        );
        console.log(`[Amazon OAuth] Updated channel ${channel.id} with new refresh_token`);
      } else {
        // Store in amazon_oauth_tokens for later linking
        await query(
          `INSERT INTO amazon_oauth_tokens (seller_id, refresh_token, app_id, client_id, created_at)
           VALUES ($1, $2, $3, $4, NOW())
           ON CONFLICT (seller_id) DO UPDATE SET refresh_token = $2, app_id = $3, client_id = $4, created_at = NOW()`,
          [sellerPartnerId, tokenData.refresh_token, app.id || null, app.client_id]
        ).catch((err) => {
          console.error(`[Amazon OAuth] Failed to store token:`, err);
        });
        console.log(`[Amazon OAuth] Stored token for seller ${sellerPartnerId} (no channel linked yet)`);
      }
    }

    // Redirect to frontend success page
    return res.redirect(`${APP_BASE_URL}/channels?amazon_oauth=success&seller_id=${encodeURIComponent(sellerPartnerId)}`);
  } catch (err) {
    console.error('[Amazon OAuth] Callback error:', err);
    return res.redirect(`${APP_BASE_URL}/channels?amazon_oauth=error`);
  }
});

export default router;
