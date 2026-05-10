import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import Modal from '../components/Modal';
import { useAuth } from '../hooks/useAuth';
import { Plus, Users, Database, GitBranch, ExternalLink, Pencil } from 'lucide-react';

interface Client {
  id: string;
  name: string;
  slug: string;
  logo_url: string | null;
  is_active: boolean;
  feed_count: string;
  channel_count: string;
  created_at: string;
}

export default function ClientsPage() {
  const { isAdmin } = useAuth();
  const navigate = useNavigate();
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({ name: '', slug: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [editClient, setEditClient] = useState<Client | null>(null);
  const [editForm, setEditForm] = useState({ name: '', is_active: true });

  useEffect(() => {
    api.get('/clients').then((data: Client[]) => setClients(data))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const newClient = await api.post('/clients', form) as Client;
      setClients(prev => [newClient, ...prev]);
      setShowModal(false);
      setForm({ name: '', slug: '' });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create client');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="animate-fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Clients</h1>
          <p className="page-subtitle">Manage client profiles and their connected resources</p>
        </div>
        {isAdmin && (
          <button className="btn btn-primary" onClick={() => {
            setForm({ name: '', slug: '' });
            setError('');
            setShowModal(true);
          }}>
            <Plus size={15} /> New Client
          </button>
        )}
      </div>

      <div className="page-body">
        {loading ? (
          <div style={{ textAlign: 'center', paddingTop: 60 }}>
            <div className="spinner" style={{ width: 28, height: 28, border: '3px solid rgba(79,110,247,0.2)', borderTopColor: '#4f6ef7', borderRadius: '50%', margin: '0 auto 12px' }} />
          </div>
        ) : clients.length === 0 ? (
          <div className="glass-card" style={{ padding: 64, textAlign: 'center' }}>
            <Users size={40} color="#334155" style={{ margin: '0 auto 16px' }} />
            <p style={{ color: '#475569', fontSize: 16, fontWeight: 600, marginBottom: 8 }}>No clients yet</p>
            <p style={{ color: '#334155', fontSize: 14, marginBottom: 24 }}>Create your first client profile to get started</p>
            {isAdmin && (
              <button className="btn btn-primary" onClick={() => {
                setForm({ name: '', slug: '' });
                setError('');
                setShowModal(true);
              }}>
                <Plus size={15} /> Create First Client
              </button>
            )}
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 20 }}>
            {clients.map(client => (
              <div key={client.id} className="glass-card glass-card-hover" style={{ padding: 24 }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{
                      width: 44, height: 44, borderRadius: 12,
                      background: 'linear-gradient(135deg, #4f6ef7, #7c3aed)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 18, fontWeight: 700, color: 'white', flexShrink: 0
                    }}>
                      {client.name[0].toUpperCase()}
                    </div>
                    <div>
                      <div style={{ fontSize: 15, fontWeight: 700, color: '#e2e8f0' }}>{client.name}</div>
                      <div style={{ fontSize: 12, color: '#475569', fontFamily: 'var(--font-mono)' }}>/{client.slug}</div>
                    </div>
                  </div>
                  <span className={`badge ${client.is_active ? 'badge-success' : 'badge-muted'}`}>
                    {client.is_active ? 'Active' : 'Inactive'}
                  </span>
                </div>

                <div style={{ display: 'flex', gap: 20, marginBottom: 20 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#64748b', fontSize: 13 }}>
                    <Database size={13} />
                    {client.feed_count} feeds
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#64748b', fontSize: 13 }}>
                    <GitBranch size={13} />
                    {client.channel_count} channels
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    className="btn btn-secondary btn-sm"
                    style={{ flex: 1 }}
                    onClick={() => navigate(`/clients/${client.id}`)}
                  >
                    <ExternalLink size={13} /> View Profile
                  </button>
                  {isAdmin && (
                    <button className="btn btn-secondary btn-sm btn-icon" title="Edit" onClick={() => {
                      setEditClient(client);
                      setEditForm({ name: client.name, is_active: client.is_active });
                    }}>
                      <Pencil size={13} />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Edit Modal */}
      {editClient && (
        <Modal open={true} onClose={() => setEditClient(null)}>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: '#e2e8f0', marginBottom: 6 }}>Edit Client</h2>
            <p style={{ fontSize: 13, color: '#64748b', marginBottom: 24 }}>Update client profile</p>
            <form onSubmit={async (e) => {
              e.preventDefault();
              setSaving(true);
              setError('');
              try {
                const updated = await api.patch(`/clients/${editClient.id}`, editForm) as Client;
                setClients(prev => prev.map(c => c.id === updated.id ? { ...c, ...updated } : c));
                setEditClient(null);
              } catch (err: unknown) {
                setError(err instanceof Error ? err.message : 'Failed to update client');
              } finally {
                setSaving(false);
              }
            }} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div className="form-group">
                <label className="label">Client Name</label>
                <input className="input" value={editForm.name}
                  onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))} required autoFocus />
              </div>
              <div className="form-group">
                <label className="label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input type="checkbox" checked={editForm.is_active}
                    onChange={e => setEditForm(f => ({ ...f, is_active: e.target.checked }))} />
                  Active
                </label>
              </div>
              {error && <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#f87171' }}>{error}</div>}
              <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
                <button type="button" className="btn btn-secondary" style={{ flex: 1 }} onClick={() => setEditClient(null)}>Cancel</button>
                <button type="submit" className="btn btn-primary" style={{ flex: 1 }} disabled={saving}>
                  {saving ? 'Saving...' : 'Save Changes'}
                </button>
              </div>
            </form>
        </Modal>
      )}

      {/* Create Modal */}
      <Modal open={showModal} onClose={() => setShowModal(false)}>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: '#e2e8f0', marginBottom: 6 }}>Create New Client</h2>
            <p style={{ fontSize: 13, color: '#64748b', marginBottom: 24 }}>Set up a new client profile</p>

            <form onSubmit={handleCreate} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div className="form-group">
                <label className="label">Client Name</label>
                <input className="input" placeholder="Acme Corp" value={form.name}
                  onChange={e => {
                    const name = e.target.value;
                    setForm(f => ({ ...f, name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') }));
                  }} required autoFocus />
              </div>
              <div className="form-group">
                <label className="label">Slug (URL identifier)</label>
                <input className="input" placeholder="acme-corp" value={form.slug}
                  onChange={e => setForm(f => ({ ...f, slug: e.target.value }))} required />
              </div>
              {error && <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#f87171' }}>{error}</div>}
              <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
                <button type="button" className="btn btn-secondary" style={{ flex: 1 }} onClick={() => setShowModal(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary" style={{ flex: 1 }} disabled={saving}>
                  {saving ? 'Creating...' : 'Create Client'}
                </button>
              </div>
            </form>
      </Modal>
    </div>
  );
}
