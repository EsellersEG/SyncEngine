import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Map, Plus, Save, Trash2, ArrowRight, Wand2, AlertTriangle } from 'lucide-react';

interface Feed { id: string; name: string; }
interface Channel { id: string; name: string; type: string; }
interface Mapping { feed_column: string; target_field: string; transform?: string; }
interface MetafieldMapping { namespace: string; key: string; type: string; feed_column: string; }

const SHOPIFY_FIELDS = [
  { value: 'title', label: 'Product Title', group: 'Product' },
  { value: 'body_html', label: 'Description (HTML)', group: 'Product' },
  { value: 'vendor', label: 'Vendor / Brand', group: 'Product' },
  { value: 'tags', label: 'Tags (comma-separated)', group: 'Product' },
  { value: 'status', label: 'Status (active/draft)', group: 'Product' },
  { value: 'price', label: 'Variant Price', group: 'Pricing' },
  { value: 'compare_at_price', label: 'Compare-at Price', group: 'Pricing' },
  { value: 'inventory_quantity', label: 'Stock Quantity', group: 'Inventory' },
  { value: 'sku', label: 'SKU', group: 'Inventory' },
  { value: 'barcode', label: 'Barcode / EAN', group: 'Inventory' },
  { value: 'weight', label: 'Weight (g)', group: 'Shipping' },
  { value: 'image_url', label: 'Main Image URL', group: 'Media' },
  { value: 'handle', label: 'Handle (URL slug)', group: 'Product' },
  { value: 'product_type', label: 'Product Type', group: 'Product' },
  { value: 'published', label: 'Published', group: 'Product' },
  { value: 'option1_name', label: 'Option1 Name', group: 'Variants' },
  { value: 'option1_value', label: 'Option1 Value', group: 'Variants' },
  { value: 'option2_name', label: 'Option2 Name', group: 'Variants' },
  { value: 'option2_value', label: 'Option2 Value', group: 'Variants' },
  { value: 'option3_name', label: 'Option3 Name', group: 'Variants' },
  { value: 'option3_value', label: 'Option3 Value', group: 'Variants' },
  { value: 'variant_weight_unit', label: 'Weight Unit', group: 'Shipping' },
  { value: 'variant_inventory_policy', label: 'Inventory Policy', group: 'Inventory' },
  { value: 'variant_fulfillment_service', label: 'Fulfillment Service', group: 'Inventory' },
  { value: 'variant_requires_shipping', label: 'Requires Shipping', group: 'Shipping' },
  { value: 'variant_image', label: 'Variant Image URL', group: 'Media' },
];

const NOON_FIELDS = [
  { value: 'partner_sku', label: 'Partner SKU', group: 'Core' },
  { value: 'qty', label: 'Stock Quantity', group: 'Core' },
  { value: 'price', label: 'Price', group: 'Pricing' },
  { value: 'msrp', label: 'MSRP (Compare-at)', group: 'Pricing' },
  { value: 'sale_price', label: 'Sale Price', group: 'Pricing' },
  { value: 'is_active', label: 'Is Active', group: 'Core' },
  { value: 'title', label: 'Title', group: 'Content' },
  { value: 'title_ar', label: 'Title (Arabic)', group: 'Content' },
  { value: 'brand', label: 'Brand', group: 'Content' },
  { value: 'category', label: 'Category', group: 'Content' },
  { value: 'description', label: 'Description', group: 'Content' },
  { value: 'bullet_point_1', label: 'Bullet Point 1', group: 'Content' },
  { value: 'bullet_point_2', label: 'Bullet Point 2', group: 'Content' },
  { value: 'bullet_point_3', label: 'Bullet Point 3', group: 'Content' },
  { value: 'bullet_point_4', label: 'Bullet Point 4', group: 'Content' },
  { value: 'bullet_point_5', label: 'Bullet Point 5', group: 'Content' },
  { value: 'search_keywords', label: 'Search Keywords', group: 'Content' },
  { value: 'image_1', label: 'Image 1', group: 'Media' },
  { value: 'image_2', label: 'Image 2', group: 'Media' },
  { value: 'image_3', label: 'Image 3', group: 'Media' },
  { value: 'image_4', label: 'Image 4', group: 'Media' },
  { value: 'image_5', label: 'Image 5', group: 'Media' },
  { value: 'image_6', label: 'Image 6', group: 'Media' },
  { value: 'image_7', label: 'Image 7', group: 'Media' },
  { value: 'image_8', label: 'Image 8', group: 'Media' },
];

