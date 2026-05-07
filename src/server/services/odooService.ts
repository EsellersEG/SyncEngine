/**
 * Odoo XML-RPC Service
 * Connects to Odoo via XML-RPC to fetch products, stock, prices, and create orders.
 * Uses raw fetch with XML body — no extra npm dependencies needed.
 */

export interface OdooConfig {
  url: string;        // e.g. "https://mycompany.odoo.com"
  database: string;   // e.g. "mycompany"
  username: string;   // e.g. "admin@company.com"
  apiKey: string;     // API key or password
  productSearchBy?: 'automatic' | 'sku' | 'ean' | 'name';
}

interface FeedRow {
  [key: string]: string | number | null;
}

// ── XML-RPC Helpers ────────────────────────────────────────────────────────

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function valueToXml(value: unknown): string {
  if (value === null || value === undefined) return '<value><boolean>0</boolean></value>';
  if (typeof value === 'boolean') return `<value><boolean>${value ? 1 : 0}</boolean></value>`;
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return `<value><int>${value}</int></value>`;
    return `<value><double>${value}</double></value>`;
  }
  if (typeof value === 'string') return `<value><string>${escapeXml(value)}</string></value>`;
  if (Array.isArray(value)) {
    const items = value.map(v => valueToXml(v)).join('');
    return `<value><array><data>${items}</data></array></value>`;
  }
  if (typeof value === 'object') {
    const members = Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `<member><name>${escapeXml(k)}</name>${valueToXml(v)}</member>`)
      .join('');
    return `<value><struct>${members}</struct></value>`;
  }
  return `<value><string>${escapeXml(String(value))}</string></value>`;
}

function buildXmlRpcRequest(method: string, params: unknown[]): string {
  const paramXml = params.map(p => `<param>${valueToXml(p)}</param>`).join('');
  return `<?xml version="1.0"?><methodCall><methodName>${method}</methodName><params>${paramXml}</params></methodCall>`;
}

function parseXmlValue(xml: string): unknown {
  // Simple XML-RPC response parser
  xml = xml.trim();

  // Check for fault
  const faultMatch = xml.match(/<fault>[\s\S]*?<string>([\s\S]*?)<\/string>/);
  if (faultMatch) throw new Error(`Odoo XML-RPC fault: ${faultMatch[1]}`);

  // Extract value(s) from response
  const values = extractValues(xml);
  return values;
}

