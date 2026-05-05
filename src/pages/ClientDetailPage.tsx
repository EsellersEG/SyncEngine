import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { ArrowLeft, Database, GitBranch, Package, Zap } from 'lucide-react';

interface Client {
  id: string; name: string; slug: string; is_active: boolean; created_at: string;
}
interface Stats {
  feeds: number; channels: number; products: number; completed: string; failed: string; running: string;
}

export default function ClientDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [client, setClient] = useState<Client | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    if (!id) return;
    Promise.all([
      api.get(`/clients/${id}`),
      api.get(`/clients/${id}/stats`),
    ]).then(([c, s]) => {
      setClient(c as Client);
      setStats(s as Stats);
    }).catch(console.error);
  }, [id]);

  if (!client) return (
    <div style={{ padding: 40, textAlign: 'center' }}>
      <div className="spinner" style={{ width: 28, height: 28, border: '3px solid rgba(79,110,247,0.2)', borderTopColor: '#4f6ef7', borderRadius: '50%', margin: '0 auto' }} />
    </div>
  );

  return (
    <div className="animate-fade-in">
      <div className="page-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <button className="btn btn-secondary btn-sm btn-icon" onClick={() => navigate('/clients')}>
            <ArrowLeft size={14} />
          </button>
          <div>
            <h1 className="page-title">{client.name}</h1>
            <p className="page-subtitle">/{client.slug} · Created {new Date(client.created_at).toLocaleDateString()}</p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-secondary btn-sm" onClick={() => navigate(`/feeds?client_id=${id}`)}>
            <Database size={13} /> Feeds
          </button>
          <button className="btn btn-secondary btn-sm" onClick={() => navigate(`/channels?client_id=${id}`)}>
            <GitBranch size={13} /> Channels
          </button>
          <button className="btn btn-primary btn-sm" onClick={() => navigate(`/sync?client_id=${id}`)}>
            <Zap size={13} /> Sync
          </button>
        </div>
      </div>

      <div className="page-body">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 16 }}>
          {[
            { icon: Database, label: 'Feeds', value: stats?.feeds ?? '—', color: '#a78bfa' },
            { icon: GitBranch, label: 'Channels', value: stats?.channels ?? '—', color: '#22d3ee' },
            { icon: Package, label: 'Products', value: stats?.products ?? '—', color: '#4ade80' },
            { icon: Zap, label: 'Syncs Done', value: stats?.completed ?? '—', color: '#4f6ef7' },
          ].map(s => (
            <div key={s.label} className="stat-card">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span className="stat-label">{s.label}</span>
                <div style={{ width: 32, height: 32, borderRadius: 8, background: `${s.color}15`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <s.icon size={14} color={s.color} />
                </div>
              </div>
              <div className="stat-value">{s.value}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