// Maps common feed column names (lowercased) to target_field
const AUTO_MAP_RULES: Record<string, string> = {
  'title': 'title',
  'body (html)': 'body_html',
  'body_html': 'body_html',
  'body html': 'body_html',
  'description': 'body_html',
  'vendor': 'vendor',
  'tags': 'tags',
  'status': 'status',
  'handle': 'handle',
  'product type': 'product_type',
  'product_type': 'product_type',
  'published': 'published',
  'variant price': 'price',
  'variant_price': 'price',
  'price': 'price',
  'variant compare at price': 'compare_at_price',
  'variant_compare_at_price': 'compare_at_price',
  'compare at price': 'compare_at_price',
  'variant sku': 'sku',
  'variant_sku': 'sku',
  'sku': 'sku',
  'variant barcode': 'barcode',
  'variant_barcode': 'barcode',
  'barcode': 'barcode',
  'variant inventory qty': 'inventory_quantity',
  'variant_inventory_qty': 'inventory_quantity',
  'variant inventory quantity': 'inventory_quantity',
  'inventory_quantity': 'inventory_quantity',
  'quantity': 'inventory_quantity',
  'stock': 'inventory_quantity',
  'qty_available': 'inventory_quantity',
  'free_qty': 'inventory_quantity',
  'virtual_available': 'inventory_quantity',
  'list_price': 'price',
  'default_code': 'sku',
  'description_sale': 'body_html',
  'variant grams': 'weight',
  'variant_grams': 'weight',
  'weight': 'weight',
  'image src': 'image_url',
  'image_src': 'image_url',
  'image url': 'image_url',
  'option1 name': 'option1_name',
  'option1_name': 'option1_name',
  'option1 value': 'option1_value',
  'option1_value': 'option1_value',
  'option2 name': 'option2_name',
  'option2_name': 'option2_name',
  'option2 value': 'option2_value',
  'option2_value': 'option2_value',
  'option3 name': 'option3_name',
  'option3_name': 'option3_name',
  'option3 value': 'option3_value',
  'option3_value': 'option3_value',
  'variant weight unit': 'variant_weight_unit',
  'variant_weight_unit': 'variant_weight_unit',
  'variant inventory policy': 'variant_inventory_policy',
  'variant_inventory_policy': 'variant_inventory_policy',
  'variant fulfillment service': 'variant_fulfillment_service',
  'variant_fulfillment_service': 'variant_fulfillment_service',
  'variant requires shipping': 'variant_requires_shipping',
  'variant_requires_shipping': 'variant_requires_shipping',
  'variant image': 'variant_image',
  'variant_image': 'variant_image',
};

// Noon-specific auto-map rules
const NOON_AUTO_MAP_RULES: Record<string, string> = {
  'sku': 'partner_sku', 'partner_sku': 'partner_sku', 'variant_sku': 'partner_sku', 'variant sku': 'partner_sku', 'default_code': 'partner_sku',
  'quantity': 'qty', 'stock': 'qty', 'inventory_quantity': 'qty', 'qty': 'qty', 'qty_available': 'qty', 'free_qty': 'qty', 'virtual_available': 'qty',
  'price': 'price', 'variant_price': 'price', 'variant price': 'price', 'list_price': 'price',
  'msrp': 'msrp', 'compare_at_price': 'msrp', 'compare at price': 'msrp',
  'sale_price': 'sale_price', 'sale price': 'sale_price',
  'title': 'title', 'name': 'title',
  'description': 'description', 'body_html': 'description', 'body html': 'description', 'description_sale': 'description',
  'brand': 'brand', 'vendor': 'brand',
  'image src': 'image_1', 'image_src': 'image_1', 'image url': 'image_1', 'image_url': 'image_1',
  'status': 'is_active', 'is_active': 'is_active', 'active': 'is_active',
  'tags': 'search_keywords', 'search_keywords': 'search_keywords',
};

