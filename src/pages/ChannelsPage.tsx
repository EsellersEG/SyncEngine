import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import Modal from '../components/Modal';
import { Plus, GitBranch, Trash2, CheckCircle, XCircle, Loader, Pencil } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';

interface Channel {
  id: string; client_id: string; name: string; type: string; status: string;
  shopify_store_url: string; shopify_api_version: string; total_syncs: string;
  last_synced_at: string | null; created_at: string; settings?: { stock_location_id?: string; webhook_secret?: string };
  noon_warehouse_code?: string; noon_country_code?: string;
  amazon_marketplace_ids?: string; amazon_region?: string;
}
interface Client { id: string; name: string; }
interface Location { id: string; name: string; active: boolean; address: string; }

const CHANNEL_TYPES = [
  { value: 'shopify', label: 'Shopify', badge: 'badge-success', color: '#4ade80' },
  { value: 'noon', label: 'Noon', badge: 'badge-warning', color: '#fbbf24' },
  { value: 'amazon', label: 'Amazon', badge: 'badge-warning', color: '#ff9900' },
  { value: 'bol', label: 'Bol.com', badge: 'badge-info', color: '#60a5fa' },
  { value: 'kaufland', label: 'Kaufland', badge: 'badge-warning', color: '#fbbf24' },
  { value: 'cdiscount', label: 'Cdiscount', badge: 'badge-info', color: '#60a5fa' },
];

function StatusIcon({ status }: { status: string }) {
  if (status === 'active') return <CheckCircle size={14} color="#4ade80" />;
  if (status === 'error') return <XCircle size={14} color="#f87171" />;
  return <Loader size={14} color="#fbbf24" />;
}

