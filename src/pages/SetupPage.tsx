import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, setToken, setUser } from '../lib/api';
import { Activity, Shield } from 'lucide-react';

export default function SetupPage() {
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    // Only allow setup if no admin exists yet
    api.get('/auth/setup-check').then((res: { allowed: boolean }) => {
      if (!res.allowed) navigate('/login', { replace: true });
      else setAllowed(true);
    }).catch(() => navigate('/login', { replace: true }));
  }, [navigate]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const data = await api.post('/auth/setup', form) as { token: string; user: unknown };
      setToken(data.token);
      setUser(data.user);
      navigate('/');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Setup failed');
    } finally {
      setLoading(false);
    }
  }

  if (!allowed) return null;

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: '#080c18', padding: 24,
      backgroundImage: 'radial-gradient(ellipse at 30% 30%, rgba(79,110,247,0.1) 0%, transparent 60%)',
    }}>
      <div style={{ width: '100%', maxWidth: 440 }} className="animate-fade-in">
        <div style={{ textAlign: 'center', marginBottom: 36 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, marginBottom: 16 }}>
            <div style={{
              width: 52, height: 52, borderRadius: 14,
              background: 'linear-gradient(135deg, #4f6ef7, #7c3aed)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 8px 24px rgba(79,110,247,0.4)'
            }}>
              <Activity size={24} color="white" />
            </div>
          </div>
          <h1 className="gradient-text" style={{ fontSize: 26, fontWeight: 800, marginBottom: 8 }}>
            Sync-Engine Setup
          </h1>
          <p style={{ fontSize: 14, color: '#64748b' }}>Create your admin account to get started</p>
        </div>

        <div className="glass-card" style={{ padding: 32 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 24, padding: '12px 16px', background: 'rgba(79,110,247,0.08)', borderRadius: 10, border: '1px solid rgba(79,110,247,0.2)' }}>
            <Shield size={16} color="#6b87ff" />
            <span style={{ fontSize: 13, color: '#94a3b8' }}>This creates the master admin account. Run once only.</span>
          </div>

          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div className="form-group">
              <label className="label">Full Name</label>
              <input className="input" placeholder="Your Name" value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required />
            </div>
            <div className="form-group">
              <label className="label">Email Address</label>
              <input className="input" type="email" placeholder="admin@company.com" value={form.email}
                onChange={e => setForm(f => ({ ...f, email: e.target.value }))} required />
            </div>
            <div className="form-group">
              <label className="label">Password</label>
              <input className="input" type="password" placeholder="Strong password" value={form.password}
                onChange={e => setForm(f => ({ ...f, password: e.target.value }))} required minLength={8} />
            </div>

            {error && (
              <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#f87171' }}>
                {error}
              </div>
            )}

            <button type="submit" className="btn btn-primary btn-lg" disabled={loading} style={{ marginTop: 4 }}>
              {loading ? 'Creating Admin...' : 'Create Admin Account'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
