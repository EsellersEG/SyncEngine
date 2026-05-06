import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { ShoppingBag, RefreshCw, AlertTriangle, CheckCircle, Clock, XCircle } from 'lucide-react';

interface Order {
  id: string;
  channel_id: string;
  shopify_order_id: string;
  shopify_order_number: string;
  odoo_order_id: number | null;
  status: string;
  total_price: string;
  customer_email: string;
  error_message: string | null;
  synced_at: string | null;
  created_at: string;
  channel_name?: string;
}

export default function OrdersPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState<string | null>(null);

  async function fetchOrders() {
    try {
      const data = await api.get('/orders') as Order[];
      setOrders(data);
    } catch (err) {
      console.error('Failed to fetch orders:', err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchOrders();
    const interval = setInterval(fetchOrders, 10000);
    return () => clearInterval(interval);
  }, []);

  async function handleRetry(orderId: string) {
    setRetrying(orderId);
    try {
      await api.post(`/orders/${orderId}/retry`, {});
      await fetchOrders();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Retry failed');
    } finally {
      setRetrying(null);
    }
  }

  const statusBadge = (status: string) => {
    switch (status) {
      case 'synced': return <span className="badge badge-success"><CheckCircle size={10} /> Synced</span>;
      case 'failed': return <span className="badge badge-danger"><XCircle size={10} /> Failed</span>;
      case 'pending': return <span className="badge badge-warning"><Clock size={10} /> Pending</span>;
      default: return <span className="badge badge-muted">{status}</span>;
    }
  };

  return (
    <div className="animate-fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Orders</h1>
          <p className="page-subtitle">Shopify → Odoo order synchronization</p>
        </div>
        <button className="btn btn-secondary" onClick={fetchOrders}>
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      <div className="page-body">
        {/* Stats */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 24 }}>
          <div className="glass-card" style={{ padding: 16, textAlign: 'center' }}>
            <div style={{ fontSize: 24, fontWeight: 700, color: '#e2e8f0' }}>{orders.length}</div>
            <div style={{ fontSize: 12, color: '#64748b' }}>Total Orders</div>
          </div>
          <div className="glass-card" style={{ padding: 16, textAlign: 'center' }}>
            <div style={{ fontSize: 24, fontWeight: 700, color: '#4ade80' }}>{orders.filter(o => o.status === 'synced').length}</div>
            <div style={{ fontSize: 12, color: '#64748b' }}>Synced</div>
          </div>
          <div className="glass-card" style={{ padding: 16, textAlign: 'center' }}>
            <div style={{ fontSize: 24, fontWeight: 700, color: '#fbbf24' }}>{orders.filter(o => o.status === 'pending').length}</div>
            <div style={{ fontSize: 12, color: '#64748b' }}>Pending</div>
          </div>
          <div className="glass-card" style={{ padding: 16, textAlign: 'center' }}>
            <div style={{ fontSize: 24, fontWeight: 700, color: '#f87171' }}>{orders.filter(o => o.status === 'failed').length}</div>
            <div style={{ fontSize: 12, color: '#64748b' }}>Failed</div>
          </div>
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', paddingTop: 60 }}>
            <div className="spinner" style={{ width: 28, height: 28, border: '3px solid rgba(79,110,247,0.2)', borderTopColor: '#4f6ef7', borderRadius: '50%', margin: '0 auto' }} />
          </div>
        ) : orders.length === 0 ? (
          <div className="glass-card" style={{ padding: 64, textAlign: 'center' }}>
            <ShoppingBag size={40} color="#334155" style={{ margin: '0 auto 16px' }} />
            <p style={{ color: '#475569', fontSize: 16, fontWeight: 600, marginBottom: 8 }}>No orders synced yet</p>
            <p style={{ color: '#334155', fontSize: 14 }}>Orders will appear here when Shopify sends webhook notifications. Register webhooks in Channel settings.</p>
          </div>
        ) : (
          <div className="table-container">
            <table className="table">
              <thead>
                <tr>
                  <th>Order #</th>
                  <th>Customer</th>
                  <th>Total</th>
                  <th>Status</th>
                  <th>Odoo ID</th>
                  <th>Date</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {orders.map(order => (
                  <tr key={order.id}>
                    <td>
                      <div style={{ fontWeight: 600, color: '#e2e8f0' }}>{order.shopify_order_number}</div>
                    </td>
                    <td style={{ fontSize: 13, color: '#94a3b8' }}>{order.customer_email || '—'}</td>
                    <td style={{ fontWeight: 600, color: '#e2e8f0' }}>${order.total_price}</td>
                    <td>{statusBadge(order.status)}</td>
                    <td style={{ fontSize: 13, color: '#94a3b8', fontFamily: 'var(--font-mono)' }}>
                      {order.odoo_order_id || '—'}
                    </td>
                    <td style={{ fontSize: 13, color: '#64748b' }}>
                      {new Date(order.created_at).toLocaleString()}
                    </td>
                    <td>
                      {order.status === 'failed' && (
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={() => handleRetry(order.id)}
                          disabled={retrying === order.id}
                        >
                          <RefreshCw size={11} className={retrying === order.id ? 'spinner' : ''} />
                          Retry
                        </button>
                      )}
                      {order.error_message && (
                        <div style={{ fontSize: 11, color: '#f87171', marginTop: 4, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                          title={order.error_message}>
                          {order.error_message}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
