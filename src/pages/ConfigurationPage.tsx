import { useState, useEffect } from 'react';
import { api } from '../lib/api';
import { Plus, Trash2, Copy, ExternalLink, Star, Edit2, X, Check } from 'lucide-react';

interface AmazonApp {
  id: string;
  name: string;
  app_id: string;
  client_id: string;
  is_default: boolean;
  created_at: string;
  updated_at?: string;
}

interface OAuthUrls {
  oauth_login_uri: string;
  oauth_redirect_uri: string;
  seller_central_authorize_url: string;
}

export default function ConfigurationPage() {
  const [apps, setApps] = useState<AmazonApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [oauthUrls, setOauthUrls] = useState<OAuthUrls | null>(null);
  const [showUrlsFor, setShowUrlsFor] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [form, setForm] = useState({
    name: '', app_id: '', client_id: '', client_secret: '', is_default: false,
  });

  useEffect(() => { loadApps(); }, []);

  async function loadApps() {
    try {
      const data = await api.get('/amazon/apps') as AmazonApp[];
      setApps(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load apps');
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      if (editingId) {
        await api.patch(`/amazon/apps/${editingId}`, form);
      } else {
        await api.post('/amazon/apps', form);
      }
      setShowForm(false);
      setEditingId(null);
      setForm({ name: '', app_id: '', client_id: '', client_secret: '', is_default: false });
      await loadApps();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save app');
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this Amazon app? OAuth tokens linked to it will also be deleted.')) return;
    try {
      await api.delete(`/amazon/apps/${id}`);
      await loadApps();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete');
    }
  }

  async function handleShowUrls(id: string) {
    if (showUrlsFor === id) { setShowUrlsFor(null); setOauthUrls(null); return; }
    try {
      const urls = await api.get(`/amazon/apps/${id}/oauth-urls`) as OAuthUrls;
      setOauthUrls(urls);
      setShowUrlsFor(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to get URLs');
    }
  }

  function startEdit(app: AmazonApp) {
    setEditingId(app.id);
    setForm({ name: app.name, app_id: app.app_id, client_id: app.client_id, client_secret: '', is_default: app.is_default });
    setShowForm(true);
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text);
  }

  if (loading) return <div style={{ padding: 32, color: '#64748b' }}>Loading...</div>;

  return (
    <div className="animate-fade-in" style={{ padding: '32px 32px 48px' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 28 }}>
        <div>
          <h1 className="gradient-text" style={{ fontSize: 24, fontWeight: 800, marginBottom: 4 }}>Configuration</h1>
          <p style={{ fontSize: 14, color: '#64748b' }}>Manage your marketplace API apps and credentials</p>
        </div>
      </div>

      {error && (
        <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 10, padding: '12px 16px', marginBottom: 20, fontSize: 13, color: '#f87171' }}>
          {error}
          <button onClick={() => setError('')} style={{ float: 'right', background: 'none', border: 'none', color: '#f87171', cursor: 'pointer' }}>✕</button>
        </div>
      )}

      {/* Amazon Apps Section */}
      <div className="glass-card" style={{ padding: 24, marginBottom: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 32, height: 32, borderRadius: 8, background: 'rgba(255,153,0,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <span style={{ fontSize: 18 }}>🛒</span>
            </div>
            <div>
              <h2 style={{ fontSize: 16, fontWeight: 700, color: '#e2e8f0', margin: 0 }}>Amazon SP-API Apps</h2>
              <p style={{ fontSize: 12, color: '#64748b', margin: 0 }}>Register your Amazon Developer apps for OAuth seller authorization</p>
            </div>
          </div>
          <button className="btn btn-primary btn-sm" onClick={() => { setShowForm(true); setEditingId(null); setForm({ name: '', app_id: '', client_id: '', client_secret: '', is_default: false }); }}>
            <Plus size={14} /> Add App
          </button>
        </div>

        {/* App List */}
        {apps.length === 0 && !showForm && (
          <div style={{ textAlign: 'center', padding: '40px 20px', color: '#475569' }}>
            <p style={{ fontSize: 14, marginBottom: 8 }}>No Amazon apps configured yet.</p>
            <p style={{ fontSize: 12, color: '#64748b' }}>Add your SP-API app credentials to enable OAuth seller authorization.</p>
          </div>
        )}

        {apps.map(app => (
          <div key={app.id} style={{ border: '1px solid rgba(255,153,0,0.15)', borderRadius: 12, padding: 16, marginBottom: 12, background: 'rgba(13,18,36,0.4)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <span style={{ fontSize: 15, fontWeight: 600, color: '#e2e8f0' }}>{app.name}</span>
                  {app.is_default && (
                    <span style={{ fontSize: 10, background: 'rgba(255,153,0,0.2)', color: '#ff9900', padding: '2px 8px', borderRadius: 10, fontWeight: 600 }}>
                      <Star size={10} style={{ marginRight: 3 }} />DEFAULT
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 12, color: '#64748b', fontFamily: 'monospace' }}>
                  App ID: {app.app_id}
                </div>
                <div style={{ fontSize: 12, color: '#64748b', fontFamily: 'monospace' }}>
                  Client ID: {app.client_id}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn btn-secondary btn-sm" onClick={() => handleShowUrls(app.id)} title="Show OAuth URLs">
                  <ExternalLink size={13} />
                </button>
                <button className="btn btn-secondary btn-sm" onClick={() => startEdit(app)} title="Edit">
                  <Edit2 size={13} />
                </button>
                <button className="btn btn-secondary btn-sm" onClick={() => handleDelete(app.id)} title="Delete" style={{ color: '#f87171' }}>
                  <Trash2 size={13} />
                </button>
              </div>
            </div>

            {/* OAuth URLs panel */}
            {showUrlsFor === app.id && oauthUrls && (
              <div style={{ marginTop: 14, padding: 14, background: 'rgba(255,153,0,0.05)', borderRadius: 10, border: '1px solid rgba(255,153,0,0.15)' }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#ff9900', marginBottom: 10 }}>OAuth URLs — Copy these to Amazon Developer Console:</div>

                <div style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 11, color: '#94a3b8', display: 'block', marginBottom: 4 }}>OAuth Login URI</label>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input readOnly value={oauthUrls.oauth_login_uri} style={{ flex: 1, fontSize: 12, fontFamily: 'monospace', background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, padding: '6px 10px', color: '#e2e8f0' }} />
                    <button className="btn btn-secondary btn-sm" onClick={() => copyToClipboard(oauthUrls.oauth_login_uri)} title="Copy"><Copy size={12} /></button>
                  </div>
                </div>

                <div style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 11, color: '#94a3b8', display: 'block', marginBottom: 4 }}>OAuth Redirect URI</label>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input readOnly value={oauthUrls.oauth_redirect_uri} style={{ flex: 1, fontSize: 12, fontFamily: 'monospace', background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, padding: '6px 10px', color: '#e2e8f0' }} />
                    <button className="btn btn-secondary btn-sm" onClick={() => copyToClipboard(oauthUrls.oauth_redirect_uri)} title="Copy"><Copy size={12} /></button>
                  </div>
                </div>

                <div>
                  <label style={{ fontSize: 11, color: '#94a3b8', display: 'block', marginBottom: 4 }}>Seller Authorization Link (send to sellers)</label>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input readOnly value={oauthUrls.seller_central_authorize_url} style={{ flex: 1, fontSize: 12, fontFamily: 'monospace', background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, padding: '6px 10px', color: '#e2e8f0' }} />
                    <button className="btn btn-secondary btn-sm" onClick={() => copyToClipboard(oauthUrls.seller_central_authorize_url)} title="Copy"><Copy size={12} /></button>
                  </div>
                </div>
              </div>
            )}
          </div>
        ))}

        {/* Add/Edit Form */}
        {showForm && (
          <div style={{ border: '1px solid rgba(255,153,0,0.2)', borderRadius: 12, padding: 20, background: 'rgba(13,18,36,0.6)', marginTop: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, color: '#e2e8f0', margin: 0 }}>
                {editingId ? 'Edit Amazon App' : 'Add New Amazon App'}
              </h3>
              <button onClick={() => { setShowForm(false); setEditingId(null); }} style={{ background: 'none', border: 'none', color: '#64748b', cursor: 'pointer' }}>
                <X size={16} />
              </button>
            </div>

            <form onSubmit={handleSubmit}>
              <div className="form-group" style={{ marginBottom: 12 }}>
                <label className="label">App Name</label>
                <input className="input" placeholder="e.g. My SP-API App" value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required />
              </div>

              <div className="form-group" style={{ marginBottom: 12 }}>
                <label className="label">Application ID</label>
                <input className="input" placeholder="amzn1.sp.solution.xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" value={form.app_id}
                  onChange={e => setForm(f => ({ ...f, app_id: e.target.value }))} required style={{ fontFamily: 'monospace', fontSize: 12 }} />
              </div>

              <div className="form-group" style={{ marginBottom: 12 }}>
                <label className="label">LWA Client ID</label>
                <input className="input" placeholder="amzn1.application-oa2-client.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" value={form.client_id}
                  onChange={e => setForm(f => ({ ...f, client_id: e.target.value }))} required style={{ fontFamily: 'monospace', fontSize: 12 }} />
              </div>

              <div className="form-group" style={{ marginBottom: 12 }}>
                <label className="label">LWA Client Secret {editingId && '(leave blank to keep current)'}</label>
                <input className="input" type="password" placeholder="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" value={form.client_secret}
                  onChange={e => setForm(f => ({ ...f, client_secret: e.target.value }))} required={!editingId} style={{ fontFamily: 'monospace', fontSize: 12 }} />
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#94a3b8', cursor: 'pointer' }}>
                  <input type="checkbox" checked={form.is_default} onChange={e => setForm(f => ({ ...f, is_default: e.target.checked }))} />
                  Set as default app
                </label>
              </div>

              <div style={{ display: 'flex', gap: 8 }}>
                <button type="submit" className="btn btn-primary btn-sm">
                  <Check size={14} /> {editingId ? 'Update' : 'Save App'}
                </button>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setShowForm(false); setEditingId(null); }}>
                  Cancel
                </button>
              </div>
            </form>
          </div>
        )}
      </div>

      {/* Info card */}
      <div className="glass-card" style={{ padding: 20 }}>
        <h3 style={{ fontSize: 14, fontWeight: 600, color: '#e2e8f0', marginBottom: 12 }}>How it works</h3>
        <ol style={{ fontSize: 13, color: '#94a3b8', lineHeight: 1.8, paddingLeft: 20, margin: 0 }}>
          <li>Create an SP-API app in <a href="https://developer.amazonservices.com" target="_blank" rel="noopener" style={{ color: '#ff9900' }}>Amazon Developer Central</a></li>
          <li>Add the app credentials here (App ID, Client ID, Client Secret)</li>
          <li>Click the <ExternalLink size={12} style={{ verticalAlign: 'middle' }} /> button to see the OAuth URLs</li>
          <li>Copy the <strong>OAuth Login URI</strong> and <strong>OAuth Redirect URI</strong> into your Amazon app settings</li>
          <li>Share the <strong>Seller Authorization Link</strong> with sellers to connect their accounts</li>
          <li>Once authorized, the refresh token is auto-stored and linked to matching channels</li>
        </ol>
      </div>
    </div>
  );
}