function extractValues(xml: string): unknown {
  xml = xml.trim();

  // int/i4
  const intMatch = xml.match(/<(?:int|i4)>(-?\d+)<\/(?:int|i4)>/);
  if (intMatch && !xml.includes('<array>') && !xml.includes('<struct>')) return parseInt(intMatch[1]);

  // double
  const doubleMatch = xml.match(/<double>([\d.-]+)<\/double>/);
  if (doubleMatch && !xml.includes('<array>') && !xml.includes('<struct>')) return parseFloat(doubleMatch[1]);

  // boolean
  const boolMatch = xml.match(/<boolean>([01])<\/boolean>/);
  if (boolMatch && !xml.includes('<array>') && !xml.includes('<struct>')) return boolMatch[1] === '1';

  // string (only if no complex types present)
  const strMatch = xml.match(/<string>([\s\S]*?)<\/string>/);
  if (strMatch && !xml.includes('<array>') && !xml.includes('<struct>')) {
    return strMatch[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"');
  }

  // nil/None
  if (xml.includes('<nil/>') || xml.includes('<nil />')) {
    if (!xml.includes('<array>') && !xml.includes('<struct>')) return null;
  }

  // array — use greedy match to capture the OUTERMOST array
  const arrayStart = xml.indexOf('<array>');
  const arrayEnd = xml.lastIndexOf('</array>');
  if (arrayStart !== -1 && arrayEnd !== -1) {
    const dataStart = xml.indexOf('<data>', arrayStart);
    const dataEnd = xml.lastIndexOf('</data>', arrayEnd);
    if (dataStart !== -1 && dataEnd !== -1) {
      const content = xml.substring(dataStart + 6, dataEnd);
      const topLevelValues = splitTopLevelValues(content);
      const items: unknown[] = [];
      for (const val of topLevelValues) {
        items.push(extractValues(val));
      }
      return items;
    }
  }

  // struct — use greedy match to capture the OUTERMOST struct
  const structStart = xml.indexOf('<struct>');
  const structEnd = xml.lastIndexOf('</struct>');
  if (structStart !== -1 && structEnd !== -1) {
    const structContent = xml.substring(structStart + 8, structEnd);
    const obj: Record<string, unknown> = {};
    // Parse members using depth-aware splitting
    const members = splitTopLevelMembers(structContent);
    for (const member of members) {
      const nameMatch = member.match(/<name>([\s\S]*?)<\/name>/);
      if (nameMatch) {
        // Extract value content between first <value> and last </value> in this member
        const valStart = member.indexOf('<value>', member.indexOf('</name>'));
        const valEnd = member.lastIndexOf('</value>');
        if (valStart !== -1 && valEnd !== -1) {
          const valContent = member.substring(valStart + 7, valEnd);
          obj[nameMatch[1]] = extractValues(valContent);
        }
      }
    }
    return obj;
  }

  // Fallback: try to unwrap <value> tag
  const valueMatch = xml.match(/^<value>([\s\S]*)<\/value>$/);
  if (valueMatch) return extractValues(valueMatch[1]);

  // Plain text fallback
  return xml.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"') || null;
}

function splitTopLevelMembers(xml: string): string[] {
  const results: string[] = [];
  let depth = 0;
  let current = '';
  let inMember = false;
  let i = 0;

  while (i < xml.length) {
    if (xml.startsWith('<member>', i)) {
      if (depth === 0) {
        inMember = true;
        current = '';
      }
      depth++;
      current += '<member>';
      i += 8;
    } else if (xml.startsWith('</member>', i)) {
      depth--;
      current += '</member>';
      if (depth === 0 && inMember) {
        results.push(current);
        inMember = false;
        current = '';
      }
      i += 9;
    } else {
      if (inMember) current += xml[i];
      i++;
    }
  }
  return results;
}

function splitTopLevelValues(xml: string): string[] {
  const results: string[] = [];
  let depth = 0;
  let current = '';
  let inValue = false;
  let i = 0;

  while (i < xml.length) {
    if (xml.startsWith('<value>', i)) {
      if (depth === 0) {
        inValue = true;
        current = '';
      }
      depth++;
      current += '<value>';
      i += 7;
    } else if (xml.startsWith('</value>', i)) {
      depth--;
      current += '</value>';
      if (depth === 0 && inValue) {
        results.push(current);
        inValue = false;
        current = '';
      }
      i += 8;
    } else {
      if (inValue) current += xml[i];
      i++;
    }
  }
  return results;
}

async function xmlRpcCall(url: string, endpoint: string, method: string, params: unknown[]): Promise<unknown> {
  const body = buildXmlRpcRequest(method, params);
  const fullUrl = `${url.replace(/\/$/, '')}/${endpoint}`;

  const res = await fetch(fullUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml' },
    body,
  });

  if (!res.ok) {
    throw new Error(`Odoo XML-RPC HTTP error: ${res.status} ${res.statusText}`);
  }

  const text = await res.text();

  // Check for XML-RPC fault
  const faultMatch = text.match(/<fault>[\s\S]*?<string>([\s\S]*?)<\/string>/);
  if (faultMatch) {
    throw new Error(`Odoo error: ${faultMatch[1]}`);
  }

  // Parse the response — extract params/param/value
  const paramMatch = text.match(/<params>\s*<param>\s*<value>([\s\S]*?)<\/value>\s*<\/param>\s*<\/params>/);
  if (paramMatch) {
    return extractValues(paramMatch[1]);
  }

  // Fallback
  return parseXmlValue(text);
}

// ── Public API ─────────────────────────────────────────────────────────────

export async function odooAuthenticate(config: OdooConfig): Promise<number> {
  const uid = await xmlRpcCall(
    config.url,
    'xmlrpc/2/common',
    'authenticate',
    [config.database, config.username, config.apiKey, {}]
  );

  if (!uid || uid === false) {
    throw new Error('Odoo authentication failed. Check URL, database, username, and API key.');
  }

  return uid as number;
}

export async function odooExecute(
  config: OdooConfig,
  uid: number,
  model: string,
  method: string,
  args: unknown[],
  kwargs: Record<string, unknown> = {}
): Promise<unknown> {
  return xmlRpcCall(
    config.url,
    'xmlrpc/2/object',
    'execute_kw',
    [config.database, uid, config.apiKey, model, method, args, kwargs]
  );
}

export async function testOdooConnection(config: OdooConfig): Promise<{ success: boolean; productCount: number; uid: number }> {
  const uid = await odooAuthenticate(config);
  const count = await odooExecute(config, uid, 'product.product', 'search_count', [
    [['active', '=', true], ['type', '=', 'product']]
  ]) as number;
  return { success: true, productCount: count, uid };
}

