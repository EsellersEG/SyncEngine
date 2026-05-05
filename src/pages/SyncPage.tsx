import { useEffect, useState, useRef } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../hooks/useAuth';
import { Zap, Play, XCircle, RefreshCw, CheckCircle, AlertTriangle, Clock, ChevronDown, ChevronUp } from 'lucide-react';

interface Channel { id: string; name: string; type: string; client_id: string; }
interface Feed { id: string; name: string; client_id: string; }
interface SyncJob {
  id: string; channel_id: string; channel_name: string; feed_id: string;
  preset: string; status: string; total_products: number;
  created_count: number; updated_count: number; failed_count: number; skipped_count: number;
  started_at: string | null; completed_at: string | null; created_at: string;
  triggered_by_name: string; error_message: string | null;
}
interface SyncLog {
  id: string; sku: string; action: string; message: string; created_at: string;
}

const PRESETS = [
  { value: 'price_stock_meta', label: '⚡ Price + Stock + Meta', desc: 'Turbo Mode — ~5-10 min for 10K products' },
  { value: 'sync_all_no_images', label: '🔄 Sync All (No Images)', desc: 'Bulk Ops + Turbo — ~10-15 min' },
  { value: 'sync_all', label: '🚀 Sync All', desc: 'Full catalog sync — ~20-30 min' },
];

function StatusIcon({ status }: { status: string }) {
  if (status === 'completed') return <CheckCircle size={14} color="#4ade80" />;
  if (status === 'failed') return <AlertTriangle size={14} color="#f87171" />;
  if (status === 'running') return <RefreshCw size={14} color="#60a5fa" className="spinner" />;
  if (status === 'cancelled') return <XCircle size={14} color="#94a3b8" />;
  return <Clock size={14} color="#fbbf24" />;
}

function ProgressBar({ job }: { job: SyncJob }) {
  if (!job.total_products) return null;
  const done = job.created_count + job.updated_count + job.failed_count;
  const pct = Math.min(100, Math.round((done / job.total_products) * 100));
  return (
    <div style={{ marginTop: 8 }}>
      <div className="progress-bar">
        <div className="progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <div style={{ display: 'flex', gap: 12, marginTop: 4, fontSize: 11 }}>
        <span style={{ color: '#4ade80' }}>+{job.created_count} new</span>
        <span style={{ color: '#60a5fa' }}>↻{job.updated_count} updated</span>
        <span style={{ color: '#f87171' }}>✗{job.failed_count} failed</span>
        <span style={{ color: '#64748b', marginLeft: 'auto' }}>{pct}%</span>
      </div>
    </div>
  );
}