export default function ChannelsPage() {
  const { isClient } = useAuth();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [form, setForm] = useState({
    client_id: '', name: '', type: 'shopify',
    shopify_store_url: '', shopify_access_token: '', shopify_api_version: '2024-10', webhook_secret: '',
    noon_credentials_json: '', noon_warehouse_code: '', noon_country_code: 'AE',
    amazon_credentials_json: '', amazon_region: 'eu', amazon_marketplace_ids: '' as string,
  });
  const [error, setError] = useState('');
  const [editChannel, setEditChannel] = useState<Channel | null>(null);
  const [editForm, setEditForm] = useState({ name: '', shopify_access_token: '', shopify_api_version: '2024-10', stock_location_id: '', webhook_secret: '', noon_credentials_json: '', noon_warehouse_code: '', noon_country_code: 'AE', amazon_credentials_json: '', amazon_region: 'eu', amazon_marketplace_ids: '' });
  const [locations, setLocations] = useState<Location[]>([]);
  const [loadingLocations, setLoadingLocations] = useState(false);

  useEffect(() => {
    Promise.all([api.get('/channels'), api.get('/clients')])
      .then(([ch, cl]) => { setChannels(ch as Channel[]); setClients(cl as Client[]); })
      .finally(() => setLoading(false));
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      const payload = {
        client_id: form.client_id,
        name: form.name,
        type: form.type,
        shopify_store_url: form.shopify_store_url,
        shopify_access_token: form.shopify_access_token,
        shopify_api_version: form.shopify_api_version,
        noon_credentials_json: form.noon_credentials_json || undefined,
        noon_warehouse_code: form.noon_warehouse_code || undefined,
        noon_country_code: form.noon_country_code || undefined,
        amazon_credentials_json: form.amazon_credentials_json || undefined,
        amazon_marketplace_ids: form.amazon_marketplace_ids || undefined,
        amazon_region: form.amazon_region || undefined,
        settings: { webhook_secret: form.webhook_secret || null },
      };
      const newCh = await api.post('/channels', payload) as Channel;
      setChannels(prev => [newCh, ...prev]);
      setShowModal(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed');
    }
  }

  async function handleTest(channelId: string) {
    setTesting(channelId);
    try {
      const result = await api.post(`/channels/${channelId}/test`, {}) as { success: boolean; shop?: { name: string }; seller?: { name: string; id: string }; marketplaces?: { id: string; country: string }[] };
      if (result.seller) {
        alert(`✅ Connected! Noon Seller: ${result.seller.name}`);
      } else if (result.marketplaces) {
        alert(`✅ Connected! Amazon Marketplaces: ${result.marketplaces.map(m => m.country).join(', ')}`);
      } else {
        alert(result.success ? `✅ Connected! Shop: ${result.shop?.name}` : 'Connection failed');
      }
      setChannels(prev => prev.map(ch => ch.id === channelId ? { ...ch, status: result.success ? 'active' : 'error' } : ch));
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Test failed');
    } finally {
      setTesting(null);
    }
  }

  async function handleDelete(channelId: string) {
    if (!confirm('Delete this channel? All sync history will be removed.')) return;
    await api.delete(`/channels/${channelId}`);
    setChannels(prev => prev.filter(ch => ch.id !== channelId));
  }

  async function openEditModal(ch: Channel) {
    setEditChannel(ch);
    setEditForm({
      name: ch.name,
      shopify_access_token: '',
      shopify_api_version: ch.shopify_api_version || '2024-10',
      stock_location_id: ch.settings?.stock_location_id || '',
      webhook_secret: ch.settings?.webhook_secret || '',
      noon_credentials_json: '',
      noon_warehouse_code: ch.noon_warehouse_code || '',
      noon_country_code: ch.noon_country_code || 'AE',
      amazon_credentials_json: '',
      amazon_region: ch.amazon_region || 'eu',
      amazon_marketplace_ids: ch.amazon_marketplace_ids || '',
    });
    setError('');
    setLocations([]);
    // Fetch locations
    setLoadingLocations(true);
    try {
      const locs = await api.get(`/channels/${ch.id}/locations`) as Location[];
      setLocations(locs);
    } catch { /* ignore - store might not be connected */ }
    setLoadingLocations(false);
  }

  async function handleEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editChannel) return;
    setError('');
    try {
      const body: Record<string, unknown> = { name: editForm.name, shopify_api_version: editForm.shopify_api_version };
      if (editForm.shopify_access_token) body.shopify_access_token = editForm.shopify_access_token;
      if (editForm.noon_credentials_json) body.noon_credentials_json = editForm.noon_credentials_json;
      if (editForm.noon_warehouse_code) body.noon_warehouse_code = editForm.noon_warehouse_code;
      if (editForm.noon_country_code) body.noon_country_code = editForm.noon_country_code;
      if (editForm.amazon_credentials_json) body.amazon_credentials_json = editForm.amazon_credentials_json;
      if (editForm.amazon_marketplace_ids) body.amazon_marketplace_ids = editForm.amazon_marketplace_ids;
      if (editForm.amazon_region) body.amazon_region = editForm.amazon_region;
      body.settings = { stock_location_id: editForm.stock_location_id || null, webhook_secret: editForm.webhook_secret || null };
      const updated = await api.patch(`/channels/${editChannel.id}`, body) as Channel;
      setChannels(prev => prev.map(ch => ch.id === updated.id ? { ...ch, ...updated } : ch));
      setEditChannel(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to update');
    }
  }

  return (
    <div className="animate-fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Channels</h1>
          <p className="page-subtitle">Manage Shopify stores and marketplace connections</p>
        </div>
        {!isClient && (
          <button className="btn btn-primary" onClick={() => {
            setForm({
              client_id: '', name: '', type: 'shopify',
              shopify_store_url: '', shopify_access_token: '', shopify_api_version: '2024-10', webhook_secret: '',
              noon_credentials_json: '', noon_warehouse_code: '', noon_country_code: 'AE',
              amazon_credentials_json: '', amazon_region: 'eu', amazon_marketplace_ids: '',
            });
            setError('');
            setShowModal(true);
          }}>
            <Plus size={15} /> Add Channel
          </button>
        )}
      </div>

      <div className="page-body">
        {loading ? (
          <div style={{ textAlign: 'center', paddingTop: 60 }}>
            <div className="spinner" style={{ width: 28, height: 28, border: '3px solid rgba(79,110,247,0.2)', borderTopColor: '#4f6ef7', borderRadius: '50%', margin: '0 auto' }} />
          </div>
        ) : channels.length === 0 ? (
          <div className="glass-card" style={{ padding: 64, textAlign: 'center' }}>
            <GitBranch size={40} color="#334155" style={{ margin: '0 auto 16px' }} />
            <p style={{ color: '#475569', fontSize: 16, fontWeight: 600, marginBottom: 8 }}>No channels yet</p>
            <p style={{ color: '#334155', fontSize: 14, marginBottom: 24 }}>Connect a Shopify store or marketplace</p>
            {!isClient && (
              <button className="btn btn-primary" onClick={() => {
                setForm({
                  client_id: '', name: '', type: 'shopify',
                  shopify_store_url: '', shopify_access_token: '', shopify_api_version: '2024-10', webhook_secret: '',
                  noon_credentials_json: '', noon_warehouse_code: '', noon_country_code: 'AE',
                  amazon_credentials_json: '', amazon_region: 'eu', amazon_marketplace_ids: '',
                });
                setError('');
                setShowModal(true);
              }}><Plus size={15} /> Add Channel</button>
            )}
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 20 }}>
            {channels.map(ch => {
              const typeInfo = CHANNEL_TYPES.find(t => t.value === ch.type);
              return (
                <div key={ch.id} className="glass-card" style={{ padding: 24 }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <div style={{
                        width: 42, height: 42, borderRadius: 11,
                        background: `${typeInfo?.color || '#4f6ef7'}15`,
                        border: `1px solid ${typeInfo?.color || '#4f6ef7'}30`,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 18
                      }}>
                        {ch.type === 'shopify' ? '🛍️' : ch.type === 'noon' ? '🌙' : ch.type === 'amazon' ? '📦' : ch.type === 'bol' ? '🏪' : '🌐'}
                      </div>
                      <div>
                        <div style={{ fontSize: 15, fontWeight: 700, color: '#e2e8f0' }}>{ch.name}</div>
                        <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>{ch.shopify_store_url || ch.type}</div>
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <StatusIcon status={ch.status} />
                      <span className={`badge ${typeInfo?.badge || 'badge-info'}`}>{typeInfo?.label || ch.type}</span>
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: 20, marginBottom: 16, fontSize: 13, color: '#64748b' }}>
                    <span>{ch.total_syncs || 0} syncs</span>
                    {ch.last_synced_at && <span>Last: {new Date(ch.last_synced_at).toLocaleDateString()}</span>}
                  </div>

                  {!isClient && (
                  <div style={{ display: 'flex', gap: 8 }}>
                    {(ch.type === 'shopify' || ch.type === 'noon' || ch.type === 'amazon') && (
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={() => handleTest(ch.id)}
                        disabled={testing === ch.id}
                        style={{ flex: 1 }}
                      >
                        {testing === ch.id ? <span className="spinner" style={{ width: 12, height: 12, border: '2px solid rgba(255,255,255,0.2)', borderTopColor: 'white', borderRadius: '50%', display: 'inline-block' }} /> : <CheckCircle size={12} />}
                        {testing === ch.id ? 'Testing...' : 'Test Connection'}
                      </button>
                    )}
                    {ch.type !== 'shopify' && ch.type !== 'noon' && ch.type !== 'amazon' && (
                      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: '#475569', padding: '6px 12px', background: 'rgba(45,61,88,0.3)', borderRadius: 8, border: '1px solid rgba(79,110,247,0.1)' }}>
                        Coming in Phase 2
                      </div>
                    )}
                    <button className="btn btn-secondary btn-sm btn-icon" onClick={() => openEditModal(ch)} title="Edit">
                      <Pencil size={12} />
                    </button>
                    <button className="btn btn-danger btn-sm btn-icon" onClick={() => handleDelete(ch.id)} title="Delete">
                      <Trash2 size={12} />
                    </button>
                  </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Edit Modal */}
      {editChannel && (
        <Modal open={true} onClose={() => setEditChannel(null)}>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: '#e2e8f0', marginBottom: 6 }}>Edit Channel</h2>
            <p style={{ fontSize: 13, color: '#64748b', marginBottom: 24 }}>Update {editChannel.name}</p>
            <form onSubmit={handleEdit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div className="form-group">
                <label className="label">Channel Name</label>
                <input className="input" value={editForm.name}
                  onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))} required />
              </div>
              <div className="form-group">
                <label className="label">Access Token (leave blank to keep current)</label>
                <input className="input" type="password" placeholder="shpat_... (unchanged if blank)" value={editForm.shopify_access_token}
                  onChange={e => setEditForm(f => ({ ...f, shopify_access_token: e.target.value }))} />
              </div>
              <div className="form-group">
                <label className="label">API Version</label>
                <select className="input" value={editForm.shopify_api_version}
                  onChange={e => setEditForm(f => ({ ...f, shopify_api_version: e.target.value }))}>
                  <option value="2024-10">2024-10</option>
                  <option value="2024-07">2024-07</option>
                  <option value="2024-04">2024-04</option>
                  <option value="2024-01">2024-01</option>
                </select>
              </div>
              <div className="form-group">
                <label className="label">Stock Location</label>
                {loadingLocations ? (
                  <div style={{ padding: '8px 0', fontSize: 13, color: '#64748b' }}>Loading locations from Shopify...</div>
                ) : locations.length === 0 ? (
                  <div style={{ padding: '8px 0', fontSize: 13, color: '#64748b' }}>No locations found (test connection first)</div>
                ) : (
                  <select className="input" value={editForm.stock_location_id}
                    onChange={e => setEditForm(f => ({ ...f, stock_location_id: e.target.value }))}>
                    <option value="">Auto (first location)</option>
                    {locations.filter(l => l.active).map(loc => (
                      <option key={loc.id} value={loc.id}>{loc.name} — {loc.address}</option>
                    ))}
                  </select>
                )}
              </div>
              {editChannel.type === 'shopify' && (
                <div style={{ border: '1px solid rgba(79,110,247,0.15)', borderRadius: 10, padding: 14, background: 'rgba(13,18,36,0.4)' }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#e2e8f0', marginBottom: 10 }}>Shopify Webhook Registration</div>
                  <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 10 }}>Register this in Shopify Admin → Settings → Notifications → Webhooks → Orders create.</div>
                  <div className="form-group" style={{ marginBottom: 10 }}>
                    <label className="label">Webhook URL</label>
                    <input className="input" readOnly value={`${window.location.origin}/webhooks/shopify/orders`} />
                  </div>
                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <label className="label">Webhook Secret</label>
                    <input className="input" value={editForm.webhook_secret}
                      onChange={e => setEditForm(f => ({ ...f, webhook_secret: e.target.value }))}
                      placeholder="Optional but recommended for HMAC verification" />
                  </div>
                </div>
              )}
              {editChannel.type === 'noon' && (
                <div style={{ border: '1px solid rgba(251,191,36,0.2)', borderRadius: 10, padding: 14, background: 'rgba(13,18,36,0.4)' }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#e2e8f0', marginBottom: 10 }}>Noon Settings</div>
                  <div className="form-group" style={{ marginBottom: 10 }}>
                    <label className="label">Credentials JSON (leave blank to keep current)</label>
                    <textarea className="input" rows={3} placeholder="Paste new credentials to update..." value={editForm.noon_credentials_json}
                      onChange={e => setEditForm(f => ({ ...f, noon_credentials_json: e.target.value }))} style={{ fontFamily: 'monospace', fontSize: 12 }} />
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label className="label">Country</label>
                      <select className="input" value={editForm.noon_country_code}
                        onChange={e => setEditForm(f => ({ ...f, noon_country_code: e.target.value }))}>
                        <option value="AE">UAE (AE)</option>
                        <option value="EG">Egypt (EG)</option>
                      </select>
                    </div>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label className="label">Warehouse Code (FBN)</label>
                      <input className="input" value={editForm.noon_warehouse_code}
                        onChange={e => setEditForm(f => ({ ...f, noon_warehouse_code: e.target.value }))} />
                    </div>
                  </div>
                </div>
              )}
              {editChannel.type === 'amazon' && (
                <div style={{ border: '1px solid rgba(255,153,0,0.2)', borderRadius: 10, padding: 14, background: 'rgba(13,18,36,0.4)' }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#e2e8f0', marginBottom: 10 }}>Amazon Settings</div>
                  <div className="form-group" style={{ marginBottom: 10 }}>
                    <label className="label">Credentials JSON (leave blank to keep current)</label>
                    <textarea className="input" rows={3} placeholder="Paste new credentials to update..." value={editForm.amazon_credentials_json}
                      onChange={e => setEditForm(f => ({ ...f, amazon_credentials_json: e.target.value }))} style={{ fontFamily: 'monospace', fontSize: 12 }} />
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label className="label">Region</label>
                      <select className="input" value={editForm.amazon_region}
                        onChange={e => setEditForm(f => ({ ...f, amazon_region: e.target.value }))}>
                        <option value="na">North America (NA)</option>
                        <option value="eu">Europe / MENA (EU)</option>
                        <option value="fe">Far East (FE)</option>
                      </select>
                    </div>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label className="label">Marketplace IDs</label>
                      <input className="input" value={editForm.amazon_marketplace_ids}
                        onChange={e => setEditForm(f => ({ ...f, amazon_marketplace_ids: e.target.value }))} />
                    </div>
                  </div>
                </div>
              )}
              {error && <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#f87171' }}>{error}</div>}
              <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
                <button type="button" className="btn btn-secondary" style={{ flex: 1 }} onClick={() => setEditChannel(null)}>Cancel</button>
                <button type="submit" className="btn btn-primary" style={{ flex: 1 }}>Save Changes</button>
              </div>
            </form>
        </Modal>
      )}

      <Modal open={showModal} onClose={() => setShowModal(false)}>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: '#e2e8f0', marginBottom: 6 }}>Add Channel</h2>
            <p style={{ fontSize: 13, color: '#64748b', marginBottom: 24 }}>Connect a Shopify store or marketplace</p>
            <form onSubmit={handleCreate} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div className="form-group">
                <label className="label">Client</label>
                <select className="input" value={form.client_id} onChange={e => setForm(f => ({ ...f, client_id: e.target.value }))} required>
                  <option value="">Select client...</option>
                  {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div className="form-group">
                  <label className="label">Channel Name</label>
                  <input className="input" placeholder="Main Shopify Store" value={form.name}
                    onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required />
                </div>
                <div className="form-group">
                  <label className="label">Type</label>
                  <select className="input" value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))}>
                    {CHANNEL_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </div>
              </div>
              {form.type === 'shopify' && (
                <>
                  <div className="form-group">
                    <label className="label">Store URL (without https://)</label>
                    <input className="input" placeholder="your-store.myshopify.com" value={form.shopify_store_url}
                      onChange={e => setForm(f => ({ ...f, shopify_store_url: e.target.value }))} />
                  </div>
                  <div className="form-group">
                    <label className="label">Access Token</label>
                    <input className="input" type="password" placeholder="shpat_..." value={form.shopify_access_token}
                      onChange={e => setForm(f => ({ ...f, shopify_access_token: e.target.value }))} />
                  </div>
                  <div style={{ border: '1px solid rgba(79,110,247,0.15)', borderRadius: 10, padding: 14, background: 'rgba(13,18,36,0.4)' }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#e2e8f0', marginBottom: 10 }}>Shopify Webhook Registration</div>
                    <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 10 }}>After saving, register Orders create in Shopify Admin using this URL.</div>
                    <div className="form-group" style={{ marginBottom: 10 }}>
                      <label className="label">Webhook URL</label>
                      <input className="input" readOnly value={`${window.location.origin}/webhooks/shopify/orders`} />
                    </div>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label className="label">Webhook Secret</label>
                      <input className="input" value={form.webhook_secret}
                        onChange={e => setForm(f => ({ ...f, webhook_secret: e.target.value }))}
                        placeholder="Optional but recommended for HMAC verification" />
                    </div>
                  </div>
                </>
              )}
              {form.type === 'noon' && (
                <>
                  <div className="form-group">
                    <label className="label">Credentials JSON</label>
                    <textarea className="input" rows={4} placeholder={'{\n  "accessKey": "...",\n  "secretKey": "...",\n  "sellerId": "..."\n}'} value={form.noon_credentials_json}
                      onChange={e => setForm(f => ({ ...f, noon_credentials_json: e.target.value }))} style={{ fontFamily: 'monospace', fontSize: 12 }} />
                    <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>Paste your Noon Seller Lab API credentials as JSON</div>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <div className="form-group">
                      <label className="label">Country</label>
                      <select className="input" value={form.noon_country_code}
                        onChange={e => setForm(f => ({ ...f, noon_country_code: e.target.value }))}>
                        <option value="AE">UAE (AE)</option>
                        <option value="EG">Egypt (EG)</option>
                      </select>
                    </div>
                    <div className="form-group">
                      <label className="label">Warehouse Code (FBN)</label>
                      <input className="input" placeholder="e.g. NOON-FBN-AE" value={form.noon_warehouse_code}
                        onChange={e => setForm(f => ({ ...f, noon_warehouse_code: e.target.value }))} />
                    </div>
                  </div>
                  <div style={{ background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.2)', borderRadius: 8, padding: '12px 14px', fontSize: 13, color: '#60a5fa' }}>
                    🌙 Noon FBN integration supports stock sync, price sync, and CSV content pipeline for AE and EG markets.
                  </div>
                </>
              )}
              {form.type === 'amazon' && (
                <>
                  <div className="form-group">
                    <label className="label">Credentials JSON</label>
                    <textarea className="input" rows={5} placeholder={'{\n  "client_id": "amzn1.application-oa2-client...",\n  "client_secret": "...",\n  "refresh_token": "Atzr|...",\n  "seller_id": "A1B2C3D4E5..."\n}'} value={form.amazon_credentials_json}
                      onChange={e => setForm(f => ({ ...f, amazon_credentials_json: e.target.value }))} style={{ fontFamily: 'monospace', fontSize: 12 }} />
                    <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>Paste your Amazon SP-API credentials as JSON</div>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <div className="form-group">
                      <label className="label">Region</label>
                      <select className="input" value={form.amazon_region}
                        onChange={e => setForm(f => ({ ...f, amazon_region: e.target.value, amazon_marketplace_ids: '' }))}>
                        <option value="na">North America (NA)</option>
                        <option value="eu">Europe / MENA (EU)</option>
                        <option value="fe">Far East (FE)</option>
                      </select>
                    </div>
                    <div className="form-group">
                      <label className="label">Marketplace IDs</label>
                      <input className="input" placeholder="e.g. A2VIGQ35RCS4UG,ARBP9OOSHTCHU" value={form.amazon_marketplace_ids}
                        onChange={e => setForm(f => ({ ...f, amazon_marketplace_ids: e.target.value }))} />
                      <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>Comma-separated marketplace IDs</div>
                    </div>
                  </div>
                  <div style={{ background: 'rgba(255,153,0,0.08)', border: '1px solid rgba(255,153,0,0.2)', borderRadius: 8, padding: '12px 14px', fontSize: 13, color: '#ff9900' }}>
                    📦 Amazon SP-API integration supports stock, price, content sync via Feeds API and order polling for AE, EG, US, UK, DE.
                  </div>
                </>
              )}
              {form.type !== 'shopify' && form.type !== 'noon' && form.type !== 'amazon' && (
                <div style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)', borderRadius: 8, padding: '12px 14px', fontSize: 13, color: '#fbbf24' }}>
                  ⚠️ {CHANNEL_TYPES.find(t => t.value === form.type)?.label} integration is planned for Phase 2. You can create the channel now and connect it later.
                </div>
              )}
              {error && <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#f87171' }}>{error}</div>}
              <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
                <button type="button" className="btn btn-secondary" style={{ flex: 1 }} onClick={() => setShowModal(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary" style={{ flex: 1 }}>Add Channel</button>
              </div>
            </form>
      </Modal>
    </div>
  );
}
