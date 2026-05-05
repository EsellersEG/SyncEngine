import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Map, Plus, Save, Trash2, ArrowRight } from 'lucide-react';

interface Feed { id: string; name: string; }
interface Channel { id: string; name: string; type: string; }
interface Mapping { feed_column: string; target_field: string; transform?: string; }

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
      setMappings(e.length > 0 ? e : []);
    }).catch(console.error)
      .finally(() => setLoading(false));
  }, [selectedFeed, selectedChannel]);

  function addMapping() {
    setMappings(prev => [...prev, { feed_column: feedHeaders[0] || '', target_field: 'title' }]);
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
      await api.put('/mappings/bulk', { feed_id: selectedFeed, channel_id: selectedChannel, mappings });
      setSavedMsg('Mappings saved successfully!');
      setTimeout(() => setSavedMsg(''), 3000);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  // Group shopify fields
  const fieldGroups = SHOPIFY_FIELDS.reduce<Record<string, typeof SHOPIFY_FIELDS>>((acc, f) => {
    if (!acc[f.group]) acc[f.group] = [];
    acc[f.group].push(f);
    return acc;
  }, {});

  return (
    <div className="animate-fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Attribute Mapping</h1>
          <p className="page-subtitle">Map feed columns to Shopify fields for synchronization</p>
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
              {channels.filter(ch => ch.type === 'shopify').map(ch => <option key={ch.id} value={ch.id}>{ch.name}</option>)}
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
              <button className="btn btn-secondary btn-sm" onClick={addMapping}>
                <Plus size={13} /> Add Mapping
              </button>
            </div>

            {mappings.length === 0 ? (
              <div className="glass-card" style={{ padding: 48, textAlign: 'center' }}>
                <p style={{ color: '#64748b', marginBottom: 16 }}>No mappings yet. Click "Add Mapping" to get started.</p>
                <button className="btn btn-primary btn-sm" onClick={addMapping}><Plus size={13} /> Add First Mapping</button>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {/* Header row */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 40px 1fr 36px', gap: 10, padding: '0 4px' }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Feed Column</div>
                  <div />
                  <div style={{ fontSize: 11, fontWeight: 600, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Shopify Field</div>
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
