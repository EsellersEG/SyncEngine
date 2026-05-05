import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../hooks/useAuth';
import { Plus, UserCheck, Shield, Eye } from 'lucide-react';

interface User {
  id: string; name: string; email: string; role: string;
  is_active: boolean; created_at: string;
}

function RoleBadge({ role }: { role: string }) {
  const map: Record<string, { badge: string; icon: React.ElementType }> = {
    admin: { badge: 'badge-info', icon: Shield },
    client: { badge: 'badge-success', icon: UserCheck },
    viewer: { badge: 'badge-muted', icon: Eye },
  };
  const { badge, icon: Icon } = map[role] || map.viewer;
  return (
    <span className={`badge ${badge}`}>
      <Icon size={10} /> {role}
    </span>
  );
}

export default function UsersPage() {
  const { isAdmin } = useAuth();
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'client' });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get('/users').then((u: User[]) => setUsers(u)).finally(() => setLoading(false));
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const newUser = await api.post('/users', form) as User;
      setUsers(prev => [newUser, ...prev]);
      setShowModal(false);
      setForm({ name: '', email: '', password: '', role: 'client' });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create user');
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(userId: string, currentState: boolean) {
    try {
      const updated = await api.patch(`/users/${userId}`, { is_active: !currentState }) as User;
      setUsers(prev => prev.map(u => u.id === userId ? { ...u, is_active: updated.is_active } : u));
    } catch (err) {
      console.error(err);
    }
  }

  if (!isAdmin) {
    return (
      <div className="page-body" style={{ textAlign: 'center', paddingTop: 80 }}>
        <Shield size={40} color="#334155" style={{ margin: '0 auto 16px' }} />
        <p style={{ color: '#475569', fontSize: 16 }}>Admin access required</p>
      </div>
    );
  }

  return (
    <div className="animate-fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Users & Access</h1>
          <p className="page-subtitle">Manage user accounts and their permissions</p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowModal(true)}>
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
                        <div style={{
                          width: 32, height: 32, borderRadius: '50%',
                          background: 'linear-gradient(135deg, #4f6ef7, #7c3aed)',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: 12, fontWeight: 700, color: 'white', flexShrink: 0
                        }}>
                          {user.name[0]?.toUpperCase()}
                        </div>
                        <span style={{ fontWeight: 600, color: '#e2e8f0' }}>{user.name}</span>
                      </div>
                    </td>
                    <td style={{ color: '#94a3b8', fontSize: 13 }}>{user.email}</td>
                    <td><RoleBadge role={user.role} /></td>
                    <td>
                      <span className={`badge ${user.is_active ? 'badge-success' : 'badge-muted'}`}>
                        {user.is_active ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td style={{ fontSize: 13, color: '#64748b' }}>
                      {new Date(user.created_at).toLocaleDateString()}
                    </td>
                    <td>
                      <button
                        className={`btn btn-sm ${user.is_active ? 'btn-secondary' : 'btn-primary'}`}
                        onClick={() => toggleActive(user.id, user.is_active)}
                      >
                        {user.is_active ? 'Deactivate' : 'Activate'}
                      </button>
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
            <h2 style={{ fontSize: 18, fontWeight: 700, color: '#e2e8f0', marginBottom: 6 }}>Create User</h2>
            <p style={{ fontSize: 13, color: '#64748b', marginBottom: 24 }}>Add a new user account</p>
            <form onSubmit={handleCreate} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div className="form-group">
                <label className="label">Full Name</label>
                <input className="input" placeholder="Jane Smith" value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required />
              </div>
              <div className="form-group">
                <label className="label">Email</label>
                <input className="input" type="email" placeholder="jane@company.com" value={form.email}
                  onChange={e => setForm(f => ({ ...f, email: e.target.value }))} required />
              </div>
              <div className="form-group">
                <label className="label">Password</label>
                <input className="input" type="password" placeholder="Min 8 characters" value={form.password}
                  onChange={e => setForm(f => ({ ...f, password: e.target.value }))} required minLength={8} />
              </div>
              <div className="form-group">
                <label className="label">Role</label>
                <select className="input" value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))}>
                  <option value="admin">Admin — Full access</option>
                  <option value="client">Client — Manage own data</option>
                  <option value="viewer">Viewer — Read only</option>
                </select>
              </div>
              {error && <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#f87171' }}>{error}</div>}
              <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
                <button type="button" className="btn btn-secondary" style={{ flex: 1 }} onClick={() => setShowModal(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary" style={{ flex: 1 }} disabled={saving}>
                  {saving ? 'Creating...' : 'Create User'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
