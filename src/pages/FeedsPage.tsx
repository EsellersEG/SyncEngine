import { useEffect, useState, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { Plus, Database, RefreshCw, Trash2, AlertCircle, Pencil, CheckCircle, Loader2 } from 'lucide-react';

interface Feed {
  id: string; client_id: string; name: string; type: string; spreadsheet_id: string;
  sheet_name: string; is_active: boolean; last_sync_at: string | null;
  last_row_count: number; product_count: string; created_at: string;
  odoo_url?: string; odoo_database?: string; odoo_username?: string;
  sync_interval_minutes?: number | null;
}
interface Client { id: string; name: string; }

export default function FeedsPage() {
  const [params] = useSearchParams();
  const clientId = params.get('client_id');

  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingFeed, setEditingFeed] = useState<Feed | null>(null);
  const [importing, setImporting] = useState<string | null>(null);
  const [importProgress, setImportProgress] = useState<{ total: number; processed: number; status: string } | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [form, setForm] = useState({
    client_id: clientId || '', name: '', type: 'google_sheets',
    spreadsheet_id: '', sheet_name: 'Sheet1', header_row: 1,
    odoo_url: '', odoo_database: '', odoo_username: '', odoo_api_key: '',
    sync_interval_minutes: '',
  });
  const [error, setError] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      api.get(`/feeds${clientId ? `?client_id=${clientId}` : ''}`),
      api.get('/clients'),
    ]).then(([f, c]) => {
      setFeeds(f as Feed[]);
      setClients(c as Client[]);
    }).finally(() => setLoading(false));
  }, [clientId]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      const payload: Record<string, unknown> = {
        client_id: form.client_id,
        name: form.name,
        type: form.type,
        sync_interval_minutes: form.sync_interval_minutes ? parseInt(form.sync_interval_minutes) : null,
      };
      if (form.type === 'google_sheets') {
        payload.spreadsheet_id = form.spreadsheet_id;
        payload.sheet_name = form.sheet_name;
        payload.header_row = form.header_row;
      } else {
        payload.odoo_url = form.odoo_url;
        payload.odoo_database = form.odoo_database;
        payload.odoo_username = form.odoo_username;
        // Only send API key if user actually typed one (don't send empty to avoid wiping)
        if (form.odoo_api_key) {
          payload.odoo_api_key = form.odoo_api_key;
        }
      }

      if (editingFeed) {
        const updated = await api.patch(`/feeds/${editingFeed.id}`, payload) as Feed;
        setFeeds(prev => prev.map(f => f.id === editingFeed.id ? { ...f, ...updated } : f));
      } else {
        const newFeed = await api.post('/feeds', payload) as Feed;
        setFeeds(prev => [newFeed, ...prev]);
      }
      setShowModal(false);
      setEditingFeed(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed');
    }
  }

  async function handleTestOdoo() {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api.post('/feeds/test-odoo', {
        url: form.odoo_url, database: form.odoo_database,
        username: form.odoo_username, api_key: form.odoo_api_key,
      }) as { success: boolean; productCount: number };
      setTestResult(`Connected! ${result.productCount} products found.`);
    } catch (err: unknown) {
      setTestResult(err instanceof Error ? err.message : 'Connection failed');
    } finally {
      setTesting(false);
    }
  }

  async function handleImport(feedId: string) {
    setImporting(feedId);
    setImportProgress(null);
    try {
      await api.post(`/feeds/${feedId}/import`, {});
      pollRef.current = setInterval(async () => {
        try {
          const progress = await api.get(`/feeds/${feedId}/import-status`) as { total: number; processed: number; status: string };
          setImportProgress(progress);
          if (progress.status === 'done' || progress.status === 'error' || progress.status === 'idle') {
            clearInterval(pollRef.current!);
            pollRef.current = null;
            setImporting(null);
            if (progress.status === 'done') {
              const f = await api.get(`/feeds${clientId ? `?client_id=${clientId}` : ''}`) as Feed[];
              setFeeds(f);
            }
            setTimeout(() => setImportProgress(null), 3000);
          }
        } catch { /* ignore */ }
      }, 1000);
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Import failed');
      setImporting(null);
    }
  }

  async function handleDelete(feedId: string) {
    if (!confirm('Delete this feed and all its products?')) return;
    await api.delete(`/feeds/${feedId}`);
    setFeeds(prev => prev.filter(f => f.id !== feedId));
  }

  function openCreateModal() {
    setEditingFeed(null);
    setForm({ client_id: clientId || '', name: '', type: 'google_sheets', spreadsheet_id: '', sheet_name: 'Sheet1', header_row: 1, odoo_url: '', odoo_database: '', odoo_username: '', odoo_api_key: '', sync_interval_minutes: '' });
    setError('');
    setTestResult(null);
    setShowModal(true);
  }

  return (
    <>
    <div className="animate-fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Feeds</h1>
          <p className="page-subtitle">Connect Google Sheets or Odoo as product sources</p>
        </div>
        <button className="btn btn-primary" onClick={openCreateModal}>
          <Plus size={15} /> Add Feed
        </button>
      </div>

      <div className="page-body">
        {loading ? (
          <div style={{ textAlign: 'center', paddingTop: 60 }}>
            <div className="spinner" style={{ width: 28, height: 28, border: '3px solid rgba(79,110,247,0.2)', borderTopColor: '#4f6ef7', borderRadius: '50%', margin: '0 auto' }} />
          </div>
        ) : feeds.length === 0 ? (
          <div className="glass-card" style={{ padding: 64, textAlign: 'center' }}>
            <Database size={40} color="#334155" style={{ margin: '0 auto 16px' }} />
            <p style={{ color: '#475569', fontSize: 16, fontWeight: 600, marginBottom: 8 }}>No feeds connected</p>
            <p style={{ color: '#334155', fontSize: 14, marginBottom: 24 }}>Add a Google Sheet or Odoo connection to start importing products</p>
            <button className="btn btn-primary" onClick={openCreateModal}>
              <Plus size={15} /> Add First Feed
            </button>
          </div>
        ) : (
          <div className="table-container">
            <table className="table">
              <thead>
                <tr>
                  <th>Feed Name</th>
                  <th>Type</th>
                  <th>Products</th>
                  <th>Last Sync</th>
                  <th>Auto-Sync</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {feeds.map(feed => (
                  <tr key={feed.id}>
                    <td>
                      <div style={{ fontWeight: 600, color: '#e2e8f0' }}>{feed.name}</div>
                      <div style={{ fontSize: 11, color: '#475569', fontFamily: 'var(--font-mono)', marginTop: 2 }}>
                        {feed.type === 'odoo' ? feed.odoo_url?.replace('https://', '') : `${feed.spreadsheet_id?.slice(0, 20)}...`}
                      </div>
                    </td>
                    <td>
                      <span className={`badge ${feed.type === 'odoo' ? 'badge-warning' : 'badge-info'}`}>
                        {feed.type === 'odoo' ? 'Odoo' : 'Google Sheets'}
                      </span>
                    </td>
                    <td>
                      <span style={{ fontWeight: 600, color: '#4ade80' }}>{feed.product_count || 0}</span>
                      <span style={{ fontSize: 12, color: '#475569', marginLeft: 4 }}>products</span>
                    </td>
                    <td style={{ fontSize: 13, color: '#64748b' }}>
                      {feed.last_sync_at ? new Date(feed.last_sync_at).toLocaleString() : 'Never'}
                    </td>
                    <td style={{ fontSize: 12, color: '#94a3b8' }}>
                      {feed.sync_interval_minutes
                        ? feed.sync_interval_minutes >= 60
                          ? `Every ${feed.sync_interval_minutes / 60}h`
                          : `Every ${feed.sync_interval_minutes}m`
                        : 'Manual'}
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={() => handleImport(feed.id)}
                          disabled={importing === feed.id}
                          title="Import products"
                        >
                          <RefreshCw size={12} className={importing === feed.id ? 'spinner' : ''} />
                          {importing === feed.id && importProgress && importProgress.total > 0
                            ? `${Math.round((importProgress.processed / importProgress.total) * 100)}%`
                            : importing === feed.id ? 'Starting...' : 'Import'}
                        </button>
                        <button className="btn btn-secondary btn-sm btn-icon" onClick={() => {
                          setEditingFeed(feed);
                          setForm({
                            client_id: feed.client_id, name: feed.name, type: feed.type || 'google_sheets',
                            spreadsheet_id: feed.spreadsheet_id || '', sheet_name: feed.sheet_name || 'Sheet1', header_row: 1,
                            odoo_url: feed.odoo_url || '', odoo_database: feed.odoo_database || '',
                            odoo_username: feed.odoo_username || '', odoo_api_key: '',
                            sync_interval_minutes: feed.sync_interval_minutes ? String(feed.sync_interval_minutes) : '',
                          });
                          setError('');
                          setTestResult(null);
                          setShowModal(true);
                        }} title="Edit feed">
                          <Pencil size={12} />
                        </button>
                        <button className="btn btn-danger btn-sm btn-icon" onClick={() => handleDelete(feed.id)} title="Delete feed">
                          <Trash2 size={12} />
                        </button>
                      </div>
                      {importing === feed.id && importProgress && importProgress.total > 0 && (
                        <div style={{ marginTop: 8 }}>
                          <div className="progress-bar" style={{ height: 4 }}>
                            <div className="progress-fill" style={{ width: `${Math.round((importProgress.processed / importProgress.total) * 100)}%` }} />
                          </div>
                          <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>
                            {importProgress.processed.toLocaleString()} / {importProgress.total.toLocaleString()} products
                          </div>
                        </div>
                      )}
                      {importProgress?.status === 'done' && !importing && (
                        <div style={{ marginTop: 6, fontSize: 12, color: '#4ade80' }}>✓ Import complete</div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      </div>

      {showModal && (
        <div className="modal-backdrop" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 540 }}>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: '#e2e8f0', marginBottom: 6 }}>{editingFeed ? 'Edit Feed' : 'Add Feed'}</h2>
            <p style={{ fontSize: 13, color: '#64748b', marginBottom: 24 }}>Connect a product source for synchronization</p>
            <form onSubmit={handleCreate} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div className="form-group">
                <label className="label">Client</label>
                <select className="input" value={form.client_id} onChange={e => setForm(f => ({ ...f, client_id: e.target.value }))} required>
                  <option value="">Select client...</option>
                  {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label className="label">Feed Name</label>
                <input className="input" placeholder="Product Feed" value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required />
              </div>

              {/* Type Selector */}
              <div className="form-group">
                <label className="label">Feed Type</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" className={`btn ${form.type === 'google_sheets' ? 'btn-primary' : 'btn-secondary'} btn-sm`} style={{ flex: 1 }}
                    onClick={() => setForm(f => ({ ...f, type: 'google_sheets' }))}>
                    Google Sheets
                  </button>
                  <button type="button" className={`btn ${form.type === 'odoo' ? 'btn-primary' : 'btn-secondary'} btn-sm`} style={{ flex: 1 }}
                    onClick={() => setForm(f => ({ ...f, type: 'odoo' }))}>
                    Odoo
                  </button>
                </div>
              </div>

              {/* Google Sheets Fields */}
              {form.type === 'google_sheets' && (
                <>
                  <div className="form-group">
                    <label className="label">Google Sheet ID</label>
                    <input className="input" placeholder="1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms"
                      value={form.spreadsheet_id}
                      onChange={e => setForm(f => ({ ...f, spreadsheet_id: e.target.value }))} required />
                    <span style={{ fontSize: 11, color: '#475569', marginTop: 4 }}>From the Google Sheets URL: /d/[ID]/edit</span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <div className="form-group">
                      <label className="label">Sheet Name</label>
                      <input className="input" placeholder="Sheet1" value={form.sheet_name}
                        onChange={e => setForm(f => ({ ...f, sheet_name: e.target.value }))} />
                    </div>
                    <div className="form-group">
                      <label className="label">Header Row</label>
                      <input className="input" type="number" min={1} value={form.header_row}
                        onChange={e => setForm(f => ({ ...f, header_row: parseInt(e.target.value) }))} />
                    </div>
                  </div>
                  <div style={{ background: 'rgba(79,110,247,0.06)', border: '1px solid rgba(79,110,247,0.15)', borderRadius: 8, padding: '10px 12px', display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                    <AlertCircle size={14} color="#6b87ff" style={{ flexShrink: 0, marginTop: 1 }} />
                    <span style={{ fontSize: 12, color: '#94a3b8' }}>Ensure your Google service account has Viewer access to this sheet.</span>
                  </div>
                </>
              )}

              {/* Odoo Fields */}
              {form.type === 'odoo' && (
                <>
                  <div className="form-group">
                    <label className="label">Odoo URL</label>
                    <input className="input" placeholder="https://mycompany.odoo.com" value={form.odoo_url}
                      onChange={e => setForm(f => ({ ...f, odoo_url: e.target.value }))} required />
                  </div>
                  <div className="form-group">
                    <label className="label">Database Name</label>
                    <input className="input" placeholder="mycompany" value={form.odoo_database}
                      onChange={e => setForm(f => ({ ...f, odoo_database: e.target.value }))} required />
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <div className="form-group">
                      <label className="label">Username / Email</label>
                      <input className="input" placeholder="admin@company.com" value={form.odoo_username}
                        onChange={e => setForm(f => ({ ...f, odoo_username: e.target.value }))} required />
                    </div>
                    <div className="form-group">
                      <label className="label">API Key</label>
                      <input className="input" type="password" placeholder="••••••••" value={form.odoo_api_key}
                        onChange={e => setForm(f => ({ ...f, odoo_api_key: e.target.value }))} required={!editingFeed} />
                    </div>
                  </div>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={handleTestOdoo} disabled={testing || !form.odoo_url || !form.odoo_database || !form.odoo_username || !form.odoo_api_key}>
                    {testing ? <><Loader2 size={12} className="spinner" /> Testing...</> : <><CheckCircle size={12} /> Test Connection</>}
                  </button>
                  {testResult && (
                    <div style={{ background: testResult.includes('Connected') ? 'rgba(74,222,128,0.1)' : 'rgba(239,68,68,0.1)', border: `1px solid ${testResult.includes('Connected') ? 'rgba(74,222,128,0.3)' : 'rgba(239,68,68,0.3)'}`, borderRadius: 8, padding: '10px 14px', fontSize: 13, color: testResult.includes('Connected') ? '#4ade80' : '#f87171' }}>
                      {testResult}
                    </div>
                  )}
                  <div style={{ background: 'rgba(251,191,36,0.06)', border: '1px solid rgba(251,191,36,0.15)', borderRadius: 8, padding: '10px 12px', display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                    <AlertCircle size={14} color="#fbbf24" style={{ flexShrink: 0, marginTop: 1 }} />
                    <span style={{ fontSize: 12, color: '#94a3b8' }}>Odoo Online requires a Custom plan for XML-RPC access. Products are matched by barcode.</span>
                  </div>
                </>
              )}

              {/* Auto-sync interval */}
              <div className="form-group">
                <label className="label">Auto-Import Interval</label>
                <select className="input" value={form.sync_interval_minutes} onChange={e => setForm(f => ({ ...f, sync_interval_minutes: e.target.value }))}>
                  <option value="">Manual only</option>
                  <option value="15">Every 15 minutes</option>
                  <option value="30">Every 30 minutes</option>
                  <option value="60">Every 1 hour</option>
                  <option value="120">Every 2 hours</option>
                  <option value="360">Every 6 hours</option>
                  <option value="720">Every 12 hours</option>
                </select>
              </div>

              {error && <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#f87171' }}>{error}</div>}
              <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
                <button type="button" className="btn btn-secondary" style={{ flex: 1 }} onClick={() => setShowModal(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary" style={{ flex: 1 }}>{editingFeed ? 'Save Changes' : 'Add Feed'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
