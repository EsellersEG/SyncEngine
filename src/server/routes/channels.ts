import { Router } from 'express';
import { query } from '../db.js';
import { authenticate, type AuthRequest } from '../middleware/auth.js';

const router = Router();
router.use(authenticate);

// GET /api/channels?client_id=xxx
router.get('/', async (req: AuthRequest, res) => {
  try {
    const { client_id } = req.query;
    const isAdmin = req.user!.role === 'admin';
    const result = await query(
      `SELECT ch.*,
        (SELECT COUNT(*) FROM sync_jobs sj WHERE sj.channel_id = ch.id) as total_syncs,
        (SELECT MAX(sj.completed_at) FROM sync_jobs sj WHERE sj.channel_id = ch.id AND sj.status = 'completed') as last_synced_at
       FROM channels ch
       ${isAdmin ? '' : 'JOIN user_clients uc ON uc.client_id = ch.client_id AND uc.user_id = $2'}
       WHERE ($1::uuid IS NULL OR ch.client_id = $1::uuid)
       ORDER BY ch.created_at DESC`,
      isAdmin ? [client_id || null] : [client_id || null, req.user!.id]
    );
    // Mask tokens in response
    const masked = result.rows.map(ch => ({
      ...ch,
      shopify_access_token: ch.shopify_access_token ? '••••••••' : null,
      noon_credentials_json: ch.noon_credentials_json ? '••••••••' : null,
      amazon_credentials_json: ch.amazon_credentials_json ? '••••••••' : null,
    }));
    return res.json(masked);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch channels' });
  }
});

