import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { ShoppingBag, RefreshCw, CheckCircle, Clock, XCircle, ExternalLink, X, Package } from 'lucide-react';

interface LineItem {
  name: string;
  quantity: number;
  price: string;
  sku?: string;
  variant_id?: string | number;
}

interface Order {
  id: string;
  channel_id: string;
  shopify_order_id: string;
  shopify_order_number: string;
  shopify_store_url?: string;
  odoo_order_id: number | null;
  odoo_order_name: string | null;
  status: string;
  total_price: string;
  customer_email: string;
  error_message: string | null;
  synced_at: string | null;
  created_at: string;
  channel_name?: string;
  raw_data?: {
    currency?: string;
    line_items?: LineItem[];
    shipping_address?: { name?: string; address1?: string; city?: string; country?: string };
    financial_status?: string;
    fulfillment_status?: string | null;
  };
}

function currencySymbol(code?: string): string {
  if (!code) return '$';
  try {
    const s = new Intl.NumberFormat('en', { style: 'currency', currency: code, maximumFractionDigits: 0 }).format(0);
    return s.replace(/[\d,.\s]/g, '').trim() || code;
  } catch { return code; }
}

export default function OrdersPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const [modalLoading, setModalLoading] = useState(false);

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

  async function openOrder(orderId: string) {
    const base = orders.find(o => o.id === orderId) || null;
    setSelectedOrder(base);
    setModalLoading(true);
    try {
      const full = await api.get(`/orders/${orderId}`) as Order;
      setSelectedOrder(full);
    } catch (err) {
      console.error('Failed to load order details:', err);
    } finally {
      setModalLoading(false);
    }
  }

  async function handleRetry(orderId: string) {
    setRetrying(orderId);
    try {
      await api.post(`/orders/${orderId}/retry`, {});
      await fetchOrders();
      if (selectedOrder?.id === orderId) {
        const fresh = await api.get(`/orders/${orderId}`) as Order;
        setSelectedOrder(fresh);
      }
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
                  <th>Odoo Order</th>
                  <th>Date</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {orders.map(order => {
                  const sym = currencySymbol(order.raw_data?.currency);
                  return (
                    <tr key={order.id} style={{ cursor: 'pointer' }} onClick={() => openOrder(order.id)}>
                      <td>
                        <div style={{ fontWeight: 600, color: '#4f6ef7' }}>{order.shopify_order_number}</div>
                      </td>
                      <td style={{ fontSize: 13, color: '#94a3b8' }}>{order.customer_email || '—'}</td>
                      <td style={{ fontWeight: 600, color: '#e2e8f0' }}>{sym}{order.total_price}</td>
                      <td onClick={e => e.stopPropagation()}>{statusBadge(order.status)}</td>
                      <td style={{ fontSize: 13, color: '#94a3b8', fontFamily: 'var(--font-mono)' }}>
                        {order.odoo_order_name || (order.odoo_order_id ? `#${order.odoo_order_id}` : '—')}
                      </td>
                      <td style={{ fontSize: 13, color: '#64748b' }}>
                        {new Date(order.created_at).toLocaleString()}
                      </td>
                      <td onClick={e => e.stopPropagation()}>
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
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Order Detail Modal ─────────────────────────────────────────── */}
      {selectedOrder && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
          onClick={() => setSelectedOrder(null)}
        >
          <div
            className="glass-card"
            style={{ width: '100%', maxWidth: 660, maxHeight: '90vh', overflow: 'auto', padding: 28 }}
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
              <div>
                <div style={{ fontSize: 20, fontWeight: 700, color: '#e2e8f0' }}>{selectedOrder.shopify_order_number}</div>
                <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>
                  {selectedOrder.channel_name} · {new Date(selectedOrder.created_at).toLocaleString()}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {statusBadge(selectedOrder.status)}
                <button className="btn btn-secondary btn-sm" onClick={() => setSelectedOrder(null)} style={{ padding: '4px 8px' }}>
                  <X size={14} />
                </button>
              </div>
            </div>

            {modalLoading ? (
              <div style={{ textAlign: 'center', padding: 40 }}>
                <div className="spinner" style={{ width: 24, height: 24, border: '3px solid rgba(79,110,247,0.2)', borderTopColor: '#4f6ef7', borderRadius: '50%', margin: '0 auto' }} />
              </div>
            ) : (() => {
              const raw = selectedOrder.raw_data;
              const sym = currencySymbol(raw?.currency);
              const shopifyUrl = selectedOrder.shopify_store_url
                ? `https://${selectedOrder.shopify_store_url.replace(/^https?:\/\//, '')}/admin/orders/${selectedOrder.shopify_order_id}`
                : null;
              return (
                <>
                  {/* Customer & Shipping */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
                    <div className="glass-card" style={{ padding: 14 }}>
                      <div style={{ fontSize: 11, color: '#64748b', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Customer</div>
                      <div style={{ fontSize: 13, color: '#e2e8f0' }}>{selectedOrder.customer_email || '—'}</div>
                    </div>
                    <div className="glass-card" style={{ padding: 14 }}>
                      <div style={{ fontSize: 11, color: '#64748b', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Ship To</div>
                      <div style={{ fontSize: 13, color: '#e2e8f0' }}>
                        {raw?.shipping_address?.name && <div>{raw.shipping_address.name}</div>}
                        {raw?.shipping_address?.address1 && <div style={{ color: '#94a3b8' }}>{raw.shipping_address.address1}</div>}
                        {raw?.shipping_address?.city && <div style={{ color: '#94a3b8' }}>{raw.shipping_address.city}, {raw.shipping_address.country}</div>}
                        {!raw?.shipping_address && '—'}
                      </div>
                    </div>
                  </div>

                  {/* Line Items */}
                  {raw?.line_items && raw.line_items.length > 0 && (
                    <div style={{ marginBottom: 16 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: '#64748b', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Items</div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {raw.line_items.map((li, i) => (
                          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '9px 12px', background: 'rgba(255,255,255,0.03)', borderRadius: 8, border: '1px solid rgba(255,255,255,0.05)' }}>
                            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                              <Package size={12} color="#475569" />
                              <div>
                                <div style={{ fontSize: 13, color: '#e2e8f0' }}>{li.name}</div>
                                {li.sku && <div style={{ fontSize: 11, color: '#64748b', fontFamily: 'var(--font-mono)' }}>SKU: {li.sku}</div>}
                              </div>
                            </div>
                            <div style={{ textAlign: 'right', flexShrink: 0 }}>
                              <div style={{ fontSize: 13, color: '#e2e8f0' }}>{sym}{li.price}</div>
                              <div style={{ fontSize: 11, color: '#64748b' }}>×{li.quantity}</div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Total */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 0', borderTop: '1px solid rgba(255,255,255,0.06)', marginBottom: 16 }}>
                    <div style={{ fontSize: 13, color: '#94a3b8' }}>Total · {raw?.currency || 'USD'}</div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: '#e2e8f0' }}>{sym}{selectedOrder.total_price}</div>
                  </div>

                  {/* Odoo Sale Order */}
                  {(selectedOrder.odoo_order_name || selectedOrder.odoo_order_id) && (
                    <div className="glass-card" style={{ padding: 14, marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div>
                        <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Odoo Sale Order</div>
                        <div style={{ fontSize: 15, fontWeight: 700, color: '#4ade80' }}>
                          {selectedOrder.odoo_order_name || `SO-${selectedOrder.odoo_order_id}`}
                        </div>
                      </div>
                      {selectedOrder.odoo_order_id && (
                        <div style={{ fontSize: 12, color: '#64748b' }}>ID: {selectedOrder.odoo_order_id}</div>
                      )}
                    </div>
                  )}

                  {/* Error */}
                  {selectedOrder.error_message && (
                    <div style={{ background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)', borderRadius: 8, padding: 12, marginBottom: 16 }}>
                      <div style={{ fontSize: 11, color: '#f87171', fontWeight: 600, marginBottom: 4 }}>Sync Error</div>
                      <div style={{ fontSize: 12, color: '#fca5a5' }}>{selectedOrder.error_message}</div>
                    </div>
                  )}

                  {/* Actions */}
                  <div style={{ display: 'flex', gap: 10 }}>
                    {shopifyUrl && (
                      <a href={shopifyUrl} target="_blank" rel="noopener noreferrer" className="btn btn-secondary" style={{ flex: 1, textAlign: 'center', textDecoration: 'none' }}>
                        <ExternalLink size={13} /> View in Shopify
                      </a>
                    )}
                    {selectedOrder.status === 'failed' && (
                      <button
                        className="btn btn-primary"
                        style={{ flex: 1 }}
                        onClick={() => handleRetry(selectedOrder.id)}
                        disabled={retrying === selectedOrder.id}
                      >
                        <RefreshCw size={13} className={retrying === selectedOrder.id ? 'spinner' : ''} />
                        Retry Odoo Sync
                      </button>
                    )}
                    {selectedOrder.status === 'pending' && (
                      <button
                        className="btn btn-primary"
                        style={{ flex: 1 }}
                        onClick={() => handleRetry(selectedOrder.id)}
                        disabled={retrying === selectedOrder.id}
                      >
                        <RefreshCw size={13} className={retrying === selectedOrder.id ? 'spinner' : ''} />
                        Sync to Odoo
                      </button>
                    )}
                  </div>
                </>
              );
            })()}
          </div>
        </div>
      )}
    </div>
  );
}
