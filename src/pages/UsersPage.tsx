import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../hooks/useAuth';
import { Plus, UserCheck, Shield, Eye, Pencil, X } from 'lucide-react';
interface User {
  id: string; name: string; email: string; role: string;
  is_active: boolean; created_at: string;
  feed_count?: number; channel_count?: number;
}
interface Feed { id: string; name: string; type: string; }
interface Channel { id: string; name: string; type: string; }

function RoleBadge({ role }: { role: string }) {
  const map: Record<string, { badge: string; icon: React.ElementType }> = {
    admin: { badge: 'badge-info', icon: Shield },
    client: { badge: 'badge-success', icon: UserCheck },
    viewer: { badge: 'badge-muted', icon: Eye },
  };
  const { badge, icon: Icon } = map[role] || map.viewer;
  return <span className={`badge ${badge}`}><Icon size={10} /> {role}</span>;
}

const emptyCreate = { name: '', email: '', password: '', role: 'client' };
const emptyEdit = { name: '', role: 'client', is_active: true, password: '' };

export default function UsersPage() {
  const { isAdmin } = useAuth();
  const [users, setUsers] = useState<User[]>([]);
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);

  // Create modal
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState(emptyCreate);
  const [createError, setCreateError] = useState('');
  const [creating, setSaving] = useState(false);

  // Edit modal
  const [editUser, setEditUser] = useState<User | null>(null);
  const [editForm, setEditForm] = useState(emptyEdit);
  const [assignedFeeds, setAssignedFeeds] = useState<string[]>([]);
  const [assignedChannels, setAssignedChannels] = useState<string[]>([]);
  const [editError, setEditError] = useState('');
  const [editSaving, setEditSaving] = useState(false);

  useEffect(() => {
    // Fetch each independently so a failure in one doesn't block the whole page
    api.get('/users').then((u) => setUsers(u as User[])).catch(console.error).finally(() => setLoading(false));
    api.get('/feeds').then((f) => setFeeds(f as Feed[])).catch(() => setFeeds([]));
    api.get('/channels').then((c) => setChannels(c as Channel[])).catch(() => setChannels([]));
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true); setCreateError('');
    try {
      const newUser = await api.post('/users', createForm) as User;
      setUsers(prev => [newUser, ...prev]);
      setShowCreate(false); setCreateForm(emptyCreate);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create user');
    } finally { setSaving(false); }
  }

  async function openEdit(user: User) {
    setEditUser(user);
    setEditForm({ name: user.name, role: user.role, is_active: user.is_active, password: '' });
    setEditError('');
    try {
      const a = await api.get(`/users/${user.id}/assignments`) as { feed_ids: string[]; channel_ids: string[] };
      setAssignedFeeds(a.feed_ids);
      setAssignedChannels(a.channel_ids);
    } catch { setAssignedFeeds([]); setAssignedChannels([]); }
  }

  async function handleEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editUser) return;
    setEditSaving(true); setEditError('');
    try {
      const payload: Record<string, unknown> = { name: editForm.name, role: editForm.role, is_active: editForm.is_active };
      if (editForm.password.length >= 8) payload.password = editForm.password;
      const updated = await api.patch(`/users/${editUser.id}`, payload) as User;
      // Save assignments only for non-admin users
      if (editForm.role !== 'admin') {
        await api.put(`/users/${editUser.id}/assignments`, { feed_ids: assignedFeeds, channel_ids: assignedChannels });
      }
      setUsers(prev => prev.map(u => u.id === editUser.id ? { ...u, ...updated } : u));
      setEditUser(null);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'Failed to save');
    } finally { setEditSaving(false); }
  }

  function toggleFeed(id: string) {
    setAssignedFeeds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  }
  function toggleChannel(id: string) {
    setAssignedChannels(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  }

  if (!isAdmin) return (
    <div className="page-body" style={{ textAlign: 'center', paddingTop: 80 }}>
      <Shield size={40} color="#334155" style={{ margin: '0 auto 16px' }} />
      <p style={{ color: '#475569', fontSize: 16 }}>Admin access required</p>
    </div>
  );

  return (
    <div className="animate-fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Users & Access</h1>
          <p className="page-subtitle">Manage user accounts and permissions</p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowCreate(true)}>
          <Plus size={15} /> Create User
        </button>
      </div>

      <div className="page-body">
        {loading ? (
          <div style={{ textAlign: 'center', paddingTop: 60 }}>
            <div className="spinner" style={{ width: 28, height: 28, border: '3px solid rgba(79,110,247,0.2)', borderTopColor: '#4f6ef7', borderRadius: '50%', margin: '0 auto' }} />
          </div>
        ) : (
          <div className="table-container">
            <table className="table">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Access</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map(user => (
                  <tr key={user.id}>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'linear-gradient(135deg, #4f6ef7, #7c3aed)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, color: 'white', flexShrink: 0 }}>
                          {user.name[0]?.toUpperCase()}
                        </div>
                        <span style={{ fontWeight: 600, color: '#e2e8f0' }}>{user.name}</span>
                      </div>
                    </td>
                    <td style={{ color: '#94a3b8', fontSize: 13 }}>{user.email}</td>
                    <td><RoleBadge role={user.role} /></td>
                    <td style={{ fontSize: 12, color: '#64748b' }}>
                      {user.role === 'admin'
                        ? <span style={{ color: '#4f6ef7' }}>Full access</span>
                        : <span>{user.feed_count ?? 0} feed{Number(user.feed_count) !== 1 ? 's' : ''} · {user.channel_count ?? 0} channel{Number(user.channel_count) !== 1 ? 's' : ''}</span>}
                    </td>
                    <td>
                      <span className={`badge ${user.is_active ? 'badge-success' : 'badge-muted'}`}>
                        {user.is_active ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td style={{ fontSize: 13, color: '#64748b' }}>{new Date(user.created_at).toLocaleDateString()}</td>
                    <td>
                      <button className="btn btn-secondary btn-sm" onClick={() => openEdit(user)}>
                        <Pencil size={11} /> Edit
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Create Modal ── */}
      {showCreate && (
        <div className="modal-backdrop" onClick={() => setShowCreate(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h2 style={{ fontSize: 18, fontWeight: 700, color: '#e2e8f0' }}>Create User</h2>
              <button className="btn btn-secondary btn-sm" onClick={() => setShowCreate(false)}><X size={14} /></button>
            </div>
            <form onSubmit={handleCreate} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div className="form-group">
                <label className="label">Full Name</label>
                <input className="input" placeholder="Jane Smith" value={createForm.name}
                  onChange={e => setCreateForm(f => ({ ...f, name: e.target.value }))} required />
              </div>
              <div className="form-group">
                <label className="label">Email</label>
                <input className="input" type="email" placeholder="jane@company.com" value={createForm.email}
                  onChange={e => setCreateForm(f => ({ ...f, email: e.target.value }))} required />
              </div>
              <div className="form-group">
                <label className="label">Password</label>
                <input className="input" type="password" placeholder="Min 8 characters" value={createForm.password}
                  onChange={e => setCreateForm(f => ({ ...f, password: e.target.value }))} required minLength={8} />
              </div>
              <div className="form-group">
                <label className="label">Role</label>
                <select className="input" value={createForm.role} onChange={e => setCreateForm(f => ({ ...f, role: e.target.value }))}>
                  <option value="admin">Administrator — Full access to everything</option>
                  <option value="client">Client — Assigned feeds & channels only</option>
                  <option value="viewer">Viewer — Read-only on assigned items</option>
                </select>
              </div>
              {createError && <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#f87171' }}>{createError}</div>}
              <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
                <button type="button" className="btn btn-secondary" style={{ flex: 1 }} onClick={() => setShowCreate(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary" style={{ flex: 1 }} disabled={creating}>{creating ? 'Creating...' : 'Create User'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Edit Modal ── */}
      {editUser && (
        <div className="modal-backdrop" onClick={() => setEditUser(null)}>
          <div className="modal" style={{ maxWidth: 560 }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <div>
                <h2 style={{ fontSize: 18, fontWeight: 700, color: '#e2e8f0' }}>Edit User</h2>
                <p style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>{editUser.email}</p>
              </div>
              <button className="btn btn-secondary btn-sm" onClick={() => setEditUser(null)}><X size={14} /></button>
            </div>
            <form onSubmit={handleEdit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div className="form-group">
                  <label className="label">Full Name</label>
                  <input className="input" value={editForm.name}
                    onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))} required />
                </div>
                <div className="form-group">
                  <label className="label">Role</label>
                  <select className="input" value={editForm.role} onChange={e => setEditForm(f => ({ ...f, role: e.target.value }))}>
                    <option value="admin">Administrator</option>
                    <option value="client">Client</option>
                    <option value="viewer">Viewer</option>
                  </select>
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div className="form-group">
                  <label className="label">New Password <span style={{ color: '#475569' }}>(leave blank to keep)</span></label>
                  <input className="input" type="password" placeholder="Min 8 characters" value={editForm.password}
                    onChange={e => setEditForm(f => ({ ...f, password: e.target.value }))} minLength={8} />
                </div>
                <div className="form-group">
                  <label className="label">Status</label>
                  <select className="input" value={editForm.is_active ? 'active' : 'inactive'}
                    onChange={e => setEditForm(f => ({ ...f, is_active: e.target.value === 'active' }))}>
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                  </select>
                </div>
              </div>

              {/* Feed & Channel assignment — only for non-admin */}
              {editForm.role !== 'admin' && (
                <>
                  <div style={{ borderTop: '1px solid rgba(255,255,255,0.07)', paddingTop: 16 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#94a3b8', marginBottom: 10 }}>Assigned Feeds</div>
                    {feeds.length === 0 ? (
                      <p style={{ fontSize: 12, color: '#475569' }}>No feeds available</p>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 160, overflowY: 'auto' }}>
                        {feeds.map(f => (
                          <label key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', background: assignedFeeds.includes(f.id) ? 'rgba(79,110,247,0.12)' : 'rgba(255,255,255,0.03)', borderRadius: 8, border: `1px solid ${assignedFeeds.includes(f.id) ? 'rgba(79,110,247,0.35)' : 'rgba(255,255,255,0.05)'}`, cursor: 'pointer' }}>
                            <input type="checkbox" checked={assignedFeeds.includes(f.id)} onChange={() => toggleFeed(f.id)} style={{ accentColor: '#4f6ef7' }} />
                            <div>
                              <div style={{ fontSize: 13, color: '#e2e8f0', fontWeight: 500 }}>{f.name}</div>
                              <div style={{ fontSize: 11, color: '#64748b' }}>{f.type}</div>
                            </div>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#94a3b8', marginBottom: 10 }}>Assigned Channels</div>
                    {channels.length === 0 ? (
                      <p style={{ fontSize: 12, color: '#475569' }}>No channels available</p>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 160, overflowY: 'auto' }}>
                        {channels.map(c => (
                          <label key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', background: assignedChannels.includes(c.id) ? 'rgba(79,110,247,0.12)' : 'rgba(255,255,255,0.03)', borderRadius: 8, border: `1px solid ${assignedChannels.includes(c.id) ? 'rgba(79,110,247,0.35)' : 'rgba(255,255,255,0.05)'}`, cursor: 'pointer' }}>
                            <input type="checkbox" checked={assignedChannels.includes(c.id)} onChange={() => toggleChannel(c.id)} style={{ accentColor: '#4f6ef7' }} />
                            <div>
                              <div style={{ fontSize: 13, color: '#e2e8f0', fontWeight: 500 }}>{c.name}</div>
                              <div style={{ fontSize: 11, color: '#64748b' }}>{c.type}</div>
                            </div>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}

              {editError && <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#f87171' }}>{editError}</div>}
              <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
                <button type="button" className="btn btn-secondary" style={{ flex: 1 }} onClick={() => setEditUser(null)}>Cancel</button>
                <button type="submit" className="btn btn-primary" style={{ flex: 1 }} disabled={editSaving}>{editSaving ? 'Saving...' : 'Save Changes'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}