// GET /api/channels/:id
router.get('/:id', async (req, res) => {
  try {
    const result = await query('SELECT * FROM channels WHERE id = $1', [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Channel not found' });
    const ch = result.rows[0];
    return res.json({
      ...ch,
      shopify_access_token: ch.shopify_access_token ? '••••••••' : null,
      noon_credentials_json: ch.noon_credentials_json ? '••••••••' : null,
      amazon_credentials_json: ch.amazon_credentials_json ? '••••••••' : null,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch channel' });
  }
});

// POST /api/channels
router.post('/', async (req, res) => {
  try {
    const {
      client_id, name, type,
      shopify_store_url, shopify_access_token, shopify_api_version,
      noon_credentials_json, noon_warehouse_code, noon_country_code,
      amazon_credentials_json, amazon_app_id, amazon_seller_id, amazon_refresh_token,
      amazon_marketplace_ids, amazon_region,
      settings = {}
    } = req.body;

    if (!client_id || !name || !type) {
      return res.status(400).json({ error: 'client_id, name, type required' });
    }

    if (type === 'noon' && !noon_credentials_json) {
      return res.status(400).json({ error: 'noon_credentials_json required for Noon channels' });
    }

    // Build Amazon credentials from app + seller_id (or accept raw JSON for backward compat)
    let finalAmazonCredentials = amazon_credentials_json || null;
    if (type === 'amazon' && !finalAmazonCredentials && amazon_app_id && amazon_seller_id) {
      const appResult = await query('SELECT client_id, client_secret FROM amazon_apps WHERE id = $1', [amazon_app_id]);
      const app = appResult.rows[0];
      if (!app) return res.status(400).json({ error: 'Amazon app not found' });
      finalAmazonCredentials = JSON.stringify({
        client_id: app.client_id,
        client_secret: app.client_secret,
        refresh_token: amazon_refresh_token || '',
        seller_id: amazon_seller_id,
      });
    }
    if (type === 'amazon' && !finalAmazonCredentials) {
      return res.status(400).json({ error: 'Amazon app and seller_id required for Amazon channels' });
    }

    const result = await query(
      `INSERT INTO channels (client_id, name, type, shopify_store_url, shopify_access_token, shopify_api_version, noon_credentials_json, noon_warehouse_code, noon_country_code, amazon_credentials_json, amazon_marketplace_ids, amazon_region, settings)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id, client_id, name, type, status, shopify_store_url, shopify_api_version, noon_warehouse_code, noon_country_code, amazon_marketplace_ids, amazon_region, settings, created_at`,
      [client_id, name, type, shopify_store_url || null, shopify_access_token || null,
       shopify_api_version || '2024-10', noon_credentials_json || null,
       noon_warehouse_code || null, noon_country_code || null,
       finalAmazonCredentials, amazon_marketplace_ids || null, amazon_region || null,
       JSON.stringify(settings)]
    );
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to create channel' });
  }
});

// PATCH /api/channels/:id
router.patch('/:id', async (req, res) => {
  try {
    const { name, status, shopify_access_token, shopify_api_version, noon_credentials_json, noon_warehouse_code, noon_country_code, amazon_credentials_json, amazon_app_id, amazon_seller_id, amazon_refresh_token, amazon_marketplace_ids, amazon_region, settings } = req.body;

    // Build Amazon credentials from app if provided
    let finalAmazonCredentials = amazon_credentials_json || null;
    if (amazon_app_id && amazon_seller_id) {
      const appResult = await query('SELECT client_id, client_secret FROM amazon_apps WHERE id = $1', [amazon_app_id]);
      const app = appResult.rows[0];
      if (app) {
        finalAmazonCredentials = JSON.stringify({
          client_id: app.client_id,
          client_secret: app.client_secret,
          refresh_token: amazon_refresh_token || '',
          seller_id: amazon_seller_id,
        });
      }
    }
    const result = await query(
      `UPDATE channels SET
        name = COALESCE($1, name),
        status = COALESCE($2, status),
        shopify_access_token = COALESCE($3, shopify_access_token),
        shopify_api_version = COALESCE($4, shopify_api_version),
        settings = COALESCE($5::jsonb, settings),
        noon_credentials_json = COALESCE(NULLIF($6, ''), noon_credentials_json),
        noon_warehouse_code = COALESCE($7, noon_warehouse_code),
        noon_country_code = COALESCE($8, noon_country_code),
        amazon_credentials_json = COALESCE(NULLIF($9, ''), amazon_credentials_json),
        amazon_marketplace_ids = COALESCE($10, amazon_marketplace_ids),
        amazon_region = COALESCE($11, amazon_region),
        updated_at = NOW()
       WHERE id = $12
       RETURNING id, client_id, name, type, status, shopify_store_url, shopify_api_version, noon_warehouse_code, noon_country_code, amazon_marketplace_ids, amazon_region, settings`,
      [name, status, shopify_access_token, shopify_api_version,
       settings ? JSON.stringify(settings) : null,
       noon_credentials_json || null, noon_warehouse_code || null, noon_country_code || null,
       finalAmazonCredentials || null, amazon_marketplace_ids || null, amazon_region || null,
       req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Channel not found' });
    return res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to update channel' });
  }
});

// DELETE /api/channels/:id
router.delete('/:id', async (req, res) => {
  try {
    await query('DELETE FROM channels WHERE id = $1', [req.params.id]);
    return res.json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to delete channel' });
  }
});

// POST /api/channels/:id/test — test channel connection (Shopify or Noon)
router.post('/:id/test', async (req, res) => {
  try {
    const result = await query(
      'SELECT * FROM channels WHERE id = $1',
      [req.params.id]
    );
    const ch = result.rows[0];
    if (!ch) return res.status(404).json({ error: 'Channel not found' });

    // Noon test
    if (ch.type === 'noon') {
      if (!ch.noon_credentials_json) {
        return res.status(400).json({ error: 'Noon credentials not configured' });
      }
      const { testNoonConnection } = await import('../services/noonAuthService.js');
      const noonResult = await testNoonConnection(ch.noon_credentials_json, ch.noon_country_code || 'AE');
      if (noonResult.success) {
        await query("UPDATE channels SET status = 'active' WHERE id = $1", [req.params.id]);
        return res.json({ success: true, seller: noonResult.seller });
      } else {
        await query("UPDATE channels SET status = 'error' WHERE id = $1", [req.params.id]);
        return res.status(400).json({ error: noonResult.error || 'Noon connection failed' });
      }
    }

    // Amazon test
    if (ch.type === 'amazon') {
      if (!ch.amazon_credentials_json) {
        return res.status(400).json({ error: 'Amazon credentials not configured' });
      }
      const { testAmazonConnection } = await import('../services/amazonAuthService.js');
      const amazonResult = await testAmazonConnection(ch.amazon_credentials_json, ch.amazon_region || 'eu');
      if (amazonResult.success) {
        await query("UPDATE channels SET status = 'active' WHERE id = $1", [req.params.id]);
        return res.json({ success: true, marketplaces: amazonResult.marketplaces });
      } else {
        await query("UPDATE channels SET status = 'error' WHERE id = $1", [req.params.id]);
        return res.status(400).json({ error: amazonResult.error || 'Amazon connection failed' });
      }
    }

    // Shopify test (default)
    const url = `https://${ch.shopify_store_url}/admin/api/${ch.shopify_api_version}/shop.json`;
    const shopRes = await fetch(url, {
      headers: { 'X-Shopify-Access-Token': ch.shopify_access_token },
    });

    if (!shopRes.ok) {
      await query("UPDATE channels SET status = 'error' WHERE id = $1", [req.params.id]);
      return res.status(400).json({ error: 'Shopify connection failed', details: await shopRes.text() });
    }

    const shopData = await shopRes.json() as { shop: { name: string; email: string } };
    await query("UPDATE channels SET status = 'active' WHERE id = $1", [req.params.id]);
    return res.json({ success: true, shop: shopData.shop });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Connection test failed' });
  }
});

// GET /api/channels/:id/locations — fetch stock locations from Shopify
router.get('/:id/locations', async (req, res) => {
  try {
    const result = await query(
      'SELECT shopify_store_url, shopify_access_token, shopify_api_version FROM channels WHERE id = $1',
      [req.params.id]
    );
    const ch = result.rows[0];
    if (!ch) return res.status(404).json({ error: 'Channel not found' });

    const url = `https://${ch.shopify_store_url}/admin/api/${ch.shopify_api_version}/graphql.json`;
    const gqlRes = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': ch.shopify_access_token,
      },
      body: JSON.stringify({
        query: `{ locations(first: 50) { edges { node { id name isActive address { formatted } } } } }`,
      }),
    });

    if (!gqlRes.ok) {
      return res.status(400).json({ error: 'Failed to fetch locations from Shopify' });
    }

    const data = await gqlRes.json() as {
      data?: { locations: { edges: Array<{ node: { id: string; name: string; isActive: boolean; address: { formatted: string[] } } }> } };
      errors?: unknown[];
    };

    if (data.errors) {
      return res.status(400).json({ error: 'GraphQL error', details: data.errors });
    }

    const locations = data.data?.locations?.edges?.map(e => ({
      id: e.node.id,
      name: e.node.name,
      active: e.node.isActive,
      address: e.node.address?.formatted?.join(', ') || '',
    })) || [];

    return res.json(locations);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch locations' });
  }
});

export default router;
