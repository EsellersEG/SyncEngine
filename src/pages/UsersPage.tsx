import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import Modal from '../components/Modal';
import { useAuth } from '../hooks/useAuth';
import { Plus, UserCheck, Shield, Eye, Pencil, X, Briefcase } from 'lucide-react';
interface User {
  id: string; name: string; email: string; role: string;
  is_active: boolean; created_at: string;
  client_count?: number;
  permissions?: string[];
}
interface Client { id: string; name: string; slug: string; is_active: boolean; }

const ALL_PERMISSIONS = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'clients', label: 'Clients' },
  { key: 'feeds', label: 'Feeds' },
  { key: 'channels', label: 'Channels' },
  { key: 'products', label: 'Products' },
  { key: 'mapping', label: 'Attribute Mapping' },
  { key: 'automations', label: 'Automations' },
  { key: 'sync', label: 'Sync Jobs' },
  { key: 'orders', label: 'Orders' },
  { key: 'analytics', label: 'Analytics' },
  { key: 'tasks', label: 'Tasks' },
  { key: 'invoices', label: 'Invoices' },
  { key: 'tools', label: 'Tools' },
];

function RoleBadge({ role }: { role: string }) {
  const map: Record<string, { badge: string; icon: React.ElementType }> = {
    admin: { badge: 'badge-info', icon: Shield },
    employee: { badge: 'badge-warning', icon: Briefcase },
    client: { badge: 'badge-success', icon: UserCheck },
    viewer: { badge: 'badge-muted', icon: Eye },
  };
  const { badge, icon: Icon } = map[role] || map.viewer;
  return <span className={`badge ${badge}`}><Icon size={10} /> {role}</span>;
}

const emptyCreate = { name: '', email: '', password: '', role: 'client', permissions: [] as string[] };
const emptyEdit = { name: '', role: 'client', is_active: true, password: '', permissions: [] as string[] };