// Amazon-specific auto-map rules
const AMAZON_AUTO_MAP_RULES: Record<string, string> = {
  'sku': 'sku', 'variant_sku': 'sku', 'variant sku': 'sku', 'default_code': 'sku',
  'title': 'item_name', 'name': 'item_name', 'item_name': 'item_name',
  'description': 'product_description', 'body_html': 'product_description', 'body html': 'product_description', 'product_description': 'product_description', 'description_sale': 'product_description',
  'brand': 'brand', 'vendor': 'brand',
  'price': 'price', 'variant_price': 'price', 'variant price': 'price', 'list_price': 'price',
  'msrp': 'msrp', 'compare_at_price': 'msrp', 'compare at price': 'msrp',
  'sale_price': 'sale_price', 'sale price': 'sale_price',
  'quantity': 'fulfillment_availability', 'stock': 'fulfillment_availability', 'inventory_quantity': 'fulfillment_availability',
  'qty': 'fulfillment_availability', 'qty_available': 'fulfillment_availability', 'free_qty': 'fulfillment_availability', 'virtual_available': 'fulfillment_availability',
  'bullet_point_1': 'bullet_point_1', 'bullet point 1': 'bullet_point_1',
  'bullet_point_2': 'bullet_point_2', 'bullet point 2': 'bullet_point_2',
  'bullet_point_3': 'bullet_point_3', 'bullet point 3': 'bullet_point_3',
  'bullet_point_4': 'bullet_point_4', 'bullet point 4': 'bullet_point_4',
  'bullet_point_5': 'bullet_point_5', 'bullet point 5': 'bullet_point_5',
  'image src': 'main_product_image', 'image_src': 'main_product_image', 'image url': 'main_product_image', 'image_url': 'main_product_image',
  'image_2': 'other_product_image_1', 'image_3': 'other_product_image_2', 'image_4': 'other_product_image_3',
  'image_5': 'other_product_image_4', 'image_6': 'other_product_image_5', 'image_7': 'other_product_image_6', 'image_8': 'other_product_image_7',
  'tags': 'search_terms', 'search_terms': 'search_terms', 'search keywords': 'search_terms', 'search_keywords': 'search_terms',
};

const AMAZON_FIELDS = [
  { value: 'sku', label: 'SKU', group: 'Core' },
  { value: 'item_name', label: 'Title', group: 'Content' },
  { value: 'product_description', label: 'Description', group: 'Content' },
  { value: 'brand', label: 'Brand', group: 'Content' },
  { value: 'search_terms', label: 'Search Terms', group: 'Content' },
  { value: 'price', label: 'Price', group: 'Pricing' },
  { value: 'msrp', label: 'MSRP (List Price)', group: 'Pricing' },
  { value: 'sale_price', label: 'Sale Price', group: 'Pricing' },
  { value: 'fulfillment_availability', label: 'Stock Quantity', group: 'Inventory' },
  { value: 'bullet_point_1', label: 'Bullet Point 1', group: 'Content' },
  { value: 'bullet_point_2', label: 'Bullet Point 2', group: 'Content' },
  { value: 'bullet_point_3', label: 'Bullet Point 3', group: 'Content' },
  { value: 'bullet_point_4', label: 'Bullet Point 4', group: 'Content' },
  { value: 'bullet_point_5', label: 'Bullet Point 5', group: 'Content' },
  { value: 'main_product_image', label: 'Main Image', group: 'Media' },
  { value: 'other_product_image_1', label: 'Image 2', group: 'Media' },
  { value: 'other_product_image_2', label: 'Image 3', group: 'Media' },
  { value: 'other_product_image_3', label: 'Image 4', group: 'Media' },
  { value: 'other_product_image_4', label: 'Image 5', group: 'Media' },
  { value: 'other_product_image_5', label: 'Image 6', group: 'Media' },
  { value: 'other_product_image_6', label: 'Image 7', group: 'Media' },
  { value: 'other_product_image_7', label: 'Image 8', group: 'Media' },
];

