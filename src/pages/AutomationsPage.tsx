import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Plus, Trash2, Activity, Play, Pause } from 'lucide-react';

interface Automation {
  id: string;
  client_id: string;
  client_name?: string;
  name: string;
  trigger_type: 'schedule' | 'after_import';
  action_type: 'import_feed' | 'sync_to_shopify';
  feed_id?: string;
  feed_name?: string;
  channel_id?: string;
  channel_name?: string;
  interval_minutes?: number;
  is_active: boolean;
  last_run_at?: string;
  created_at: string;
}
interface Feed { id: string; name: string; client_id: string; }
interface Channel { id: string; name: string; client_id: string; }
interface Client { id: string; name: string; }

export default function AutomationsPage() {
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({
    client_id: '', name: '', trigger_type: 'schedule' as string,
    action_type: 'import_feed' as string, feed_id: '', channel_id: '',
    interval_minutes: '60',
  });
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([
      api.get('/automations'),
      api.get('/feeds'),
      api.get('/channels'),
      api.get('/clients'),
    ]).then(([a, f, ch, cl]) => {
      setAutomations(a as Automation[]);
      setFeeds(f as Feed[]);
      setChannels(ch as Channel[]);
      setClients(cl as Client[]);
    }).finally(() => setLoading(false));
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      const payload = {
        client_id: form.client_id,
        name: form.name,
        trigger_type: form.trigger_type,
        action_type: form.action_type,
        feed_id: form.feed_id || null,
        channel_id: form.channel_id || null,
        interval_minutes: form.trigger_type === 'schedule' ? parseInt(form.interval_minutes) : null,
      };
      const created = await api.post('/automations', payload) as Automation;
      setAutomations(prev => [created, ...prev]);
      setShowModal(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed');
    }
  }

  async function handleToggle(id: string, active: boolean) {
    const updated = await api.patch(`/automations/${id}`, { is_active: !active }) as Automation;
    setAutomations(prev => prev.map(a => a.id === id ? { ...a, ...updated } : a));
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this automation?')) return;
    await api.delete(`/automations/${id}`);
    setAutomations(prev => prev.filter(a => a.id !== id));
  }

  const filteredFeeds = feeds.filter(f => !form.client_id || f.client_id === form.client_id);
  const filteredChannels = channels.filter(c => !form.client_id || c.client_id === form.client_id);

  function getIntervalLabel(minutes?: number) {
    if (!minutes) return '';
    if (minutes < 60) return `Every ${minutes}m`;
    if (minutes === 60) return 'Every 1h';
    return `Every ${minutes / 60}h`;
  }

  function getTriggerLabel(a: Automation) {
    if (a.trigger_type === 'schedule') return getIntervalLabel(a.interval_minutes);
    return 'After Import';
  }

  function getActionLabel(a: Automation) {
    if (a.action_type === 'import_feed') return `Import → ${a.feed_name || 'feed'}`;
    return `Sync → ${a.channel_name || 'Shopify'}`;
  }

  return (
    <>
    <div className="animate-fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Automations</h1>
          <p className="page-subtitle">Configure automatic imports and sync schedules</p>
        </div>
        <button className="btn btn-primary" onClick={() => {
          setForm({ client_id: '', name: '', trigger_type: 'schedule', action_type: 'import_feed', feed_id: '', channel_id: '', interval_minutes: '60' });
          setError('');
          setShowModal(true);
        }}>
          <Plus size={15} /> Add Automation
        </button>
      </div>

      <div className="page-body">
        {loading ? (
          <div style={{ textAlign: 'center', paddingTop: 60 }}>
            <div className="spinner" style={{ width: 28, height: 28, border: '3px solid rgba(79,110,247,0.2)', borderTopColor: '#4f6ef7', borderRadius: '50%', margin: '0 auto' }} />
          </div>
        ) : automations.length === 0 ? (
          <div className="glass-card" style={{ padding: 64, textAlign: 'center' }}>
            <Activity size={40} color="#334155" style={{ margin: '0 auto 16px' }} />
            <p style={{ color: '#475569', fontSize: 16, fontWeight: 600, marginBottom: 8 }}>No automations configured</p>
            <p style={{ color: '#334155', fontSize: 14, marginBottom: 24 }}>Create rules to automatically import products and sync to Shopify</p>
            <button className="btn btn-primary" onClick={() => { setForm({ client_id: '', name: '', trigger_type: 'schedule', action_type: 'import_feed', feed_id: '', channel_id: '', interval_minutes: '60' }); setError(''); setShowModal(true); }}>
              <Plus size={15} /> Add First Automation
            </button>
          </div>
        ) : (
          <div className="table-container">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Client</th>
                  <th>Trigger</th>
                  <th>Action</th>
                  <th>Last Run</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {automations.map(a => (
                  <tr key={a.id}>
                    <td style={{ fontWeight: 600, color: '#e2e8f0' }}>{a.name}</td>
                    <td style={{ fontSize: 13, color: '#94a3b8' }}>{a.client_name || '—'}</td>
                    <td>
                      <span className={`badge ${a.trigger_type === 'schedule' ? 'badge-info' : 'badge-warning'}`}>
                        {getTriggerLabel(a)}
                      </span>
                    </td>
                    <td style={{ fontSize: 13, color: '#cbd5e1' }}>{getActionLabel(a)}</td>
                    <td style={{ fontSize: 13, color: '#64748b' }}>
                      {a.last_run_at ? new Date(a.last_run_at).toLocaleString() : 'Never'}
                    </td>
                    <td>
                      <span className={`badge ${a.is_active ? 'badge-success' : 'badge-secondary'}`}>
                        {a.is_active ? 'Active' : 'Paused'}
                      </span>
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button className="btn btn-secondary btn-sm btn-icon" onClick={() => handleToggle(a.id, a.is_active)} title={a.is_active ? 'Pause' : 'Enable'}>
                          {a.is_active ? <Pause size={12} /> : <Play size={12} />}
                        </button>
                        <button className="btn btn-danger btn-sm btn-icon" onClick={() => handleDelete(a.id)} title="Delete">
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
    </div>

    {showModal && (
      <div className="modal-overlay" onClick={() => setShowModal(false)}>
        <div className="modal" onClick={e => e.stopPropagation()}>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: '#e2e8f0', marginBottom: 16 }}>New Automation</h2>
          {error && <div className="alert alert-danger" style={{ marginBottom: 12 }}>{error}</div>}
          <form onSubmit={handleCreate}>
            <div className="form-group">
              <label className="label">Client</label>
              <select className="input" value={form.client_id} onChange={e => setForm(f => ({ ...f, client_id: e.target.value, feed_id: '', channel_id: '' }))} required>
                <option value="">Select client...</option>
                {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="label">Name</label>
              <input className="input" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Capello hourly import" required />
            </div>
            <div className="form-group">
              <label className="label">Trigger</label>
              <select className="input" value={form.trigger_type} onChange={e => setForm(f => ({ ...f, trigger_type: e.target.value }))}>
                <option value="schedule">On Schedule (interval)</option>
                <option value="after_import">After Feed Import</option>
              </select>
            </div>
            {form.trigger_type === 'schedule' && (
              <div className="form-group">
                <label className="label">Interval</label>
                <select className="input" value={form.interval_minutes} onChange={e => setForm(f => ({ ...f, interval_minutes: e.target.value }))}>
                  <option value="15">Every 15 minutes</option>
                  <option value="30">Every 30 minutes</option>
                  <option value="60">Every 1 hour</option>
                  <option value="120">Every 2 hours</option>
                  <option value="360">Every 6 hours</option>
                  <option value="720">Every 12 hours</option>
                  <option value="1440">Every 24 hours</option>
                </select>
              </div>
            )}
            <div className="form-group">
              <label className="label">Action</label>
              <select className="input" value={form.action_type} onChange={e => setForm(f => ({ ...f, action_type: e.target.value }))}>
                <option value="import_feed">Import products from Feed</option>
                <option value="sync_to_shopify">Sync to Shopify channel</option>
              </select>
            </div>
            {form.action_type === 'import_feed' && (
              <div className="form-group">
                <label className="label">Feed</label>
                <select className="input" value={form.feed_id} onChange={e => setForm(f => ({ ...f, feed_id: e.target.value }))} required>
                  <option value="">Select feed...</option>
                  {filteredFeeds.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
              </div>
            )}
            {form.action_type === 'sync_to_shopify' && (
              <div className="form-group">
                <label className="label">Channel</label>
                <select className="input" value={form.channel_id} onChange={e => setForm(f => ({ ...f, channel_id: e.target.value }))} required>
                  <option value="">Select channel...</option>
                  {filteredChannels.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
            )}
            {form.action_type === 'sync_to_shopify' && form.trigger_type === 'after_import' && (
              <div className="form-group">
                <label className="label">After import of Feed</label>
                <select className="input" value={form.feed_id} onChange={e => setForm(f => ({ ...f, feed_id: e.target.value }))} required>
                  <option value="">Select feed...</option>
                  {filteredFeeds.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <button className="btn btn-primary" type="submit">Create</button>
              <button className="btn btn-secondary" type="button" onClick={() => setShowModal(false)}>Cancel</button>
            </div>
          </form>
        </div>
      </div>
    )}
    </>
  );
}