export default function UsersPage() {
  const { isAdmin } = useAuth();
  const [users, setUsers] = useState<User[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);

  // Create modal
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState(emptyCreate);
  const [createError, setCreateError] = useState('');
  const [creating, setSaving] = useState(false);

  // Edit modal
  const [editUser, setEditUser] = useState<User | null>(null);
  const [editForm, setEditForm] = useState(emptyEdit);
  const [assignedClients, setAssignedClients] = useState<string[]>([]);
  const [editError, setEditError] = useState('');
  const [editSaving, setEditSaving] = useState(false);

  useEffect(() => {
    api.get('/users').then((u) => setUsers(u as User[])).catch(console.error).finally(() => setLoading(false));
    api.get('/clients').then((c) => setClients(c as Client[])).catch(() => setClients([]));
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
    setEditForm({ name: user.name, role: user.role, is_active: user.is_active, password: '', permissions: user.permissions || [] });
    setEditError('');
    try {
      const a = await api.get(`/users/${user.id}/assignments`) as { client_ids: string[] };
      setAssignedClients(a.client_ids);
    } catch { setAssignedClients([]); }
  }

  async function handleEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editUser) return;
    setEditSaving(true); setEditError('');
    try {
      const payload: Record<string, unknown> = { name: editForm.name, role: editForm.role, is_active: editForm.is_active, permissions: editForm.permissions };
      if (editForm.password.length >= 8) payload.password = editForm.password;
      const updated = await api.patch(`/users/${editUser.id}`, payload) as User;
      // Save client assignments only for non-admin users
      if (editForm.role !== 'admin') {
        await api.put(`/users/${editUser.id}/assignments`, { client_ids: assignedClients });
      }
      setUsers(prev => prev.map(u => u.id === editUser.id ? { ...u, ...updated, permissions: editForm.permissions, client_count: editForm.role === 'admin' ? undefined : assignedClients.length } : u));
      setEditUser(null);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'Failed to save');
    } finally { setEditSaving(false); }
  }

  function toggleClient(id: string) {
    setAssignedClients(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  }

  function togglePermission(key: string, form: 'create' | 'edit') {
    if (form === 'create') {
      setCreateForm(f => ({ ...f, permissions: f.permissions.includes(key) ? f.permissions.filter(p => p !== key) : [...f.permissions, key] }));
    } else {
      setEditForm(f => ({ ...f, permissions: f.permissions.includes(key) ? f.permissions.filter(p => p !== key) : [...f.permissions, key] }));
    }
  }

  function selectAllPermissions(form: 'create' | 'edit') {
    const allKeys = ALL_PERMISSIONS.map(p => p.key);
    if (form === 'create') setCreateForm(f => ({ ...f, permissions: allKeys }));
    else setEditForm(f => ({ ...f, permissions: allKeys }));
  }

  function clearAllPermissions(form: 'create' | 'edit') {
    if (form === 'create') setCreateForm(f => ({ ...f, permissions: [] }));
    else setEditForm(f => ({ ...f, permissions: [] }));
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
                        ? <span style={{ color: '#ffa500' }}>Full access</span>
                        : <span>{(user.permissions || []).length}/{ALL_PERMISSIONS.length} pages</span>}
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
      <Modal open={showCreate} onClose={() => setShowCreate(false)}>
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
                  <option value="employee">Employee — Manage assigned clients</option>
                  <option value="client">Client — View own invoices only</option>
                  <option value="viewer">Viewer — Read-only on assigned items</option>
                </select>
              </div>
              {/* Permissions — only for non-admin */}
              {createForm.role !== 'admin' && (
                <div className="form-group">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                    <label className="label" style={{ margin: 0 }}>Page Permissions</label>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button type="button" style={{ fontSize: 11, color: '#ffa500', background: 'none', border: 'none', cursor: 'pointer' }} onClick={() => selectAllPermissions('create')}>Select All</button>
                      <button type="button" style={{ fontSize: 11, color: '#64748b', background: 'none', border: 'none', cursor: 'pointer' }} onClick={() => clearAllPermissions('create')}>Clear</button>
                    </div>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                    {ALL_PERMISSIONS.map(p => (
                      <label key={p.key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', background: createForm.permissions.includes(p.key) ? 'rgba(255,165,0,0.1)' : 'rgba(255,255,255,0.02)', borderRadius: 8, border: `1px solid ${createForm.permissions.includes(p.key) ? 'rgba(255,165,0,0.3)' : 'rgba(255,255,255,0.05)'}`, cursor: 'pointer', fontSize: 13 }}>
                        <input type="checkbox" checked={createForm.permissions.includes(p.key)} onChange={() => togglePermission(p.key, 'create')} style={{ accentColor: '#ffa500' }} />
                        <span style={{ color: '#e2e8f0' }}>{p.label}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
              {createError && <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#f87171' }}>{createError}</div>}
              <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
                <button type="button" className="btn btn-secondary" style={{ flex: 1 }} onClick={() => setShowCreate(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary" style={{ flex: 1 }} disabled={creating}>{creating ? 'Creating...' : 'Create User'}</button>
              </div>
            </form>
      </Modal>

      {/* ── Edit Modal ── */}
      {editUser && (
        <Modal open={true} onClose={() => setEditUser(null)} maxWidth={560}>
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
                    <option value="employee">Employee</option>
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

              {/* Client assignment — only for non-admin */}
              {editForm.role !== 'admin' && (
                <div style={{ borderTop: '1px solid rgba(255,255,255,0.07)', paddingTop: 16 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#94a3b8', marginBottom: 10 }}>Assigned Clients</div>
                  <p style={{ fontSize: 12, color: '#64748b', marginBottom: 10 }}>User will have access to all feeds, channels, orders, and products under the selected clients.</p>
                  {clients.length === 0 ? (
                    <p style={{ fontSize: 12, color: '#475569' }}>No clients available</p>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 220, overflowY: 'auto' }}>
                      {clients.map(c => (
                        <label key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', background: assignedClients.includes(c.id) ? 'rgba(255,165,0,0.12)' : 'rgba(255,255,255,0.03)', borderRadius: 8, border: `1px solid ${assignedClients.includes(c.id) ? 'rgba(255,165,0,0.35)' : 'rgba(255,255,255,0.05)'}`, cursor: 'pointer' }}>
                          <input type="checkbox" checked={assignedClients.includes(c.id)} onChange={() => toggleClient(c.id)} style={{ accentColor: '#ffa500' }} />
                          <div>
                            <div style={{ fontSize: 13, color: '#e2e8f0', fontWeight: 500 }}>{c.name}</div>
                            <div style={{ fontSize: 11, color: '#64748b' }}>/{c.slug}</div>
                          </div>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Page Permissions — only for non-admin */}
              {editForm.role !== 'admin' && (
                <div style={{ borderTop: '1px solid rgba(255,255,255,0.07)', paddingTop: 16 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#94a3b8' }}>Page Permissions</div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button type="button" style={{ fontSize: 11, color: '#ffa500', background: 'none', border: 'none', cursor: 'pointer' }} onClick={() => selectAllPermissions('edit')}>Select All</button>
                      <button type="button" style={{ fontSize: 11, color: '#64748b', background: 'none', border: 'none', cursor: 'pointer' }} onClick={() => clearAllPermissions('edit')}>Clear</button>
                    </div>
                  </div>
                  <p style={{ fontSize: 12, color: '#64748b', marginBottom: 10 }}>Choose which pages this user can see in the navigation.</p>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                    {ALL_PERMISSIONS.map(p => (
                      <label key={p.key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', background: editForm.permissions.includes(p.key) ? 'rgba(255,165,0,0.1)' : 'rgba(255,255,255,0.02)', borderRadius: 8, border: `1px solid ${editForm.permissions.includes(p.key) ? 'rgba(255,165,0,0.3)' : 'rgba(255,255,255,0.05)'}`, cursor: 'pointer', fontSize: 13 }}>
                        <input type="checkbox" checked={editForm.permissions.includes(p.key)} onChange={() => togglePermission(p.key, 'edit')} style={{ accentColor: '#ffa500' }} />
                        <span style={{ color: '#e2e8f0' }}>{p.label}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {editError && <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#f87171' }}>{editError}</div>}
              <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
                <button type="button" className="btn btn-secondary" style={{ flex: 1 }} onClick={() => setEditUser(null)}>Cancel</button>
                <button type="submit" className="btn btn-primary" style={{ flex: 1 }} disabled={editSaving}>{editSaving ? 'Saving...' : 'Save Changes'}</button>
              </div>
            </form>
        </Modal>
      )}
    </div>
  );
}