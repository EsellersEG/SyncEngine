import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, LineChart, Line, Legend
} from 'recharts';
import { TrendingUp, ShoppingBag, DollarSign, Package, Zap, BarChart3 } from 'lucide-react';

interface AnalyticsData {
  currency: string;
  summary: { total_orders: number; total_revenue: number; avg_order_value: number };
  order_status: Array<{ status: string; count: number }>;
  financial_status: Array<{ financial_status: string; count: number }>;
  fulfillment_status: Array<{ fulfillment_status: string; count: number }>;
  city_distribution: Array<{ city: string; order_count: number }>;
  top_products: Array<{ product_name: string; qty_sold: number; revenue: number }>;
  top_brands: Array<{ brand: string; qty_sold: number; revenue: number }>;
  sync_jobs: { total_jobs: number; completed: number; failed: number; running: number; avg_duration_seconds: number | null; last_sync_per_feed: Array<{ feed_id: string; feed_name: string; last_sync: string }> };
  errors: { recent_order_errors: Array<{ shopify_order_number: string; error_message: string; created_at: string }>; recent_sync_errors: Array<{ id: string; preset: string; error_message: string; created_at: string; channel_name: string }> };
  products: { total_products: number; active: number; archived: number; error: number };
  orders_over_time: Array<{ date: string; order_count: number; revenue: number }>;
}

interface Client {
  id: string;
  name: string;
}

const COLORS = ['#ffa500', '#ff6b00', '#22c55e', '#3b82f6', '#8b5cf6', '#06b6d4', '#f59e0b', '#ec4899', '#84cc16', '#6366f1'];

function StatCard({ icon: Icon, label, value, sub, color }: {
  icon: React.ElementType; label: string; value: string | number; sub?: string; color: string;
}) {
  return (
    <div className="stat-card" style={{ borderColor: `${color}20` }}>
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

function SectionDivider({ title }: { title: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16, margin: '36px 0 20px' }}>
      <div style={{ height: 1, flex: 1, background: 'linear-gradient(90deg, rgba(255,165,0,0.3), rgba(255,165,0,0.05))' }} />
      <span style={{ fontSize: 13, fontWeight: 600, color: '#ffa500', textTransform: 'uppercase', letterSpacing: '0.08em', whiteSpace: 'nowrap' }}>{title}</span>
      <div style={{ height: 1, flex: 1, background: 'linear-gradient(90deg, rgba(255,165,0,0.05), rgba(255,165,0,0.3))' }} />
    </div>
  );
}