export async function fetchOdooProducts(config: OdooConfig): Promise<{ headers: string[]; rows: FeedRow[] }> {
  const uid = await odooAuthenticate(config);

  const fields = [
    'barcode', 'name', 'list_price', 'qty_available', 'default_code',
    'weight', 'description_sale', 'active',
  ];

  // Paginate to avoid 502 timeouts on large catalogs
  const PAGE_SIZE = 500;
  let offset = 0;
  const allProducts: Array<Record<string, unknown>> = [];

  while (true) {
    const batch = await odooExecute(config, uid, 'product.product', 'search_read', [
      [['active', '=', true], ['type', '=', 'product']]
    ], { fields, limit: PAGE_SIZE, offset }) as Array<Record<string, unknown>>;

    if (!batch || batch.length === 0) break;
    allProducts.push(...batch);
    console.log(`[OdooService] Fetched ${allProducts.length} products (offset=${offset})...`);
    if (batch.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  if (allProducts.length === 0) {
    return { headers: fields, rows: [] };
  }

  // Convert to flat rows (same format as Google Sheets)
  const rows: FeedRow[] = allProducts.map(p => {
    const row: FeedRow = {};
    row['barcode'] = p.barcode ? String(p.barcode) : null;
    row['name'] = p.name ? String(p.name) : null;
    row['list_price'] = typeof p.list_price === 'number' ? p.list_price : null;
    row['qty_available'] = typeof p.qty_available === 'number' ? p.qty_available : null;
    row['default_code'] = p.default_code ? String(p.default_code) : null;
    row['weight'] = typeof p.weight === 'number' ? p.weight : null;
    row['description_sale'] = p.description_sale ? String(p.description_sale) : null;
    row['odoo_id'] = typeof p.id === 'number' ? p.id : null;
    return row;
  });

  const headers = ['barcode', 'name', 'list_price', 'qty_available', 'default_code', 'weight', 'description_sale', 'odoo_id'];
  return { headers, rows };
}

// ── Order Sync: Shopify → Odoo ─────────────────────────────────────────────

export async function createOdooSaleOrder(
  config: OdooConfig,
  shopifyOrder: {
    email: string;
    name: string;
    total_price: string;
    line_items: Array<{
      sku: string;
      name: string;
      quantity: number;
      price: string;
      discount_allocations?: Array<{ amount: string }>;
    }>;
    shipping_address?: {
      first_name?: string;
      last_name?: string;
      address1?: string;
      address2?: string;
      city?: string;
      zip?: string;
      country?: string;
      phone?: string;
    };
  }
): Promise<{ odooOrderId: number; odooOrderName: string }> {
  const uid = await odooAuthenticate(config);

  // 1. Find or create partner by email
  let partnerId: number;
  const existingPartners = await odooExecute(config, uid, 'res.partner', 'search_read', [
    [['email', '=', shopifyOrder.email]]
  ], { fields: ['id'], limit: 1 }) as Array<{ id: number }>;

  if (existingPartners.length > 0) {
    partnerId = existingPartners[0].id;
  } else {
    const addr = shopifyOrder.shipping_address;
    partnerId = await odooExecute(config, uid, 'res.partner', 'create', [{
      name: addr ? `${addr.first_name || ''} ${addr.last_name || ''}`.trim() : shopifyOrder.email,
      email: shopifyOrder.email,
      phone: addr?.phone || false,
      street: addr?.address1 || false,
      street2: addr?.address2 || false,
      city: addr?.city || false,
      zip: addr?.zip || false,
    }]) as number;
  }

  // 2. Map line items to Odoo product IDs
  const orderLines: Array<[number, number, Record<string, unknown>]> = [];

  for (const item of shopifyOrder.line_items) {
    let productId: number | null = null;

    if (item.sku) {
      for (const field of getOdooProductSearchFields(config.productSearchBy)) {
        const found = await odooExecute(config, uid, 'product.product', 'search_read', [
          [[field, '=', item.sku]]
        ], { fields: ['id'], limit: 1 }) as Array<{ id: number }>;
        if (found.length > 0) {
          productId = found[0].id;
          break;
        }
      }
    }

    const discount = item.discount_allocations?.reduce((sum, d) => sum + parseFloat(d.amount || '0'), 0) || 0;
    const priceUnit = parseFloat(item.price);
    const discountPercent = priceUnit > 0 ? (discount / (priceUnit * item.quantity)) * 100 : 0;

    orderLines.push([0, 0, {
      product_id: productId || false,
      name: item.name || item.sku || 'Unknown Product',
      product_uom_qty: item.quantity,
      price_unit: priceUnit,
      discount: discountPercent > 0 ? discountPercent : 0,
    }]);
  }

  // 3. Create sale order
  const orderId = await odooExecute(config, uid, 'sale.order', 'create', [{
    partner_id: partnerId,
    client_order_ref: shopifyOrder.name, // Shopify order number
    order_line: orderLines,
  }]) as number;

  // 4. Confirm the order
  try {
    await odooExecute(config, uid, 'sale.order', 'action_confirm', [[orderId]]);
  } catch (err) {
    console.warn(`[OdooOrder] Could not auto-confirm order ${orderId}:`, err);
  }

  // 5. Get the order name
  const orderData = await odooExecute(config, uid, 'sale.order', 'read', [[orderId]], { fields: ['name'] }) as Array<{ name: string }>;

  return { odooOrderId: orderId, odooOrderName: orderData[0]?.name || `SO-${orderId}` };
}

function getOdooProductSearchFields(mode: OdooConfig['productSearchBy']): string[] {
  switch (mode) {
    case 'sku':
      return ['default_code', 'barcode', 'name'];
    case 'ean':
      return ['barcode', 'default_code', 'name'];
    case 'name':
      return ['name', 'default_code', 'barcode'];
    case 'automatic':
    default:
      return ['barcode', 'default_code', 'name'];
  }
}