export default function MappingPage() {
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [selectedFeed, setSelectedFeed] = useState('');
  const [selectedChannel, setSelectedChannel] = useState('');
  const [feedHeaders, setFeedHeaders] = useState<string[]>([]);
  const [mappings, setMappings] = useState<Mapping[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState('');
  const [metafields, setMetafields] = useState<MetafieldMapping[]>([]);

  useEffect(() => {
    Promise.all([api.get('/feeds'), api.get('/channels')]).then(([f, c]) => {
      setFeeds(f as Feed[]);
      setChannels(c as Channel[]);
    });
  }, []);

  useEffect(() => {
    if (!selectedFeed || !selectedChannel) return;
    setLoading(true);

    Promise.all([
      api.get(`/feeds/${selectedFeed}/preview`),
      api.get(`/mappings?feed_id=${selectedFeed}&channel_id=${selectedChannel}`),
    ]).then(([preview, existing]) => {
      const p = preview as { headers: string[] };
      const e = existing as { feed_column: string; target_field: string; transform?: string }[];
      setFeedHeaders(p.headers || []);
      // Separate metafield mappings from regular ones
      const regularMappings = e.filter(m => !m.target_field.startsWith('metafield:'));
      const metafieldMappings = e.filter(m => m.target_field.startsWith('metafield:')).map(m => {
        const parts = m.target_field.replace('metafield:', '').split(':');
        return { namespace: parts[0] || 'custom', key: parts[1] || '', type: parts[2] || 'single_line_text_field', feed_column: m.feed_column };
      });
      setMetafields(metafieldMappings);
      if (regularMappings.length > 0) {
        setMappings(regularMappings);
      } else {
        const autoMapped = autoMapHeaders(p.headers || []);
        setMappings(autoMapped);
      }
    }).catch(console.error)
      .finally(() => setLoading(false));
  }, [selectedFeed, selectedChannel]);

  function autoMapHeaders(headers: string[]): Mapping[] {
    const result: Mapping[] = [];
    const usedTargets = new Set<string>();
    const selectedCh = channels.find(ch => ch.id === selectedChannel);
    const rules = selectedCh?.type === 'amazon' ? AMAZON_AUTO_MAP_RULES : selectedCh?.type === 'noon' ? NOON_AUTO_MAP_RULES : AUTO_MAP_RULES;
    for (const header of headers) {
      const key = header.toLowerCase().trim();
      const target = rules[key];
      if (target && !usedTargets.has(target)) {
        result.push({ feed_column: header, target_field: target });
        usedTargets.add(target);
      }
    }
    return result;
  }

  function handleAutoMap() {
    const autoMapped = autoMapHeaders(feedHeaders);
    // Merge: keep existing mappings that are manual, add new auto-mapped ones
    const existingTargets = new Set(mappings.map(m => m.target_field));
    const newMappings = autoMapped.filter(m => !existingTargets.has(m.target_field));
    setMappings(prev => [...prev, ...newMappings]);
  }

  function addMapping() {
    const defaultTarget = selectedChannelObj?.type === 'noon' ? 'partner_sku' : 'title';
    setMappings(prev => [...prev, { feed_column: feedHeaders[0] || '', target_field: defaultTarget }]);
  }

  function removeMapping(idx: number) {
    setMappings(prev => prev.filter((_, i) => i !== idx));
  }

  function updateMapping(idx: number, key: keyof Mapping, value: string) {
    setMappings(prev => prev.map((m, i) => i === idx ? { ...m, [key]: value } : m));
  }

  async function handleSave() {
    setSaving(true);
    setSavedMsg('');
    try {
      // Combine regular mappings + metafield mappings
      const allMappings = [
        ...mappings,
        ...metafields.filter(m => m.key && m.feed_column).map(m => ({
          feed_column: m.feed_column,
          target_field: `metafield:${m.namespace}:${m.key}:${m.type}`,
        })),
      ];
      await api.put('/mappings/bulk', { feed_id: selectedFeed, channel_id: selectedChannel, mappings: allMappings });
      setSavedMsg('Mappings saved successfully!');
      setTimeout(() => setSavedMsg(''), 3000);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  // Group target fields by channel type
  const selectedChannelObj = channels.find(ch => ch.id === selectedChannel);
  const activeFields = selectedChannelObj?.type === 'amazon' ? AMAZON_FIELDS : selectedChannelObj?.type === 'noon' ? NOON_FIELDS : SHOPIFY_FIELDS;
  const fieldGroups = activeFields.reduce<Record<string, typeof SHOPIFY_FIELDS>>((acc, f) => {
    if (!acc[f.group]) acc[f.group] = [];
    acc[f.group].push(f);
    return acc;
  }, {});

  return (
    <div className="animate-fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Attribute Mapping</h1>
          <p className="page-subtitle">Map feed columns to channel fields for synchronization</p>
        </div>
        {selectedFeed && selectedChannel && mappings.length > 0 && (
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
            <Save size={14} />
            {saving ? 'Saving...' : savedMsg || 'Save Mappings'}
          </button>
        )}
      </div>

      <div className="page-body">
        {/* Selector */}
        <div className="glass-card" style={{ padding: 20, marginBottom: 24, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, alignItems: 'end' }}>
          <div className="form-group">
            <label className="label">Source Feed</label>
            <select className="input" value={selectedFeed} onChange={e => setSelectedFeed(e.target.value)}>
              <option value="">Select feed...</option>
              {feeds.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="label">Target Channel</label>
            <select className="input" value={selectedChannel} onChange={e => setSelectedChannel(e.target.value)}>
              <option value="">Select channel...</option>
              {channels.filter(ch => ch.type === 'shopify' || ch.type === 'noon' || ch.type === 'amazon').map(ch => <option key={ch.id} value={ch.id}>{ch.type === 'noon' ? '🌙' : ch.type === 'amazon' ? '📦' : '🛍️'} {ch.name}</option>)}
            </select>
          </div>
        </div>

        {!selectedFeed || !selectedChannel ? (
          <div className="glass-card" style={{ padding: 64, textAlign: 'center' }}>
            <Map size={40} color="#334155" style={{ margin: '0 auto 16px' }} />
            <p style={{ color: '#475569', fontSize: 15, fontWeight: 600 }}>Select a feed and channel to configure mappings</p>
          </div>
        ) : loading ? (
          <div style={{ textAlign: 'center', paddingTop: 40 }}>
            <div className="spinner" style={{ width: 28, height: 28, border: '3px solid rgba(79,110,247,0.2)', borderTopColor: '#4f6ef7', borderRadius: '50%', margin: '0 auto' }} />
          </div>
        ) : (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <div style={{ fontSize: 14, color: '#64748b' }}>
                {mappings.length} mapping{mappings.length !== 1 ? 's' : ''} configured
                {feedHeaders.length > 0 && ` · ${feedHeaders.length} columns in feed`}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-secondary btn-sm" onClick={handleAutoMap} title="Auto-detect and map matching columns">
                  <Wand2 size={13} /> Auto-Map
                </button>
                <button className="btn btn-secondary btn-sm" onClick={addMapping}>
                  <Plus size={13} /> Add Mapping
                </button>
              </div>
            </div>

            {mappings.length === 0 ? (
              <div className="glass-card" style={{ padding: 48, textAlign: 'center' }}>
                <AlertTriangle size={32} color="#f59e0b" style={{ margin: '0 auto 12px' }} />
                <p style={{ color: '#f59e0b', fontWeight: 600, fontSize: 15, marginBottom: 8 }}>No mappings configured</p>
                <p style={{ color: '#64748b', marginBottom: 16 }}>Sync will not work without mappings. Click "Auto-Map" to detect matching columns automatically.</p>
                <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
                  <button className="btn btn-primary btn-sm" onClick={handleAutoMap}><Wand2 size={13} /> Auto-Map Columns</button>
                  <button className="btn btn-secondary btn-sm" onClick={addMapping}><Plus size={13} /> Add Manually</button>
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {/* Header row */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 40px 1fr 36px', gap: 10, padding: '0 4px' }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Feed Column</div>
                  <div />
                  <div style={{ fontSize: 11, fontWeight: 600, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Target Field</div>
                  <div />
                </div>
                {mappings.map((m, idx) => (
                  <div key={idx} className="glass-card" style={{ padding: '14px 16px', display: 'grid', gridTemplateColumns: '1fr 40px 1fr 36px', gap: 10, alignItems: 'center' }}>
                    <select
                      className="input"
                      value={m.feed_column}
                      onChange={e => updateMapping(idx, 'feed_column', e.target.value)}
                    >
                      {feedHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                      {!feedHeaders.includes(m.feed_column) && m.feed_column && (
                        <option value={m.feed_column}>{m.feed_column} (manual)</option>
                      )}
                    </select>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <ArrowRight size={16} color="#4f6ef7" />
                    </div>
                    <select
                      className="input"
                      value={m.target_field}
                      onChange={e => updateMapping(idx, 'target_field', e.target.value)}
                    >
                      {Object.entries(fieldGroups).map(([group, fields]) => (
                        <optgroup key={group} label={group}>
                          {fields.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
                        </optgroup>
                      ))}
                    </select>
                    <button className="btn btn-danger btn-sm btn-icon" onClick={() => removeMapping(idx)}>
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, marginTop: 8 }}>
                  <button className="btn btn-secondary btn-sm" onClick={addMapping}><Plus size={12} /> Add Row</button>
                </div>

                {/* Metafields Section */}
                <div style={{ marginTop: 32 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
                    <div>
                      <div style={{ fontSize: 15, fontWeight: 700, color: '#e2e8f0' }}>Metafields (Optional)</div>
                      <div style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>Map feed columns to Shopify metafields. Each needs a namespace, key, and type.</div>
                    </div>
                    <button className="btn btn-secondary btn-sm" onClick={() => setMetafields(prev => [...prev, { namespace: 'custom', key: '', type: 'number_decimal', feed_column: '' }])}>
                      <Plus size={12} /> Add Metafield
                    </button>
                  </div>

                  {metafields.length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      {metafields.map((mf, idx) => (
                        <div key={idx} className="glass-card" style={{ padding: '14px 16px', display: 'grid', gridTemplateColumns: '1fr 1.2fr 1fr 1.5fr 36px', gap: 10, alignItems: 'center' }}>
                          <input className="input" placeholder="custom" value={mf.namespace}
                            onChange={e => setMetafields(prev => prev.map((m, i) => i === idx ? { ...m, namespace: e.target.value } : m))} />
                          <input className="input" placeholder="key (e.g. cosmo_2)" value={mf.key}
                            onChange={e => setMetafields(prev => prev.map((m, i) => i === idx ? { ...m, key: e.target.value } : m))} />
                          <select className="input" value={mf.type}
                            onChange={e => setMetafields(prev => prev.map((m, i) => i === idx ? { ...m, type: e.target.value } : m))}>
                            <optgroup label="Basic">
                              <option value="single_line_text_field">Single line text</option>
                              <option value="multi_line_text_field">Multi-line text</option>
                              <option value="rich_text_field">Rich text</option>
                              <option value="number_integer">Integer</option>
                              <option value="number_decimal">Decimal</option>
                              <option value="boolean">Boolean (true/false)</option>
                              <option value="json">JSON</option>
                            </optgroup>
                            <optgroup label="Date & Time">
                              <option value="date">Date</option>
                              <option value="date_time">Date &amp; Time</option>
                            </optgroup>
                            <optgroup label="Measurement">
                              <option value="weight">Weight</option>
                              <option value="volume">Volume</option>
                              <option value="dimension">Dimension</option>
                            </optgroup>
                            <optgroup label="Other">
                              <option value="url">URL</option>
                              <option value="color">Color</option>
                              <option value="rating">Rating</option>
                              <option value="money">Money</option>
                              <option value="file_reference">File reference</option>
                            </optgroup>
                            <optgroup label="Reference">
                              <option value="product_reference">Product reference</option>
                              <option value="collection_reference">Collection reference</option>
                              <option value="variant_reference">Variant reference</option>
                              <option value="page_reference">Page reference</option>
                              <option value="metaobject_reference">Metaobject reference</option>
                            </optgroup>
                            <optgroup label="List">
                              <option value="list.single_line_text_field">List (Text)</option>
                              <option value="list.multi_line_text_field">List (Multi-line text)</option>
                              <option value="list.number_integer">List (Integer)</option>
                              <option value="list.number_decimal">List (Decimal)</option>
                              <option value="list.date">List (Date)</option>
                              <option value="list.date_time">List (Date &amp; Time)</option>
                              <option value="list.url">List (URL)</option>
                              <option value="list.color">List (Color)</option>
                              <option value="list.weight">List (Weight)</option>
                              <option value="list.volume">List (Volume)</option>
                              <option value="list.dimension">List (Dimension)</option>
                              <option value="list.rating">List (Rating)</option>
                              <option value="list.file_reference">List (File reference)</option>
                              <option value="list.product_reference">List (Product reference)</option>
                              <option value="list.collection_reference">List (Collection reference)</option>
                              <option value="list.variant_reference">List (Variant reference)</option>
                              <option value="list.metaobject_reference">List (Metaobject reference)</option>
                            </optgroup>
                          </select>
                          <select className="input" value={mf.feed_column}
                            onChange={e => setMetafields(prev => prev.map((m, i) => i === idx ? { ...m, feed_column: e.target.value } : m))}>
                            <option value="">-- Select Column --</option>
                            {feedHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                          </select>
                          <button className="btn btn-danger btn-sm btn-icon" onClick={() => setMetafields(prev => prev.filter((_, i) => i !== idx))}>
                            <Trash2 size={12} />
                          </button>
                        </div>
                      ))}
                      {/* Header labels */}
                      {metafields.length > 0 && (
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.2fr 1fr 1.5fr 36px', gap: 10, padding: '0 4px', marginTop: -4 }}>
                          <div style={{ fontSize: 10, color: '#475569' }}>Namespace</div>
                          <div style={{ fontSize: 10, color: '#475569' }}>Key</div>
                          <div style={{ fontSize: 10, color: '#475569' }}>Type</div>
                          <div style={{ fontSize: 10, color: '#475569' }}>Feed Column</div>
                          <div />
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, marginTop: 24 }}>
                  <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
                    <Save size={14} />
                    {saving ? 'Saving...' : savedMsg ? '✓ Saved!' : 'Save All Mappings'}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
