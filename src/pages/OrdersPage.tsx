import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../hooks/useAuth';
import Modal from '../components/Modal';
import { ShoppingBag, RefreshCw, CheckCircle, Clock, XCircle, ExternalLink, X, Package, Download } from 'lucide-react';

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
  source: 'shopify' | 'noon';
  // Shopify fields
  shopify_order_id?: string;
  shopify_order_number?: string;
  shopify_store_url?: string;
  odoo_order_id?: number | null;
  odoo_order_name?: string | null;
  customer_email?: string;
  // Noon fields
  noon_order_id?: string;
  noon_order_number?: string;
  customer_name?: string;
  country_code?: string;
  order_type?: string;
  shopify_channel_id?: string;
  // Common
  status: string;
  total_price: string;
  error_message: string | null;
  synced_at: string | null;
  created_at: string;
  channel_name?: string;
  raw_data?: Record<string, unknown>;
}

function currencySymbol(code?: string): string {
  if (!code) return '$';
  try {
    const s = new Intl.NumberFormat('en', { style: 'currency', currency: code, maximumFractionDigits: 0 }).format(0);
    return s.replace(/[\d,.\s]/g, '').trim() || code;
  } catch { return code; }
}

export default function OrdersPage() {
  const { isClient } = useAuth();
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const [modalLoading, setModalLoading] = useState(false);
  const [sourceFilter, setSourceFilter] = useState<'all' | 'shopify' | 'noon'>('all');

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

  async function handleExportCSV() {
    try {
      const token = localStorage.getItem('sync_engine_token');
      const res = await fetch('/api/orders/export', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `orders-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Export failed');
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

  const sourceBadge = (source: string, orderType?: string) => {
    if (source === 'noon') {
      const label = orderType ? `Noon ${orderType.toUpperCase()}` : 'Noon';
      return <span className="badge badge-warning" style={{ fontSize: 10 }}>{label}</span>;
    }
    return <span className="badge badge-info" style={{ fontSize: 10 }}>Shopify</span>;
  };

  const getOrderNumber = (o: Order) => o.source === 'noon' ? (o.noon_order_number || o.noon_order_id || '—') : (o.shopify_order_number || '—');
  const getCustomer = (o: Order) => o.source === 'noon' ? (o.customer_name || '—') : (o.customer_email || '—');
  const getLineItems = (o: Order): LineItem[] => {
    if (o.source === 'noon') {
      const items = (o.raw_data?.items || o.raw_data?.line_items || []) as Array<Record<string, unknown>>;
      return items.map(i => ({ name: String(i.name || i.skuName || i.sku || ''), quantity: Number(i.quantity || 1), price: String(i.price || i.unitPrice || '0'), sku: String(i.sku || '') }));
    }
    return ((o.raw_data?.line_items || []) as LineItem[]);
  };

  const filtered = sourceFilter === 'all' ? orders : orders.filter(o => o.source === sourceFilter);

  return (
    <div className="animate-fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Orders</h1>
          <p className="page-subtitle">All orders from Shopify &amp; Noon</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {!isClient && (
            <button className="btn btn-secondary" onClick={handleExportCSV}>
              <Download size={14} /> Export CSV
            </button>
          )}
          <button className="btn btn-secondary" onClick={fetchOrders}>
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
      </div>

      <div className="page-body">
        {/* Source Filter */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          {(['all', 'shopify', 'noon'] as const).map(s => (
            <button key={s} className={`btn ${sourceFilter === s ? 'btn-primary' : 'btn-secondary'} btn-sm`}
              onClick={() => setSourceFilter(s)}>
              {s === 'all' ? 'All Orders' : s === 'shopify' ? 'Shopify' : 'Noon'}
              <span style={{ marginLeft: 6, opacity: 0.7 }}>
                {s === 'all' ? orders.length : orders.filter(o => o.source === s).length}
              </span>
            </button>
          ))}
        </div>

        {/* Stats */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 24 }}>
          <div className="glass-card" style={{ padding: 16, textAlign: 'center' }}>
            <div style={{ fontSize: 24, fontWeight: 700, color: '#e2e8f0' }}>{filtered.length}</div>
            <div style={{ fontSize: 12, color: '#64748b' }}>Total Orders</div>
          </div>
          <div className="glass-card" style={{ padding: 16, textAlign: 'center' }}>
            <div style={{ fontSize: 24, fontWeight: 700, color: '#4ade80' }}>{filtered.filter(o => o.status === 'synced').length}</div>
            <div style={{ fontSize: 12, color: '#64748b' }}>Synced</div>
          </div>
          <div className="glass-card" style={{ padding: 16, textAlign: 'center' }}>
            <div style={{ fontSize: 24, fontWeight: 700, color: '#fbbf24' }}>{filtered.filter(o => o.status === 'pending').length}</div>
            <div style={{ fontSize: 12, color: '#64748b' }}>Pending</div>
          </div>
          <div className="glass-card" style={{ padding: 16, textAlign: 'center' }}>
            <div style={{ fontSize: 24, fontWeight: 700, color: '#f87171' }}>{filtered.filter(o => o.status === 'failed').length}</div>
            <div style={{ fontSize: 12, color: '#64748b' }}>Failed</div>
          </div>
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', paddingTop: 60 }}>
            <div className="spinner" style={{ width: 28, height: 28, border: '3px solid rgba(79,110,247,0.2)', borderTopColor: '#4f6ef7', borderRadius: '50%', margin: '0 auto' }} />
          </div>
        ) : filtered.length === 0 ? (
          <div className="glass-card" style={{ padding: 64, textAlign: 'center' }}>
            <ShoppingBag size={40} color="#334155" style={{ margin: '0 auto 16px' }} />
            <p style={{ color: '#475569', fontSize: 16, fontWeight: 600, marginBottom: 8 }}>No orders yet</p>
            <p style={{ color: '#334155', fontSize: 14 }}>Orders will appear here from Shopify webhooks and Noon imports.</p>
          </div>
        ) : (
          <div className="table-container">
            <table className="table">
              <thead>
                <tr>
                  <th>Source</th>
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
                {filtered.map(order => {
                  const raw = order.raw_data as Record<string, unknown> | undefined;
                  const currency = raw?.currency as string | undefined;
                  const sym = currencySymbol(currency);
                  return (
                    <tr key={order.id} style={{ cursor: 'pointer' }} onClick={() => openOrder(order.id)}>
                      <td>{sourceBadge(order.source, order.order_type)}</td>
                      <td>
                        <div style={{ fontWeight: 600, color: '#4f6ef7' }}>{getOrderNumber(order)}</div>
                      </td>
                      <td style={{ fontSize: 13, color: '#94a3b8' }}>{getCustomer(order)}</td>
                      <td style={{ fontWeight: 600, color: '#e2e8f0' }}>{sym}{order.total_price}</td>
                      <td onClick={e => e.stopPropagation()}>{statusBadge(order.status)}</td>
                      <td style={{ fontSize: 13, color: '#94a3b8', fontFamily: 'var(--font-mono)' }}>
                        {order.source === 'noon'
                          ? (order.shopify_order_id ? `→ Shopify` : '—')
                          : (order.odoo_order_name || (order.odoo_order_id ? `#${order.odoo_order_id}` : '—'))
                        }
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
        <Modal open={true} onClose={() => setSelectedOrder(null)} maxWidth={660} style={{ padding: 28 }}>
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
              <div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <div style={{ fontSize: 20, fontWeight: 700, color: '#e2e8f0' }}>{getOrderNumber(selectedOrder)}</div>
                  {sourceBadge(selectedOrder.source, selectedOrder.order_type)}
                </div>
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
              const raw = selectedOrder.raw_data as Record<string, unknown> | undefined;
              const currency = raw?.currency as string | undefined;
              const sym = currencySymbol(currency);
              const isNoon = selectedOrder.source === 'noon';
              const shopifyUrl = !isNoon && selectedOrder.shopify_store_url
                ? `https://${selectedOrder.shopify_store_url.replace(/^https?:\/\//, '')}/admin/orders/${selectedOrder.shopify_order_id}`
                : null;
              const lineItems = getLineItems(selectedOrder);
              const shipping = raw?.shipping_address as { name?: string; address1?: string; city?: string; country?: string } | undefined;
              return (
                <>
                  {/* Customer & Shipping */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
                    <div className="glass-card" style={{ padding: 14 }}>
                      <div style={{ fontSize: 11, color: '#64748b', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Customer</div>
                      <div style={{ fontSize: 13, color: '#e2e8f0' }}>{getCustomer(selectedOrder)}</div>
                    </div>
                    <div className="glass-card" style={{ padding: 14 }}>
                      <div style={{ fontSize: 11, color: '#64748b', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                        {isNoon ? 'Country' : 'Ship To'}
                      </div>
                      <div style={{ fontSize: 13, color: '#e2e8f0' }}>
                        {isNoon ? (selectedOrder.country_code || '—') : (
                          <>
                            {shipping?.name && <div>{shipping.name}</div>}
                            {shipping?.address1 && <div style={{ color: '#94a3b8' }}>{shipping.address1}</div>}
                            {shipping?.city && <div style={{ color: '#94a3b8' }}>{shipping.city}, {shipping.country}</div>}
                            {!shipping && '—'}
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Line Items */}
                  {lineItems.length > 0 && (
                    <div style={{ marginBottom: 16 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: '#64748b', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Items</div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {lineItems.map((li, i) => (
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
                    <div style={{ fontSize: 13, color: '#94a3b8' }}>Total · {(currency as string) || 'USD'}</div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: '#e2e8f0' }}>{sym}{selectedOrder.total_price}</div>
                  </div>

                  {/* Noon → Shopify link */}
                  {isNoon && selectedOrder.shopify_order_id && (
                    <div className="glass-card" style={{ padding: 14, marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div>
                        <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Synced to Shopify</div>
                        <div style={{ fontSize: 15, fontWeight: 700, color: '#4ade80' }}>
                          Order #{selectedOrder.shopify_order_id}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Odoo Sale Order (Shopify orders only) */}
                  {!isNoon && (selectedOrder.odoo_order_name || selectedOrder.odoo_order_id) && (
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
                    {!isNoon && selectedOrder.status === 'failed' && (
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
                    {!isNoon && selectedOrder.status === 'pending' && (
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
        </Modal>
      )}
    </div>
  );
}
