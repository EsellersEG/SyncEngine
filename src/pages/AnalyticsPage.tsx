import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../hooks/useAuth';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, LineChart, Line, Legend
} from 'recharts';
import { TrendingUp, ShoppingBag, DollarSign, Package, AlertCircle, Zap, BarChart3 } from 'lucide-react';

interface AnalyticsData {
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

const COLORS = ['#4f6ef7', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#06b6d4', '#f97316', '#ec4899', '#84cc16', '#6366f1'];

function StatCard({ icon: Icon, label, value, sub, color }: {
  icon: React.ElementType; label: string; value: string | number; sub?: string; color: string;
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

export default function AnalyticsPage() {
  const { isClient, user } = useAuth();
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [clients, setClients] = useState<Client[]>([]);
  const [selectedClient, setSelectedClient] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [loading, setLoading] = useState(true);

  // Load clients for admin/employee
  useEffect(() => {
    if (!isClient) {
      api.get('/clients').then((c: Client[]) => {
        setClients(c);
        if (c.length > 0 && !selectedClient) setSelectedClient(c[0].id);
      }).catch(console.error);
    }
  }, [isClient]);

  // Load analytics data
  useEffect(() => {
    if (!isClient && !selectedClient) return;
    setLoading(true);
    const params = new URLSearchParams();
    if (!isClient && selectedClient) params.set('client_id', selectedClient);
    if (fromDate) params.set('from', fromDate);
    if (toDate) params.set('to', toDate);

    api.get(`/analytics?${params.toString()}`)
      .then((d: AnalyticsData) => setData(d))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [selectedClient, fromDate, toDate, isClient]);

  const formatCurrency = (v: number) => v.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0 });

  if (loading && !data) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 400 }}>
        <div className="spinner" style={{ width: 32, height: 32, border: '3px solid rgba(79,110,247,0.2)', borderTopColor: '#4f6ef7', borderRadius: '50%' }} />
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
      <div style={{ display: 'flex', gap: 12, marginBottom: 24, flexWrap: 'wrap', alignItems: 'center' }}>
        {!isClient && (
          <select
            className="input"
            style={{ width: 220 }}
            value={selectedClient}
            onChange={e => setSelectedClient(e.target.value)}
          >
            <option value="">Select Client</option>
            {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <label style={{ fontSize: 13, color: '#94a3b8' }}>From:</label>
          <input
            type="date"
            className="input"
            style={{ width: 160 }}
            value={fromDate}
            onChange={e => setFromDate(e.target.value)}
          />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <label style={{ fontSize: 13, color: '#94a3b8' }}>To:</label>
          <input
            type="date"
            className="input"
            style={{ width: 160 }}
            value={toDate}
            onChange={e => setToDate(e.target.value)}
          />
        </div>
        {(fromDate || toDate) && (
          <button className="btn btn-ghost" onClick={() => { setFromDate(''); setToDate(''); }}>
            Clear Dates
          </button>
        )}
      </div>

      {!data ? (
        <div style={{ textAlign: 'center', padding: 60, color: '#64748b' }}>
          <BarChart3 size={48} style={{ marginBottom: 16, opacity: 0.4 }} />
          <p>Select a client to view analytics</p>
        </div>
      ) : (
        <>
          {/* Summary Cards */}
          <div className="stats-grid" style={{ marginBottom: 32 }}>
            <StatCard icon={ShoppingBag} label="Total Orders" value={data.summary.total_orders} color="#4f6ef7" />
            <StatCard icon={DollarSign} label="Total Revenue" value={formatCurrency(data.summary.total_revenue)} color="#10b981" />
            <StatCard icon={TrendingUp} label="Avg Order Value" value={formatCurrency(data.summary.avg_order_value)} color="#f59e0b" />
            <StatCard icon={Package} label="Total Products" value={data.products.total_products} sub={`${data.products.active} active`} color="#8b5cf6" />
            <StatCard icon={Zap} label="Sync Jobs" value={data.sync_jobs.total_jobs} sub={`${data.sync_jobs.completed} completed, ${data.sync_jobs.failed} failed`} color="#06b6d4" />
            <StatCard icon={AlertCircle} label="Sync Success Rate" value={data.sync_jobs.total_jobs > 0 ? `${Math.round((data.sync_jobs.completed / data.sync_jobs.total_jobs) * 100)}%` : 'N/A'} color="#10b981" />
          </div>

          {/* Orders Over Time Chart */}
          {data.orders_over_time.length > 0 && (
            <div className="card" style={{ marginBottom: 24, padding: 20 }}>
              <h3 style={{ marginBottom: 16, fontSize: 15, fontWeight: 600, color: '#f1f5f9' }}>Orders Over Time</h3>
              <ResponsiveContainer width="100%" height={280}>
                <LineChart data={data.orders_over_time}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                  <XAxis dataKey="date" stroke="#64748b" fontSize={11} tickFormatter={v => new Date(v).toLocaleDateString('en', { month: 'short', day: 'numeric' })} />
                  <YAxis yAxisId="left" stroke="#64748b" fontSize={11} />
                  <YAxis yAxisId="right" orientation="right" stroke="#64748b" fontSize={11} />
                  <Tooltip contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8, fontSize: 12 }} />
                  <Legend />
                  <Line yAxisId="left" type="monotone" dataKey="order_count" stroke="#4f6ef7" name="Orders" strokeWidth={2} dot={false} />
                  <Line yAxisId="right" type="monotone" dataKey="revenue" stroke="#10b981" name="Revenue ($)" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Status Charts Row */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 20, marginBottom: 24 }}>
            {/* Order Sync Status */}
            <div className="card" style={{ padding: 20 }}>
              <h3 style={{ marginBottom: 16, fontSize: 15, fontWeight: 600, color: '#f1f5f9' }}>Order Sync Status</h3>
              {data.order_status.length > 0 ? (
                <ResponsiveContainer width="100%" height={200}>
                  <PieChart>
                    <Pie data={data.order_status} dataKey="count" nameKey="status" cx="50%" cy="50%" outerRadius={70} label={({ status, count }) => `${status} (${count})`} labelLine={false}>
                      {data.order_status.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                    </Pie>
                    <Tooltip contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8, fontSize: 12 }} />
                  </PieChart>
                </ResponsiveContainer>
              ) : <EmptyState />}
            </div>

            {/* Financial Status */}
            <div className="card" style={{ padding: 20 }}>
              <h3 style={{ marginBottom: 16, fontSize: 15, fontWeight: 600, color: '#f1f5f9' }}>Payment Status</h3>
              {data.financial_status.length > 0 ? (
                <ResponsiveContainer width="100%" height={200}>
                  <PieChart>
                    <Pie data={data.financial_status} dataKey="count" nameKey="financial_status" cx="50%" cy="50%" outerRadius={70} label={({ financial_status, count }) => `${financial_status || 'unknown'} (${count})`} labelLine={false}>
                      {data.financial_status.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                    </Pie>
                    <Tooltip contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8, fontSize: 12 }} />
                  </PieChart>
                </ResponsiveContainer>
              ) : <EmptyState />}
            </div>

            {/* Fulfillment Status */}
            <div className="card" style={{ padding: 20 }}>
              <h3 style={{ marginBottom: 16, fontSize: 15, fontWeight: 600, color: '#f1f5f9' }}>Shipping / Fulfillment Status</h3>
              {data.fulfillment_status.length > 0 ? (
                <ResponsiveContainer width="100%" height={200}>
                  <PieChart>
                    <Pie data={data.fulfillment_status} dataKey="count" nameKey="fulfillment_status" cx="50%" cy="50%" outerRadius={70} label={({ fulfillment_status, count }) => `${fulfillment_status} (${count})`} labelLine={false}>
                      {data.fulfillment_status.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                    </Pie>
                    <Tooltip contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8, fontSize: 12 }} />
                  </PieChart>
                </ResponsiveContainer>
              ) : <EmptyState />}
            </div>
          </div>

          {/* City Distribution */}
          <div className="card" style={{ marginBottom: 24, padding: 20 }}>
            <h3 style={{ marginBottom: 16, fontSize: 15, fontWeight: 600, color: '#f1f5f9' }}>Order Distribution by City</h3>
            {data.city_distribution.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={data.city_distribution} layout="vertical" margin={{ left: 80 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                  <XAxis type="number" stroke="#64748b" fontSize={11} />
                  <YAxis type="category" dataKey="city" stroke="#64748b" fontSize={11} width={80} />
                  <Tooltip contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8, fontSize: 12 }} />
                  <Bar dataKey="order_count" fill="#4f6ef7" radius={[0, 4, 4, 0]} name="Orders" />
                </BarChart>
              </ResponsiveContainer>
            ) : <EmptyState />}
          </div>

