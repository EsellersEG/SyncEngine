import { useEffect, useState, useCallback } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../hooks/useAuth';
import Modal from '../components/Modal';
import { Package, Search, RefreshCw, X, Trash2 } from 'lucide-react';

interface Product {
  id: string; sku: string; feed_name: string; status: string;
  fingerprint: string; last_updated_at: string; raw_data: Record<string, string>;
  client_id: string;
}
interface Client { id: string; name: string; }
interface Feed { id: string; name: string; }

export default function ProductsPage() {
  const { isAdmin, isClient } = useAuth();
  const [products, setProducts] = useState<Product[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [clientFilter, setClientFilter] = useState('');
  const [feedFilter, setFeedFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [deleting, setDeleting] = useState(false);
  const limit = 50;

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    Promise.all([
      api.get('/clients'),
      api.get('/feeds'),
    ]).then(([c, f]) => {
      setClients(c as Client[]);
      setFeeds(f as Feed[]);
    });
  }, []);

  const fetchProducts = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(limit) });
      if (debouncedSearch) params.set('search', debouncedSearch);
      if (clientFilter) params.set('client_id', clientFilter);
      if (feedFilter) params.set('feed_id', feedFilter);
      const data = await api.get(`/products?${params}`) as { products: Product[]; total: number };
      setProducts(data.products);
      setTotal(data.total);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [page, debouncedSearch, clientFilter, feedFilter]);

  useEffect(() => { fetchProducts(); }, [fetchProducts]);

  async function handleDeleteProduct(id: string, sku: string) {
    if (!confirm(`Delete product ${sku}? This only removes it from the database, not from Shopify.`)) return;
    try {
      await api.delete(`/products/${id}`);
      setProducts(prev => prev.filter(p => p.id !== id));
      setTotal(prev => prev - 1);
      if (selectedProduct?.id === id) setSelectedProduct(null);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete');
    }
  }

  async function handleBulkDelete() {
    const filterDesc = feedFilter ? feeds.find(f => f.id === feedFilter)?.name : clientFilter ? clients.find(c => c.id === clientFilter)?.name : debouncedSearch ? `search "${debouncedSearch}"` : '';
    if (!filterDesc) { alert('Select a feed, client, or search term first to bulk delete.'); return; }
    if (!confirm(`Delete all ${total.toLocaleString()} products matching "${filterDesc}"? This only removes them from the database, not from Shopify.`)) return;
    setDeleting(true);
    try {
      const params = new URLSearchParams();
      if (feedFilter) params.set('feed_id', feedFilter);
      if (clientFilter) params.set('client_id', clientFilter);
      if (debouncedSearch) params.set('search', debouncedSearch);
      const result = await api.delete(`/products?${params}`) as { deleted: number };
      alert(`Deleted ${result.deleted} products.`);
      fetchProducts();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete');
    } finally { setDeleting(false); }
  }

  const totalPages = Math.ceil(total / limit);

  return (
    <>
    <div className="animate-fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Products</h1>
          <p className="page-subtitle">{total.toLocaleString()} products imported from feeds</p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <select
            className="input"
            style={{ width: 160, padding: '8px 12px' }}
            value={clientFilter}
            onChange={e => { setClientFilter(e.target.value); setPage(1); }}
          >
            <option value="">All Clients</option>
            {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select
            className="input"
            style={{ width: 160, padding: '8px 12px' }}
            value={feedFilter}
            onChange={e => { setFeedFilter(e.target.value); setPage(1); }}
          >
            <option value="">All Feeds</option>
            {feeds.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
          <div style={{ position: 'relative' }}>
            <Search size={14} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#475569' }} />
            <input
              className="input"
              style={{ paddingLeft: 34, width: 200 }}
              placeholder="Search by SKU..."
              value={search}
              onChange={e => { setSearch(e.target.value); setPage(1); }}
            />
          </div>
          <button className="btn btn-secondary btn-sm btn-icon" onClick={fetchProducts} title="Refresh">
            <RefreshCw size={14} className={loading ? 'spinner' : ''} />
          </button>
          {isAdmin && (feedFilter || clientFilter || debouncedSearch) && (
            <button className="btn btn-danger btn-sm" onClick={handleBulkDelete} disabled={deleting || total === 0}>
              <Trash2 size={13} /> Delete {total.toLocaleString()}
            </button>
          )}
        </div>
      </div>

      <div className="page-body">
        {loading ? (
          <div style={{ textAlign: 'center', paddingTop: 60 }}>
            <div className="spinner" style={{ width: 28, height: 28, border: '3px solid rgba(79,110,247,0.2)', borderTopColor: '#4f6ef7', borderRadius: '50%', margin: '0 auto' }} />
          </div>
        ) : products.length === 0 ? (
          <div className="glass-card" style={{ padding: 64, textAlign: 'center' }}>
            <Package size={40} color="#334155" style={{ margin: '0 auto 16px' }} />
            <p style={{ color: '#475569', fontSize: 15, fontWeight: 600 }}>
              {debouncedSearch ? 'No products match your search' : 'No products imported yet'}
            </p>
            <p style={{ color: '#334155', fontSize: 13, marginTop: 6 }}>
              {!debouncedSearch && 'Import products from a feed to get started'}
            </p>
          </div>
        ) : (
          <>
            <div className="table-container">
              <table className="table">
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th>Feed</th>
                    <th>Status</th>
                    <th>Fingerprint</th>
                    <th>Last Updated</th>
                    {isAdmin && <th style={{ width: 50 }}></th>}
                  </tr>
                </thead>
                <tbody>
                  {products.map(product => (
                    <tr key={product.id} onClick={() => setSelectedProduct(product)} style={{ cursor: 'pointer' }}>
                      <td>
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 600, color: '#e2e8f0' }}>
                          {product.sku}
                        </span>
                      </td>
                      <td style={{ fontSize: 13, color: '#94a3b8' }}>{product.feed_name}</td>
                      <td>
                        <span className={`badge ${product.status === 'active' ? 'badge-success' : 'badge-muted'}`}>
                          {product.status}
                        </span>
                      </td>
                      <td>
                        <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: '#334155' }}>
                          {product.fingerprint?.slice(0, 12)}...
                        </span>
                      </td>
                      <td style={{ fontSize: 13, color: '#64748b' }}>
                        {new Date(product.last_updated_at).toLocaleString()}
                      </td>
                      {isAdmin && (
                        <td>
                          <button className="btn btn-danger btn-sm btn-icon" title="Delete" onClick={e => { e.stopPropagation(); handleDeleteProduct(product.id, product.sku); }}>
                            <Trash2 size={12} />
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 16 }}>
                <span style={{ fontSize: 13, color: '#64748b' }}>
                  Showing {(page - 1) * limit + 1}–{Math.min(page * limit, total)} of {total.toLocaleString()}
                </span>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className="btn btn-secondary btn-sm" disabled={page === 1} onClick={() => setPage(p => p - 1)}>← Prev</button>
                  <span style={{ padding: '6px 12px', fontSize: 13, color: '#94a3b8' }}>
                    Page {page} / {totalPages}
                  </span>
                  <button className="btn btn-secondary btn-sm" disabled={page === totalPages} onClick={() => setPage(p => p + 1)}>Next →</button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>

    {/* Product Detail Modal */}
    {selectedProduct && (
      <Modal open={true} onClose={() => setSelectedProduct(null)} maxWidth={640}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
            <div>
              <h2 style={{ fontSize: 18, fontWeight: 700, color: '#e2e8f0', marginBottom: 4 }}>Product Details</h2>
              <p style={{ fontSize: 13, color: '#64748b' }}>SKU: <span style={{ fontFamily: 'var(--font-mono)', color: '#94a3b8' }}>{selectedProduct.sku}</span></p>
            </div>
            <button className="btn btn-secondary btn-sm btn-icon" onClick={() => setSelectedProduct(null)}>
              <X size={14} />
            </button>
          </div>
          <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
            <span className={`badge ${selectedProduct.status === 'active' ? 'badge-success' : 'badge-muted'}`}>
              {selectedProduct.status}
            </span>
            <span className="badge badge-info">{selectedProduct.feed_name}</span>
          </div>
          <div style={{ maxHeight: 'calc(100vh - 280px)', overflowY: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', padding: '8px 12px', background: 'rgba(13,18,36,0.8)', color: '#64748b', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid rgba(79,110,247,0.1)', position: 'sticky', top: 0 }}>Attribute</th>
                  <th style={{ textAlign: 'left', padding: '8px 12px', background: 'rgba(13,18,36,0.8)', color: '#64748b', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid rgba(79,110,247,0.1)', position: 'sticky', top: 0 }}>Value</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(selectedProduct.raw_data || {}).map(([key, value]) => (
                  <tr key={key}>
                    <td style={{ padding: '8px 12px', borderBottom: '1px solid rgba(79,110,247,0.06)', color: '#94a3b8', fontWeight: 500, whiteSpace: 'nowrap', verticalAlign: 'top' }}>{key}</td>
                    <td style={{ padding: '8px 12px', borderBottom: '1px solid rgba(79,110,247,0.06)', color: '#e2e8f0', wordBreak: 'break-word' }}>
                      {String(value || '—')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 11, color: '#475569' }}>Last updated: {new Date(selectedProduct.last_updated_at).toLocaleString()}</span>
            {isAdmin && (
              <button className="btn btn-danger btn-sm" onClick={() => handleDeleteProduct(selectedProduct.id, selectedProduct.sku)}>
                <Trash2 size={12} /> Delete Product
              </button>
            )}
          </div>
      </Modal>
    )}
    </>
  );
}
