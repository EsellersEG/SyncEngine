import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Plus, GitBranch, Trash2, CheckCircle, XCircle, Loader } from 'lucide-react';

interface Channel {
  id: string; client_id: string; name: string; type: string; status: string;
  shopify_store_url: string; shopify_api_version: string; total_syncs: string;
  last_synced_at: string | null; created_at: string;
}
interface Client { id: string; name: string; }

const CHANNEL_TYPES = [
  { value: 'shopify', label: 'Shopify', badge: 'badge-success', color: '#4ade80' },
  { value: 'amazon', label: 'Amazon', badge: 'badge-warning', color: '#fbbf24' },
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
  const [channels, setChannels] = useState<Channel[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [form, setForm] = useState({
    client_id: '', name: '', type: 'shopify',
    shopify_store_url: '', shopify_access_token: '', shopify_api_version: '2024-10',
  });
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([api.get('/channels'), api.get('/clients')])
      .then(([ch, cl]) => { setChannels(ch as Channel[]); setClients(cl as Client[]); })
      .finally(() => setLoading(false));
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      const newCh = await api.post('/channels', form) as Channel;
      setChannels(prev => [newCh, ...prev]);
      setShowModal(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed');
    }
  }

  async function handleTest(channelId: string) {
    setTesting(channelId);
    try {
      const result = await api.post(`/channels/${channelId}/test`, {}) as { success: boolean; shop?: { name: string } };
      alert(result.success ? `✅ Connected! Shop: ${result.shop?.name}` : 'Connection failed');
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

  return (
    <div className="animate-fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Channels</h1>
          <p className="page-subtitle">Manage Shopify stores and marketplace connections</p>
        </div>
        <button className="btn btn-primary" onClick={() => {
          setForm({
            client_id: '', name: '', type: 'shopify',
            shopify_store_url: '', shopify_access_token: '', shopify_api_version: '2024-10',
          });
          setError('');
          setShowModal(true);
        }}>
          <Plus size={15} /> Add Channel
        </button>
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
            <button className="btn btn-primary" onClick={() => {
              setForm({
                client_id: '', name: '', type: 'shopify',
                shopify_store_url: '', shopify_access_token: '', shopify_api_version: '2024-10',
              });
              setError('');
              setShowModal(true);
            }}><Plus size={15} /> Add Channel</button>
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
                        {ch.type === 'shopify' ? '🛍️' : ch.type === 'amazon' ? '📦' : ch.type === 'bol' ? '🏪' : '🌐'}
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

                  <div style={{ display: 'flex', gap: 8 }}>
                    {ch.type === 'shopify' && (
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
                    {ch.type !== 'shopify' && (
                      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: '#475569', padding: '6px 12px', background: 'rgba(45,61,88,0.3)', borderRadius: 8, border: '1px solid rgba(79,110,247,0.1)' }}>
                        Coming in Phase 2
                      </div>
                    )}
                    <button className="btn btn-danger btn-sm btn-icon" onClick={() => handleDelete(ch.id)} title="Delete">
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {showModal && (
        <div className="modal-backdrop" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
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
                </>
              )}
              {form.type !== 'shopify' && (
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
          </div>
        </div>
      )}
    </div>
  );
}
