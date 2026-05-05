import { useEffect, useState, useCallback } from 'react';
import { api } from '../lib/api';
import { Package, Search, RefreshCw } from 'lucide-react';

interface Product {
  id: string; sku: string; feed_name: string; status: string;
  fingerprint: string; last_updated_at: string; raw_data: Record<string, string>;
}

export default function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const limit = 50;

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const fetchProducts = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(limit) });
      if (debouncedSearch) params.set('search', debouncedSearch);
      const data = await api.get(`/products?${params}`) as { products: Product[]; total: number };
      setProducts(data.products);
      setTotal(data.total);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [page, debouncedSearch]);

  useEffect(() => { fetchProducts(); }, [fetchProducts]);

  const totalPages = Math.ceil(total / limit);

  return (
    <div className="animate-fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Products</h1>
          <p className="page-subtitle">{total.toLocaleString()} products imported from feeds</p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <div style={{ position: 'relative' }}>
            <Search size={14} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#475569' }} />
            <input
              className="input"
              style={{ paddingLeft: 34, width: 240 }}
              placeholder="Search by SKU..."
              value={search}
              onChange={e => { setSearch(e.target.value); setPage(1); }}
            />
          </div>
          <button className="btn btn-secondary btn-sm btn-icon" onClick={fetchProducts} title="Refresh">
            <RefreshCw size={14} className={loading ? 'spinner' : ''} />
          </button>
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
                  </tr>
                </thead>
                <tbody>
                  {products.map(product => (
                    <tr key={product.id}>
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
  );
}
