import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { Plus, Database, RefreshCw, Eye, Trash2, AlertCircle } from 'lucide-react';

interface Feed {
  id: string; client_id: string; name: string; spreadsheet_id: string;
  sheet_name: string; is_active: boolean; last_sync_at: string | null;
  last_row_count: number; product_count: string; created_at: string;
}
interface Client { id: string; name: string; }

export default function FeedsPage() {
  const [params] = useSearchParams();
  const clientId = params.get('client_id');

  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [importing, setImporting] = useState<string | null>(null);
  const [form, setForm] = useState({ client_id: clientId || '', name: '', spreadsheet_id: '', sheet_name: 'Sheet1', header_row: 1 });
  const [error, setError] = useState('');

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
      const newFeed = await api.post('/feeds', form) as Feed;
      setFeeds(prev => [newFeed, ...prev]);
      setShowModal(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed');
    }
  }

  async function handleImport(feedId: string) {
    setImporting(feedId);
    try {
      await api.post(`/feeds/${feedId}/import`, {});
      alert('Import started! Products will be updated shortly.');
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setImporting(null);
    }
  }

  async function handleDelete(feedId: string) {
    if (!confirm('Delete this feed and all its products?')) return;
    await api.delete(`/feeds/${feedId}`);
    setFeeds(prev => prev.filter(f => f.id !== feedId));
  }

  return (
    <div className="animate-fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Feeds</h1>
          <p className="page-subtitle">Connect Google Sheets as product sources</p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowModal(true)}>
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
            <p style={{ color: '#334155', fontSize: 14, marginBottom: 24 }}>Add a Google Sheet to start importing products</p>
            <button className="btn btn-primary" onClick={() => setShowModal(true)}>
              <Plus size={15} /> Add First Feed
            </button>
          </div>
        ) : (
          <div className="table-container">
            <table className="table">
              <thead>
                <tr>
                  <th>Feed Name</th>
                  <th>Sheet</th>
                  <th>Products</th>
                  <th>Last Sync</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {feeds.map(feed => (
                  <tr key={feed.id}>
                    <td>
                      <div style={{ fontWeight: 600, color: '#e2e8f0' }}>{feed.name}</div>
                      <div style={{ fontSize: 11, color: '#475569', fontFamily: 'var(--font-mono)', marginTop: 2 }}>
                        {feed.spreadsheet_id.slice(0, 20)}...
                      </div>
                    </td>
                    <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: '#94a3b8' }}>{feed.sheet_name}</td>
                    <td>
                      <span style={{ fontWeight: 600, color: '#4ade80' }}>{feed.product_count || 0}</span>
                      <span style={{ fontSize: 12, color: '#475569', marginLeft: 4 }}>products</span>
                    </td>
                    <td style={{ fontSize: 13, color: '#64748b' }}>
                      {feed.last_sync_at ? new Date(feed.last_sync_at).toLocaleString() : 'Never'}
                    </td>
                    <td>
                      <span className={`badge ${feed.is_active ? 'badge-success' : 'badge-muted'}`}>
                        {feed.is_active ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={() => handleImport(feed.id)}
                          disabled={importing === feed.id}
                          title="Import from sheet"
                        >
                          <RefreshCw size={12} className={importing === feed.id ? 'spinner' : ''} />
                          {importing === feed.id ? 'Importing...' : 'Import'}
                        </button>
                        <button className="btn btn-danger btn-sm btn-icon" onClick={() => handleDelete(feed.id)} title="Delete feed">
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showModal && (
        <div className="modal-backdrop" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: '#e2e8f0', marginBottom: 6 }}>Add Feed</h2>
            <p style={{ fontSize: 13, color: '#64748b', marginBottom: 24 }}>Connect a Google Sheet as a product source</p>
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
                <input className="input" placeholder="Product Feed 2024" value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required />
              </div>
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
                <span style={{ fontSize: 12, color: '#94a3b8' }}>Ensure your Google service account has Viewer access to this sheet. Set GOOGLE_SERVICE_ACCOUNT_JSON in your .env file.</span>
              </div>
              {error && <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#f87171' }}>{error}</div>}
              <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
                <button type="button" className="btn btn-secondary" style={{ flex: 1 }} onClick={() => setShowModal(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary" style={{ flex: 1 }}>Add Feed</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