export default function AnalyticsPage() {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [clients, setClients] = useState<Client[]>([]);
  const [selectedClient, setSelectedClient] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/clients').then((c: Client[]) => {
      setClients(c);
      if (c.length > 0 && !selectedClient) setSelectedClient(c[0].id);
    }).catch(console.error);
  }, []);

  useEffect(() => {
    if (!selectedClient) return;
    setLoading(true);
    const params = new URLSearchParams();
    if (selectedClient) params.set('client_id', selectedClient);
    if (fromDate) params.set('from', fromDate);
    if (toDate) params.set('to', toDate);

    api.get(`/analytics?${params.toString()}`)
      .then((d: AnalyticsData) => setData(d))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [selectedClient, fromDate, toDate]);

  const formatCurrency = (v: number) => {
    const currency = data?.currency || 'USD';
    try {
      return v.toLocaleString('en-US', { style: 'currency', currency, minimumFractionDigits: 0 });
    } catch {
      return `${currency} ${v.toLocaleString()}`;
    }
  };

  if (loading && !data) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 400 }}>
        <div className="spinner" style={{ width: 32, height: 32, border: '3px solid rgba(255,165,0,0.2)', borderTopColor: '#ffa500', borderRadius: '50%' }} />
      </div>
    );
  }

  return (
    <div style={{ padding: 0 }}>
      {/* Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Analytics</h1>
          <p className="page-subtitle">Shopify order insights and performance metrics</p>
        </div>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 28, flexWrap: 'wrap', alignItems: 'center' }}>
        {clients.length > 1 && (
          <select
            className="input"
            style={{ width: 220 }}
            value={selectedClient}
            onChange={e => setSelectedClient(e.target.value)}
          >
            <option value="">Select Store</option>
            {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <label style={{ fontSize: 13, color: '#64748b', fontWeight: 500 }}>From:</label>
          <input type="date" className="input" style={{ width: 160 }} value={fromDate} onChange={e => setFromDate(e.target.value)} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <label style={{ fontSize: 13, color: '#64748b', fontWeight: 500 }}>To:</label>
          <input type="date" className="input" style={{ width: 160 }} value={toDate} onChange={e => setToDate(e.target.value)} />
        </div>
        {(fromDate || toDate) && (
          <button className="btn btn-secondary btn-sm" onClick={() => { setFromDate(''); setToDate(''); }}>
            Clear Dates
          </button>
        )}
      </div>

      {!data ? (
        <div style={{ textAlign: 'center', padding: 80, color: '#475569' }}>
          <BarChart3 size={48} style={{ marginBottom: 16, opacity: 0.3 }} />
          <p style={{ fontSize: 14 }}>Select a client to view analytics</p>
        </div>
      ) : (
        <>
          {/* ─── Summary Cards ─────────────────────────────────────────── */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 16, marginBottom: 8 }}>
            <StatCard icon={ShoppingBag} label="Total Orders" value={data.summary.total_orders} color="#ffa500" />
            <StatCard icon={DollarSign} label="Total Revenue" value={formatCurrency(data.summary.total_revenue)} color="#22c55e" />
            <StatCard icon={TrendingUp} label="Avg Order Value" value={formatCurrency(data.summary.avg_order_value)} color="#f59e0b" />
            <StatCard icon={Package} label="Total Products" value={data.products.total_products} sub={`${data.products.active} active`} color="#8b5cf6" />
            <StatCard icon={Zap} label="Sync Success" value={data.sync_jobs.total_jobs > 0 ? `${Math.round((data.sync_jobs.completed / data.sync_jobs.total_jobs) * 100)}%` : 'N/A'} sub={`${data.sync_jobs.total_jobs} total jobs`} color="#3b82f6" />
          </div>

          {/* ─── Orders Over Time ──────────────────────────────────────── */}
          {data.orders_over_time.length > 0 && (
            <>
              <SectionDivider title="Orders Over Time" />
              <div className="glass-card" style={{ padding: 24, marginBottom: 8 }}>
                <ResponsiveContainer width="100%" height={280}>
                  <LineChart data={data.orders_over_time}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,165,0,0.08)" />
                    <XAxis dataKey="date" stroke="#475569" fontSize={11} tickFormatter={v => new Date(v).toLocaleDateString('en', { month: 'short', day: 'numeric' })} />
                    <YAxis yAxisId="left" stroke="#475569" fontSize={11} />
                    <YAxis yAxisId="right" orientation="right" stroke="#475569" fontSize={11} />
                    <Tooltip contentStyle={{ background: '#131929', border: '1px solid rgba(255,165,0,0.2)', borderRadius: 10, fontSize: 12, color: '#e2e8f0' }} />
                    <Legend wrapperStyle={{ fontSize: 12, color: '#94a3b8' }} />
                    <Line yAxisId="left" type="monotone" dataKey="order_count" stroke="#ffa500" name="Orders" strokeWidth={2} dot={false} />
                    <Line yAxisId="right" type="monotone" dataKey="revenue" stroke="#22c55e" name="Revenue ($)" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </>
          )}

          {/* ─── Order Status Charts ──────────────────────────────────── */}
          <SectionDivider title="Order Status Breakdown" />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 20, marginBottom: 8 }}>
            {/* Sync Status */}
            <div className="glass-card" style={{ padding: 24 }}>
              <h3 style={{ marginBottom: 16, fontSize: 14, fontWeight: 600, color: '#e2e8f0' }}>Sync Status</h3>
              {data.order_status.length > 0 ? (
                <ResponsiveContainer width="100%" height={200}>
                  <PieChart>
                    <Pie data={data.order_status} dataKey="count" nameKey="status" cx="50%" cy="50%" outerRadius={70} label={({ status, count }) => `${status} (${count})`} labelLine={false} fontSize={11}>
                      {data.order_status.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                    </Pie>
                    <Tooltip contentStyle={{ background: '#131929', border: '1px solid rgba(255,165,0,0.2)', borderRadius: 10, fontSize: 12, color: '#e2e8f0' }} />
                  </PieChart>
                </ResponsiveContainer>
              ) : <EmptyState />}
            </div>

            {/* Payment Status */}
            <div className="glass-card" style={{ padding: 24 }}>
              <h3 style={{ marginBottom: 16, fontSize: 14, fontWeight: 600, color: '#e2e8f0' }}>Payment Status</h3>
              {data.financial_status.length > 0 ? (
                <ResponsiveContainer width="100%" height={200}>
                  <PieChart>
                    <Pie data={data.financial_status} dataKey="count" nameKey="financial_status" cx="50%" cy="50%" outerRadius={70} label={({ financial_status, count }) => `${financial_status || 'unknown'} (${count})`} labelLine={false} fontSize={11}>
                      {data.financial_status.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                    </Pie>
                    <Tooltip contentStyle={{ background: '#131929', border: '1px solid rgba(255,165,0,0.2)', borderRadius: 10, fontSize: 12, color: '#e2e8f0' }} />
                  </PieChart>
                </ResponsiveContainer>
              ) : <EmptyState />}
            </div>

            {/* Fulfillment Status */}
            <div className="glass-card" style={{ padding: 24 }}>
              <h3 style={{ marginBottom: 16, fontSize: 14, fontWeight: 600, color: '#e2e8f0' }}>Shipping / Fulfillment</h3>
              {data.fulfillment_status.length > 0 ? (
                <ResponsiveContainer width="100%" height={200}>
                  <PieChart>
                    <Pie data={data.fulfillment_status} dataKey="count" nameKey="fulfillment_status" cx="50%" cy="50%" outerRadius={70} label={({ fulfillment_status, count }) => `${fulfillment_status} (${count})`} labelLine={false} fontSize={11}>
                      {data.fulfillment_status.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                    </Pie>
                    <Tooltip contentStyle={{ background: '#131929', border: '1px solid rgba(255,165,0,0.2)', borderRadius: 10, fontSize: 12, color: '#e2e8f0' }} />
                  </PieChart>
                </ResponsiveContainer>
              ) : <EmptyState />}
            </div>
          </div>

          {/* ─── City Distribution ─────────────────────────────────────── */}
          <SectionDivider title="Order Distribution by City" />
          <div className="glass-card" style={{ padding: 24, marginBottom: 8 }}>
            {data.city_distribution.length > 0 ? (
              <ResponsiveContainer width="100%" height={Math.max(250, data.city_distribution.length * 32)}>
                <BarChart data={data.city_distribution} layout="vertical" margin={{ left: 80 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,165,0,0.08)" />
                  <XAxis type="number" stroke="#475569" fontSize={11} />
                  <YAxis type="category" dataKey="city" stroke="#94a3b8" fontSize={12} width={80} />
                  <Tooltip contentStyle={{ background: '#131929', border: '1px solid rgba(255,165,0,0.2)', borderRadius: 10, fontSize: 12, color: '#e2e8f0' }} />
                  <Bar dataKey="order_count" fill="url(#barGradient)" radius={[0, 6, 6, 0]} name="Orders" />
                  <defs>
                    <linearGradient id="barGradient" x1="0" y1="0" x2="1" y2="0">
                      <stop offset="0%" stopColor="#ffa500" />
                      <stop offset="100%" stopColor="#ff6b00" />
                    </linearGradient>
                  </defs>
                </BarChart>
              </ResponsiveContainer>
            ) : <EmptyState />}
          </div>

          {/* ─── Top Products & Brands ─────────────────────────────────── */}
          <SectionDivider title="Top Products & Brands" />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))', gap: 20, marginBottom: 8 }}>
            {/* Top 10 Products */}
            <div className="glass-card" style={{ padding: 24 }}>
              <h3 style={{ marginBottom: 16, fontSize: 14, fontWeight: 600, color: '#e2e8f0' }}>Top 10 Products</h3>
              {data.top_products.length > 0 ? (
                <div className="table-container">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Product</th>
                        <th style={{ textAlign: 'right' }}>Qty Sold</th>
                        <th style={{ textAlign: 'right' }}>Revenue</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.top_products.map((p, i) => (
                        <tr key={i}>
                          <td style={{ color: '#ffa500', fontWeight: 600 }}>{i + 1}</td>
                          <td style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.product_name}</td>
                          <td style={{ textAlign: 'right', fontWeight: 600 }}>{p.qty_sold}</td>
                          <td style={{ textAlign: 'right', color: '#22c55e' }}>{formatCurrency(p.revenue)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : <EmptyState />}
            </div>

            {/* Top 10 Brands */}
            <div className="glass-card" style={{ padding: 24 }}>
              <h3 style={{ marginBottom: 16, fontSize: 14, fontWeight: 600, color: '#e2e8f0' }}>Top 10 Brands</h3>
              {data.top_brands.length > 0 ? (
                <div className="table-container">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Brand</th>
                        <th style={{ textAlign: 'right' }}>Qty Sold</th>
                        <th style={{ textAlign: 'right' }}>Revenue</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.top_brands.map((b, i) => (
                        <tr key={i}>
                          <td style={{ color: '#ffa500', fontWeight: 600 }}>{i + 1}</td>
                          <td>{b.brand}</td>
                          <td style={{ textAlign: 'right', fontWeight: 600 }}>{b.qty_sold}</td>
                          <td style={{ textAlign: 'right', color: '#22c55e' }}>{formatCurrency(b.revenue)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : <EmptyState />}
            </div>
          </div>

          {/* ─── Sync Jobs Summary ─────────────────────────────────────── */}
          <SectionDivider title="Sync Jobs" />
          <div className="glass-card" style={{ padding: 24 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 12, marginBottom: 20 }}>
              <MiniStat label="Total" value={data.sync_jobs.total_jobs} />
              <MiniStat label="Completed" value={data.sync_jobs.completed} color="#22c55e" />
              <MiniStat label="Failed" value={data.sync_jobs.failed} color="#ef4444" />
              <MiniStat label="Running" value={data.sync_jobs.running} color="#f59e0b" />
              <MiniStat label="Avg Duration" value={data.sync_jobs.avg_duration_seconds ? `${Math.round(data.sync_jobs.avg_duration_seconds)}s` : 'N/A'} />
            </div>
            {data.sync_jobs.last_sync_per_feed.length > 0 && (
              <div className="table-container">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Feed</th>
                      <th style={{ textAlign: 'right' }}>Last Sync</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.sync_jobs.last_sync_per_feed.map((f, i) => (
                      <tr key={i}>
                        <td>{f.feed_name || f.feed_id}</td>
                        <td style={{ textAlign: 'right' }}>{f.last_sync ? new Date(f.last_sync).toLocaleString() : 'Never'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function MiniStat({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div style={{ background: 'rgba(8,12,24,0.6)', borderRadius: 10, padding: '14px 16px', border: '1px solid rgba(255,165,0,0.08)' }}>
      <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 500 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: color || '#e2e8f0' }}>{value}</div>
    </div>
  );
}

function EmptyState({ message = 'No data available' }: { message?: string }) {
  return (
    <div style={{ textAlign: 'center', padding: '30px 0', color: '#475569', fontSize: 13 }}>
      {message}
    </div>
  );
}
