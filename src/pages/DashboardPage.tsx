import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { Users, Database, GitBranch, Package, Zap, TrendingUp, AlertCircle, CheckCircle2 } from 'lucide-react';

interface Stats {
  clients: number;
  feeds: number;
  channels: number;
  products: number;
  active_syncs: number;
}

interface RecentJob {
  id: string;
  channel_name: string;
  preset: string;
  status: string;
  total_products: number;
  created_count: number;
  updated_count: number;
  failed_count: number;
  created_at: string;
  completed_at: string | null;
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    completed: 'badge-success',
    running: 'badge-info',
    failed: 'badge-danger',
    pending: 'badge-warning',
    cancelled: 'badge-muted',
  };
  return <span className={`badge ${map[status] || 'badge-muted'}`}>{status}</span>;
}

function StatCard({ icon: Icon, label, value, sub, color }: {
  icon: React.ElementType; label: string; value: number | string; sub?: string; color: string
}) {
  return (
    <div className="stat-card">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span className="stat-label">{label}</span>
        <div style={{ width: 36, height: 36, borderRadius: 10, background: `${color}18`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Icon size={16} color={color} />
        </div>
      </div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

export default function DashboardPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [recentJobs, setRecentJobs] = useState<RecentJob[]>([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    Promise.all([
      api.get('/clients').then((clients: unknown[]) => ({
        clients: clients.length,
      })),
      api.get('/feeds').then((feeds: unknown[]) => ({ feeds: feeds.length })),
      api.get('/channels').then((channels: unknown[]) => ({ channels: channels.length })),
      api.get('/products?limit=1').then((r: { total: number }) => ({ products: r.total })),
      api.get('/sync/jobs?limit=8'),
    ]).then(([c, f, ch, p, jobs]) => {
      setStats({ ...c, ...f, ...ch, ...p, active_syncs: (jobs as RecentJob[]).filter(j => j.status === 'running').length });
      setRecentJobs(jobs as RecentJob[]);
    }).catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="page-body" style={{ paddingTop: 80, textAlign: 'center' }}>
        <div className="spinner" style={{ width: 32, height: 32, border: '3px solid rgba(79,110,247,0.2)', borderTopColor: '#4f6ef7', borderRadius: '50%', margin: '0 auto 12px' }} />
        <p style={{ color: '#64748b', fontSize: 14 }}>Loading dashboard...</p>
      </div>
    );
  }

  return (
    <div className="animate-fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Dashboard</h1>
          <p className="page-subtitle">Overview of your entire sync platform</p>
        </div>
        <button className="btn btn-primary" onClick={() => navigate('/sync')}>
          <Zap size={15} /> New Sync Job
        </button>
      </div>

      <div className="page-body">
        {/* Stats */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 16, marginBottom: 32 }}>
          <StatCard icon={Users} label="Clients" value={stats?.clients ?? 0} sub="Active profiles" color="#4f6ef7" />
          <StatCard icon={Database} label="Feeds" value={stats?.feeds ?? 0} sub="Google Sheets" color="#a78bfa" />
          <StatCard icon={GitBranch} label="Channels" value={stats?.channels ?? 0} sub="Shopify & more" color="#22d3ee" />
          <StatCard icon={Package} label="Products" value={stats?.products ?? 0} sub="In catalog" color="#4ade80" />
          <StatCard icon={TrendingUp} label="Active Syncs" value={stats?.active_syncs ?? 0} sub="Running now" color="#f59e0b" />
        </div>

        {/* Recent Jobs */}
        <div className="glass-card" style={{ padding: 0 }}>
          <div style={{ padding: '20px 24px', borderBottom: '1px solid rgba(79,110,247,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <h2 style={{ fontSize: 16, fontWeight: 700, color: '#e2e8f0' }}>Recent Sync Jobs</h2>
              <p style={{ fontSize: 13, color: '#64748b', marginTop: 2 }}>Latest activity across all channels</p>
            </div>
            <button className="btn btn-secondary btn-sm" onClick={() => navigate('/sync')}>View All</button>
          </div>

          {recentJobs.length === 0 ? (
            <div style={{ padding: 48, textAlign: 'center' }}>
              <Zap size={32} color="#334155" style={{ margin: '0 auto 12px' }} />
              <p style={{ color: '#475569', fontSize: 14 }}>No sync jobs yet</p>
              <p style={{ color: '#334155', fontSize: 13, marginTop: 4 }}>Connect a feed and channel to get started</p>
              <button className="btn btn-primary btn-sm" style={{ marginTop: 16 }} onClick={() => navigate('/sync')}>
                Start First Sync
              </button>
            </div>
          ) : (
            <div className="table-container" style={{ border: 'none', borderRadius: 0 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Channel</th>
                    <th>Preset</th>
                    <th>Status</th>
                    <th>Results</th>
                    <th>Started</th>
                  </tr>
                </thead>
                <tbody>
                  {recentJobs.map(job => (
                    <tr key={job.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/sync?job=${job.id}`)}>
                      <td style={{ fontWeight: 500, color: '#e2e8f0' }}>{job.channel_name}</td>
                      <td>
                        <span style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: '#94a3b8' }}>
                          {job.preset}
                        </span>
                      </td>
                      <td><StatusBadge status={job.status} /></td>
                      <td>
                        <div style={{ display: 'flex', gap: 8, fontSize: 12 }}>
                          {job.created_count > 0 && <span style={{ color: '#4ade80' }}>+{job.created_count}</span>}
                          {job.updated_count > 0 && <span style={{ color: '#60a5fa' }}>↻{job.updated_count}</span>}
                          {job.failed_count > 0 && <span style={{ color: '#f87171' }}>✗{job.failed_count}</span>}
                          {job.created_count === 0 && job.updated_count === 0 && job.failed_count === 0 && (
                            <span style={{ color: '#475569' }}>—</span>
                          )}
                        </div>
                      </td>
                      <td style={{ color: '#64748b', fontSize: 13 }}>
                        {new Date(job.created_at).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Quick actions */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16, marginTop: 24 }}>
          {[
            { title: 'Add a Feed', desc: 'Connect a Google Sheet as a product source', icon: Database, href: '/feeds', color: '#a78bfa' },
            { title: 'Add a Channel', desc: 'Connect Shopify store or marketplace', icon: GitBranch, href: '/channels', color: '#22d3ee' },
            { title: 'Configure Mapping', desc: 'Map feed columns to channel fields', icon: CheckCircle2, href: '/mapping', color: '#4ade80' },
          ].map(action => (
            <div key={action.href} className="glass-card glass-card-hover" style={{ padding: 20, cursor: 'pointer' }} onClick={() => navigate(action.href)}>
              <div style={{ width: 40, height: 40, borderRadius: 10, background: `${action.color}15`, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 12 }}>
                <action.icon size={18} color={action.color} />
              </div>
              <div style={{ fontSize: 14, fontWeight: 600, color: '#e2e8f0', marginBottom: 4 }}>{action.title}</div>
              <div style={{ fontSize: 13, color: '#64748b' }}>{action.desc}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