export default function SyncPage() {
  const { user } = useAuth();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [jobs, setJobs] = useState<SyncJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [expandedJob, setExpandedJob] = useState<string | null>(null);
  const [jobLogs, setJobLogs] = useState<Record<string, SyncLog[]>>({});
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [config, setConfig] = useState({
    channel_id: '', feed_id: '', preset: 'sync_all',
  });

  useEffect(() => {
    Promise.all([api.get('/channels'), api.get('/feeds'), api.get('/sync/jobs?limit=20')])
      .then(([ch, f, j]) => { setChannels(ch as Channel[]); setFeeds(f as Feed[]); setJobs(j as SyncJob[]); })
      .finally(() => setLoading(false));

    // Poll for running jobs
    pollRef.current = setInterval(() => {
      api.get('/sync/jobs?limit=20').then((j: SyncJob[]) => setJobs(j)).catch(() => {});
    }, 5000);

    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  async function handleStart(e: React.FormEvent) {
    e.preventDefault();
    setStarting(true);
    try {
      await api.post('/sync/start', config);
      const updated = await api.get('/sync/jobs?limit=20') as SyncJob[];
      setJobs(updated);
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Failed to start sync');
    } finally {
      setStarting(false);
    }
  }

  async function handleCancel(jobId: string) {
    await api.post(`/sync/jobs/${jobId}/cancel`, {});
    setJobs(prev => prev.map(j => j.id === jobId ? { ...j, status: 'cancelled' } : j));
  }

  async function toggleLogs(jobId: string) {
    if (expandedJob === jobId) {
      setExpandedJob(null);
      return;
    }
    setExpandedJob(jobId);
    if (!jobLogs[jobId]) {
      const logs = await api.get(`/sync/jobs/${jobId}/logs`) as SyncLog[];
      setJobLogs(prev => ({ ...prev, [jobId]: logs }));
    }
  }

  const shopifyChannels = channels.filter(ch => ch.type === 'shopify');

  return (
    <div className="animate-fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Sync Jobs</h1>
          <p className="page-subtitle">Manage and monitor synchronization between feeds and channels</p>
        </div>
      </div>

      <div className="page-body" style={{ display: 'grid', gridTemplateColumns: '360px 1fr', gap: 24, alignItems: 'flex-start' }}>
        {/* Start Sync Panel */}
        <div className="glass-card" style={{ padding: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 24 }}>
            <div style={{ width: 36, height: 36, borderRadius: 10, background: 'linear-gradient(135deg, #4f6ef7, #7c3aed)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Zap size={16} color="white" />
            </div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, color: '#e2e8f0' }}>Start New Sync</div>
              <div style={{ fontSize: 12, color: '#64748b' }}>Configure and launch a sync job</div>
            </div>
          </div>

          <form onSubmit={handleStart} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div className="form-group">
              <label className="label">Channel (Shopify Store)</label>
              <select className="input" value={config.channel_id} onChange={e => setConfig(c => ({ ...c, channel_id: e.target.value }))} required>
                <option value="">Select channel...</option>
                {shopifyChannels.map(ch => <option key={ch.id} value={ch.id}>{ch.name}</option>)}
              </select>
              {shopifyChannels.length === 0 && (
                <span style={{ fontSize: 11, color: '#f87171', marginTop: 4 }}>No Shopify channels found. Add one first.</span>
              )}
            </div>
            <div className="form-group">
              <label className="label">Feed</label>
              <select className="input" value={config.feed_id} onChange={e => setConfig(c => ({ ...c, feed_id: e.target.value }))} required>
                <option value="">Select feed...</option>
                {feeds.filter(f => !config.channel_id || channels.find(ch => ch.id === config.channel_id)?.client_id === f.client_id).map(f => (
                  <option key={f.id} value={f.id}>{f.name}</option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label className="label">Sync Preset</label>
              {PRESETS.map(p => (
                <label key={p.value} style={{
                  display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px', borderRadius: 10,
                  border: `1px solid ${config.preset === p.value ? 'rgba(79,110,247,0.4)' : 'rgba(79,110,247,0.1)'}`,
                  background: config.preset === p.value ? 'rgba(79,110,247,0.08)' : 'transparent',
                  cursor: 'pointer', marginBottom: 8, transition: 'all 0.2s',
                }}>
                  <input type="radio" name="preset" value={p.value}
                    checked={config.preset === p.value}
                    onChange={e => setConfig(c => ({ ...c, preset: e.target.value }))}
                    style={{ marginTop: 3, accentColor: '#4f6ef7' }}
                  />
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0' }}>{p.label}</div>
                    <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>{p.desc}</div>
                  </div>
                </label>
              ))}
            </div>

            <button type="submit" className="btn btn-primary" disabled={starting || !config.channel_id || !config.feed_id} style={{ marginTop: 4 }}>
              {starting ? (
                <span className="spinner" style={{ width: 14, height: 14, border: '2px solid rgba(255,255,255,0.3)', borderTopColor: 'white', borderRadius: '50%', display: 'inline-block' }} />
              ) : <Play size={14} />}
              {starting ? 'Starting...' : 'Start Sync'}
            </button>
          </form>
        </div>

        {/* Jobs History */}
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#e2e8f0', marginBottom: 16 }}>Sync History</div>
          {loading ? (
            <div style={{ textAlign: 'center', paddingTop: 40 }}>
              <div className="spinner" style={{ width: 28, height: 28, border: '3px solid rgba(79,110,247,0.2)', borderTopColor: '#4f6ef7', borderRadius: '50%', margin: '0 auto' }} />
            </div>
          ) : jobs.length === 0 ? (
            <div className="glass-card" style={{ padding: 48, textAlign: 'center' }}>
              <Zap size={32} color="#334155" style={{ margin: '0 auto 12px' }} />
              <p style={{ color: '#475569', fontSize: 14 }}>No sync jobs yet — start your first sync!</p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {jobs.map(job => (
                <div key={job.id} className="glass-card" style={{ padding: 0, overflow: 'hidden' }}>
                  <div style={{ padding: '16px 20px' }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <StatusIcon status={job.status} />
                        <div>
                          <div style={{ fontSize: 14, fontWeight: 600, color: '#e2e8f0' }}>{job.channel_name}</div>
                          <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>
                            <span style={{ fontFamily: 'var(--font-mono)' }}>{job.preset}</span>
                            {' · '}{new Date(job.created_at).toLocaleString()}
                            {job.triggered_by_name && ` · by ${job.triggered_by_name}`}
                          </div>
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span className={`badge ${
                          job.status === 'completed' ? 'badge-success' :
                          job.status === 'failed' ? 'badge-danger' :
                          job.status === 'running' ? 'badge-info' :
                          job.status === 'pending' ? 'badge-warning' : 'badge-muted'
                        }`}>{job.status}</span>
                        {(job.status === 'running' || job.status === 'pending') && (
                          <button className="btn btn-danger btn-sm" onClick={() => handleCancel(job.id)}>
                            <XCircle size={12} /> Cancel
                          </button>
                        )}
                        <button
                          className="btn btn-secondary btn-sm btn-icon"
                          onClick={() => toggleLogs(job.id)}
                          title={expandedJob === job.id ? 'Hide logs' : 'Show logs'}
                        >
                          {expandedJob === job.id ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                        </button>
                      </div>
                    </div>
                    <ProgressBar job={job} />
                    {job.error_message && (
                      <div style={{ marginTop: 8, padding: '8px 12px', background: 'rgba(239,68,68,0.1)', borderRadius: 6, fontSize: 12, color: '#f87171' }}>
                        {job.error_message}
                      </div>
                    )}
                  </div>

                  {/* Logs panel */}
                  {expandedJob === job.id && (
                    <div style={{ borderTop: '1px solid rgba(79,110,247,0.1)', padding: '12px 20px', background: 'rgba(8,12,24,0.5)', maxHeight: 300, overflowY: 'auto' }}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
                        Sync Logs ({jobLogs[job.id]?.length || 0} entries)
                      </div>
                      {(jobLogs[job.id] || []).length === 0 ? (
                        <div style={{ fontSize: 13, color: '#475569' }}>No logs available yet.</div>
                      ) : (
                        (jobLogs[job.id] || []).map(log => (
                          <div key={log.id} style={{ display: 'flex', gap: 8, fontSize: 12, padding: '3px 0', borderBottom: '1px solid rgba(79,110,247,0.05)' }}>
                            <span style={{
                              color: log.action === 'created' ? '#4ade80' : log.action === 'updated' ? '#60a5fa' : log.action === 'failed' ? '#f87171' : '#94a3b8',
                              fontWeight: 600, minWidth: 60
                            }}>{log.action}</span>
                            <span style={{ color: '#94a3b8', fontFamily: 'var(--font-mono)', minWidth: 100 }}>{log.sku}</span>
                            <span style={{ color: '#64748b' }}>{log.message}</span>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