          {/* Top Products & Brands */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))', gap: 20, marginBottom: 24 }}>
            {/* Top 10 Products */}
            <div className="card" style={{ padding: 20 }}>
              <h3 style={{ marginBottom: 16, fontSize: 15, fontWeight: 600, color: '#f1f5f9' }}>Top 10 Products</h3>
              {data.top_products.length > 0 ? (
                <div style={{ overflowX: 'auto' }}>
                  <table className="data-table" style={{ width: '100%' }}>
                    <thead>
                      <tr>
                        <th style={{ textAlign: 'left' }}>#</th>
                        <th style={{ textAlign: 'left' }}>Product</th>
                        <th style={{ textAlign: 'right' }}>Qty Sold</th>
                        <th style={{ textAlign: 'right' }}>Revenue</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.top_products.map((p, i) => (
                        <tr key={i}>
                          <td>{i + 1}</td>
                          <td style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.product_name}</td>
                          <td style={{ textAlign: 'right' }}>{p.qty_sold}</td>
                          <td style={{ textAlign: 'right' }}>{formatCurrency(p.revenue)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : <EmptyState />}
            </div>

            {/* Top 10 Brands */}
            <div className="card" style={{ padding: 20 }}>
              <h3 style={{ marginBottom: 16, fontSize: 15, fontWeight: 600, color: '#f1f5f9' }}>Top 10 Brands</h3>
              {data.top_brands.length > 0 ? (
                <div style={{ overflowX: 'auto' }}>
                  <table className="data-table" style={{ width: '100%' }}>
                    <thead>
                      <tr>
                        <th style={{ textAlign: 'left' }}>#</th>
                        <th style={{ textAlign: 'left' }}>Brand</th>
                        <th style={{ textAlign: 'right' }}>Qty Sold</th>
                        <th style={{ textAlign: 'right' }}>Revenue</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.top_brands.map((b, i) => (
                        <tr key={i}>
                          <td>{i + 1}</td>
                          <td>{b.brand}</td>
                          <td style={{ textAlign: 'right' }}>{b.qty_sold}</td>
                          <td style={{ textAlign: 'right' }}>{formatCurrency(b.revenue)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : <EmptyState />}
            </div>
          </div>

          {/* Sync Jobs Detail */}
          <div className="card" style={{ marginBottom: 24, padding: 20 }}>
            <h3 style={{ marginBottom: 16, fontSize: 15, fontWeight: 600, color: '#f1f5f9' }}>Sync Jobs Summary</h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12, marginBottom: 16 }}>
              <MiniStat label="Total" value={data.sync_jobs.total_jobs} />
              <MiniStat label="Completed" value={data.sync_jobs.completed} color="#10b981" />
              <MiniStat label="Failed" value={data.sync_jobs.failed} color="#ef4444" />
              <MiniStat label="Running" value={data.sync_jobs.running} color="#f59e0b" />
              <MiniStat label="Avg Duration" value={data.sync_jobs.avg_duration_seconds ? `${Math.round(data.sync_jobs.avg_duration_seconds)}s` : 'N/A'} />
            </div>
            {data.sync_jobs.last_sync_per_feed.length > 0 && (
              <>
                <h4 style={{ fontSize: 13, fontWeight: 600, color: '#94a3b8', marginBottom: 8 }}>Last Sync per Feed</h4>
                <table className="data-table" style={{ width: '100%' }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: 'left' }}>Feed</th>
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
              </>
            )}
          </div>

          {/* Error Analysis */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))', gap: 20, marginBottom: 24 }}>
            {/* Recent Order Errors */}
            <div className="card" style={{ padding: 20 }}>
              <h3 style={{ marginBottom: 16, fontSize: 15, fontWeight: 600, color: '#f1f5f9' }}>Recent Order Errors</h3>
              {data.errors.recent_order_errors.length > 0 ? (
                <div style={{ maxHeight: 300, overflowY: 'auto' }}>
                  {data.errors.recent_order_errors.map((e, i) => (
                    <div key={i} style={{ padding: '10px 0', borderBottom: '1px solid #1e293b' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                        <span style={{ fontSize: 13, fontWeight: 600, color: '#f1f5f9' }}>#{e.shopify_order_number}</span>
                        <span style={{ fontSize: 11, color: '#64748b' }}>{new Date(e.created_at).toLocaleDateString()}</span>
                      </div>
                      <div style={{ fontSize: 12, color: '#ef4444', wordBreak: 'break-word' }}>{e.error_message}</div>
                    </div>
                  ))}
                </div>
              ) : <EmptyState message="No order errors" />}
            </div>

            {/* Recent Sync Errors */}
            <div className="card" style={{ padding: 20 }}>
              <h3 style={{ marginBottom: 16, fontSize: 15, fontWeight: 600, color: '#f1f5f9' }}>Recent Sync Errors</h3>
              {data.errors.recent_sync_errors.length > 0 ? (
                <div style={{ maxHeight: 300, overflowY: 'auto' }}>
                  {data.errors.recent_sync_errors.map((e, i) => (
                    <div key={i} style={{ padding: '10px 0', borderBottom: '1px solid #1e293b' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                        <span style={{ fontSize: 13, fontWeight: 600, color: '#f1f5f9' }}>{e.channel_name} — {e.preset}</span>
                        <span style={{ fontSize: 11, color: '#64748b' }}>{new Date(e.created_at).toLocaleDateString()}</span>
                      </div>
                      <div style={{ fontSize: 12, color: '#ef4444', wordBreak: 'break-word' }}>{e.error_message}</div>
                    </div>
                  ))}
                </div>
              ) : <EmptyState message="No sync errors" />}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function MiniStat({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div style={{ background: '#0f172a', borderRadius: 8, padding: '12px 16px', border: '1px solid #1e293b' }}>
      <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: color || '#f1f5f9' }}>{value}</div>
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
