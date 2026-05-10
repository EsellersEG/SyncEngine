import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../hooks/useAuth';
import Modal from '../components/Modal';
import { Plus, Download, Trash2, Pencil, FileText, Settings } from 'lucide-react';

interface InvoiceItem {
  id?: string;
  description: string;
  quantity: number;
  unit_price: number;
  total: number;
}

interface Invoice {
  id: string;
  client_id: string;
  client_name: string;
  invoice_number: string;
  status: string;
  issue_date: string;
  due_date: string | null;
  currency: string;
  subtotal: number;
  tax_percent: number;
  tax_amount: number;
  total: number;
  notes: string | null;
  items?: InvoiceItem[];
  created_at: string;
}

interface Client { id: string; name: string; }

export default function InvoicesPage() {
  const { isAdmin } = useAuth();
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [editingInvoice, setEditingInvoice] = useState<Invoice | null>(null);
  const [viewInvoice, setViewInvoice] = useState<Invoice | null>(null);
  const [filterStatus, setFilterStatus] = useState('');
  const [filterClient, setFilterClient] = useState('');

  const [form, setForm] = useState({
    client_id: '', issue_date: new Date().toISOString().split('T')[0],
    due_date: '', currency: 'EGP', tax_percent: '14', notes: '',
  });
  const [items, setItems] = useState<{ description: string; quantity: string; unit_price: string }[]>([
    { description: '', quantity: '1', unit_price: '' }
  ]);

  const [companySettings, setCompanySettings] = useState({
    company_name: '', company_address: '', company_phone: '',
    company_email: '', company_tax_id: '', company_bank_details: '',
  });

  const [error, setError] = useState('');

  useEffect(() => {
    loadData();
  }, [filterStatus, filterClient]);

  async function loadData() {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filterStatus) params.set('status', filterStatus);
      if (filterClient) params.set('client_id', filterClient);
      const [inv, cl] = await Promise.all([
        api.get(`/invoices?${params.toString()}`),
        api.get('/clients'),
      ]);
      setInvoices(inv as Invoice[]);
      setClients(cl as Client[]);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    const validItems = items.filter(i => i.description && i.unit_price);
    if (!form.client_id || validItems.length === 0) {
      setError('Client and at least one item with description and price required');
      return;
    }

    const payload = {
      ...form,
      tax_percent: parseFloat(form.tax_percent) || 0,
      items: validItems.map(i => ({
        description: i.description,
        quantity: parseFloat(i.quantity) || 1,
        unit_price: parseFloat(i.unit_price) || 0,
      })),
    };

    try {
      if (editingInvoice) {
        const updated = await api.patch(`/invoices/${editingInvoice.id}`, payload) as Invoice;
        setInvoices(prev => prev.map(inv => inv.id === editingInvoice.id ? updated : inv));
      } else {
        const created = await api.post('/invoices', payload) as Invoice;
        setInvoices(prev => [created, ...prev]);
      }
      closeModal();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed');
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this invoice?')) return;
    await api.delete(`/invoices/${id}`);
    setInvoices(prev => prev.filter(i => i.id !== id));
  }

  async function handleStatusChange(id: string, status: string) {
    const updated = await api.patch(`/invoices/${id}`, { status }) as Invoice;
    setInvoices(prev => prev.map(i => i.id === id ? updated : i));
    if (viewInvoice?.id === id) setViewInvoice(updated);
  }

  async function handleDownloadPDF(id: string, invoiceNumber: string) {
    try {
      const token = localStorage.getItem('sync_engine_token');
      const resp = await fetch(`/api/invoices/${id}/pdf`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({}));
        throw new Error(errData.detail || errData.error || 'PDF download failed');
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${invoiceNumber}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error(err);
      alert(err instanceof Error ? err.message : 'Failed to download PDF');
    }
  }

  async function handleViewInvoice(id: string) {
    const inv = await api.get(`/invoices/${id}`) as Invoice;
    setViewInvoice(inv);
  }

  function openCreateModal() {
    setEditingInvoice(null);
    setForm({ client_id: '', issue_date: new Date().toISOString().split('T')[0], due_date: '', currency: 'EGP', tax_percent: '14', notes: '' });
    setItems([{ description: '', quantity: '1', unit_price: '' }]);
    setError('');
    setShowModal(true);
  }

  async function openEditModal(inv: Invoice) {
    const full = await api.get(`/invoices/${inv.id}`) as Invoice;
    setEditingInvoice(full);
    setForm({
      client_id: full.client_id, issue_date: full.issue_date?.split('T')[0] || '',
      due_date: full.due_date?.split('T')[0] || '', currency: full.currency || 'EGP',
      tax_percent: String(full.tax_percent || 0), notes: full.notes || '',
    });
    setItems((full.items || []).map(i => ({
      description: i.description, quantity: String(i.quantity), unit_price: String(i.unit_price),
    })));
    setError('');
    setShowModal(true);
  }

  function closeModal() {
    setShowModal(false);
    setEditingInvoice(null);
  }

  async function openSettings() {
    try {
      const s = await api.get('/invoices/settings/company') as Record<string, string>;
      setCompanySettings({
        company_name: s.company_name || '',
        company_address: s.company_address || '',
        company_phone: s.company_phone || '',
        company_email: s.company_email || '',
        company_tax_id: s.company_tax_id || '',
        company_bank_details: s.company_bank_details || '',
      });
    } catch { /* empty */ }
    setShowSettings(true);
  }

  async function saveSettings(e: React.FormEvent) {
    e.preventDefault();
    await api.put('/invoices/settings/company', companySettings);
    setShowSettings(false);
  }

  function addItem() {
    setItems(prev => [...prev, { description: '', quantity: '1', unit_price: '' }]);
  }

  function removeItem(idx: number) {
    setItems(prev => prev.filter((_, i) => i !== idx));
  }

  function updateItem(idx: number, field: string, value: string) {
    setItems(prev => prev.map((item, i) => i === idx ? { ...item, [field]: value } : item));
  }

  const subtotal = items.reduce((sum, i) => sum + (parseFloat(i.quantity) || 0) * (parseFloat(i.unit_price) || 0), 0);
  const taxAmt = subtotal * ((parseFloat(form.tax_percent) || 0) / 100);
  const totalAmt = subtotal + taxAmt;

  const statusColors: Record<string, string> = {
    draft: '#94a3b8',
    sent: '#3b82f6',
    paid: '#22c55e',
    overdue: '#ef4444',
  };

  return (
    <>
      <div className="animate-fade-in">
        <div className="page-header">
          <div>
            <h1 className="page-title">Invoices</h1>
            <p style={{ color: '#64748b', fontSize: 14 }}>Create and manage client invoices</p>
          </div>
          {isAdmin && (
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-secondary" onClick={openSettings}>
                <Settings size={14} /> Company Settings
              </button>
              <button className="btn btn-primary" onClick={openCreateModal}>
                <Plus size={14} /> New Invoice
              </button>
            </div>
          )}
        </div>

        {/* Filters */}
        <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
          <select className="input" style={{ width: 180 }} value={filterClient} onChange={e => setFilterClient(e.target.value)}>
            <option value="">All Clients</option>
            {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select className="input" style={{ width: 150 }} value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
            <option value="">All Statuses</option>
            <option value="draft">Draft</option>
            <option value="sent">Sent</option>
            <option value="paid">Paid</option>
            <option value="overdue">Overdue</option>
          </select>
        </div>

        {/* Summary Cards */}
        {isAdmin && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 24 }}>
            <div className="card" style={{ padding: 16, textAlign: 'center' }}>
              <div style={{ fontSize: 11, color: '#64748b', textTransform: 'uppercase', marginBottom: 4 }}>Total Invoices</div>
              <div style={{ fontSize: 24, fontWeight: 700, color: '#f1f5f9' }}>{invoices.length}</div>
            </div>
            <div className="card" style={{ padding: 16, textAlign: 'center' }}>
              <div style={{ fontSize: 11, color: '#64748b', textTransform: 'uppercase', marginBottom: 4 }}>Outstanding</div>
              <div style={{ fontSize: 24, fontWeight: 700, color: '#ffa500' }}>
                {invoices.filter(i => i.status !== 'paid').reduce((s, i) => s + Number(i.total), 0).toFixed(2)}
              </div>
            </div>
            <div className="card" style={{ padding: 16, textAlign: 'center' }}>
              <div style={{ fontSize: 11, color: '#64748b', textTransform: 'uppercase', marginBottom: 4 }}>Paid</div>
              <div style={{ fontSize: 24, fontWeight: 700, color: '#22c55e' }}>
                {invoices.filter(i => i.status === 'paid').reduce((s, i) => s + Number(i.total), 0).toFixed(2)}
              </div>
            </div>
          </div>
        )}

        {/* Table */}
        {loading ? (
          <div style={{ textAlign: 'center', padding: 40, color: '#64748b' }}>Loading...</div>
        ) : invoices.length === 0 ? (
          <div className="card" style={{ textAlign: 'center', padding: 40 }}>
            <FileText size={40} color="#334155" />
            <p style={{ color: '#64748b', marginTop: 12 }}>No invoices yet</p>
          </div>
        ) : (
          <div className="card" style={{ overflow: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid rgba(255,165,0,0.1)' }}>
                  <th style={{ padding: '12px 16px', textAlign: 'left', color: '#64748b', fontWeight: 600 }}>#</th>
                  <th style={{ padding: '12px 16px', textAlign: 'left', color: '#64748b', fontWeight: 600 }}>Client</th>
                  <th style={{ padding: '12px 16px', textAlign: 'left', color: '#64748b', fontWeight: 600 }}>Date</th>
                  <th style={{ padding: '12px 16px', textAlign: 'right', color: '#64748b', fontWeight: 600 }}>Total</th>
                  <th style={{ padding: '12px 16px', textAlign: 'center', color: '#64748b', fontWeight: 600 }}>Status</th>
                  <th style={{ padding: '12px 16px', textAlign: 'right', color: '#64748b', fontWeight: 600 }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map(inv => (
                  <tr key={inv.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                    <td style={{ padding: '10px 16px', fontWeight: 600, color: '#ffa500' }}>{inv.invoice_number}</td>
                    <td style={{ padding: '10px 16px', color: '#e2e8f0' }}>{inv.client_name}</td>
                    <td style={{ padding: '10px 16px', color: '#94a3b8' }}>{inv.issue_date?.split('T')[0]}</td>
                    <td style={{ padding: '10px 16px', textAlign: 'right', fontWeight: 600, color: '#f1f5f9' }}>
                      {inv.currency} {Number(inv.total).toFixed(2)}
                    </td>
                    <td style={{ padding: '10px 16px', textAlign: 'center' }}>
                      <span style={{
                        padding: '3px 10px', borderRadius: 12, fontSize: 11, fontWeight: 600,
                        background: `${statusColors[inv.status] || '#64748b'}22`,
                        color: statusColors[inv.status] || '#64748b',
                        border: `1px solid ${statusColors[inv.status] || '#64748b'}44`,
                      }}>
                        {inv.status.toUpperCase()}
                      </span>
                    </td>
                    <td style={{ padding: '10px 16px', textAlign: 'right' }}>
                      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                        <button className="btn btn-secondary btn-sm btn-icon" onClick={() => handleViewInvoice(inv.id)} title="View">
                          <FileText size={12} />
                        </button>
                        {isAdmin && (
                          <>
                            <button className="btn btn-secondary btn-sm btn-icon" onClick={() => openEditModal(inv)} title="Edit">
                              <Pencil size={12} />
                            </button>
                            <button className="btn btn-secondary btn-sm btn-icon" onClick={() => handleDownloadPDF(inv.id, inv.invoice_number)} title="Download PDF">
                              <Download size={12} />
                            </button>
                            <button className="btn btn-danger btn-sm btn-icon" onClick={() => handleDelete(inv.id)} title="Delete">
                              <Trash2 size={12} />
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Create/Edit Invoice Modal ── */}
      <Modal open={showModal} onClose={closeModal} maxWidth={700}>
        <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>{editingInvoice ? 'Edit Invoice' : 'New Invoice'}</h2>
        <p style={{ color: '#64748b', fontSize: 13, marginBottom: 20 }}>Fill in the invoice details below</p>
        <form onSubmit={handleSubmit}>
          {error && <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#f87171', marginBottom: 16 }}>{error}</div>}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
            <div className="form-group">
              <label className="label">Client</label>
              <select className="input" value={form.client_id} onChange={e => setForm(f => ({ ...f, client_id: e.target.value }))} required>
                <option value="">Select client...</option>
                {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="label">Currency</label>
              <select className="input" value={form.currency} onChange={e => setForm(f => ({ ...f, currency: e.target.value }))}>
                <option value="EGP">EGP</option>
                <option value="USD">USD</option>
                <option value="EUR">EUR</option>
                <option value="GBP">GBP</option>
                <option value="SAR">SAR</option>
                <option value="AED">AED</option>
              </select>
            </div>
            <div className="form-group">
              <label className="label">Issue Date</label>
              <input className="input" type="date" value={form.issue_date} onChange={e => setForm(f => ({ ...f, issue_date: e.target.value }))} />
            </div>
            <div className="form-group">
              <label className="label">Due Date</label>
              <input className="input" type="date" value={form.due_date} onChange={e => setForm(f => ({ ...f, due_date: e.target.value }))} />
            </div>
            <div className="form-group">
              <label className="label">Tax %</label>
              <input className="input" type="number" min="0" step="0.01" value={form.tax_percent} onChange={e => setForm(f => ({ ...f, tax_percent: e.target.value }))} />
            </div>
          </div>

          {/* Line Items */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <label className="label" style={{ margin: 0 }}>Line Items</label>
              <button type="button" className="btn btn-secondary btn-sm" onClick={addItem}><Plus size={12} /> Add Item</button>
            </div>
            <div style={{ display: 'grid', gap: 8 }}>
              {items.map((item, idx) => (
                <div key={idx} style={{ display: 'grid', gridTemplateColumns: '2fr 60px 100px 30px', gap: 8, alignItems: 'center' }}>
                  <input className="input" placeholder="Description" value={item.description}
                    onChange={e => updateItem(idx, 'description', e.target.value)} />
                  <input className="input" type="number" min="1" placeholder="Qty" value={item.quantity}
                    onChange={e => updateItem(idx, 'quantity', e.target.value)} />
                  <input className="input" type="number" min="0" step="0.01" placeholder="Price" value={item.unit_price}
                    onChange={e => updateItem(idx, 'unit_price', e.target.value)} />
                  {items.length > 1 && (
                    <button type="button" style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', padding: 4 }}
                      onClick={() => removeItem(idx)}>✕</button>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Totals preview */}
          <div style={{ background: 'rgba(255,165,0,0.05)', border: '1px solid rgba(255,165,0,0.15)', borderRadius: 8, padding: 12, marginBottom: 16, fontSize: 13 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
              <span style={{ color: '#94a3b8' }}>Subtotal:</span>
              <span style={{ color: '#e2e8f0' }}>{form.currency} {subtotal.toFixed(2)}</span>
            </div>
            {parseFloat(form.tax_percent) > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ color: '#94a3b8' }}>Tax ({form.tax_percent}%):</span>
                <span style={{ color: '#e2e8f0' }}>{form.currency} {taxAmt.toFixed(2)}</span>
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, borderTop: '1px solid rgba(255,165,0,0.2)', paddingTop: 8, marginTop: 4 }}>
              <span style={{ color: '#ffa500' }}>Total:</span>
              <span style={{ color: '#ffa500' }}>{form.currency} {totalAmt.toFixed(2)}</span>
            </div>
          </div>

          <div className="form-group">
            <label className="label">Notes</label>
            <textarea className="input" rows={3} value={form.notes} placeholder="Payment terms, additional info..."
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
          </div>

          <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
            <button type="button" className="btn btn-secondary" style={{ flex: 1 }} onClick={closeModal}>Cancel</button>
            <button type="submit" className="btn btn-primary" style={{ flex: 1 }}>{editingInvoice ? 'Save Changes' : 'Create Invoice'}</button>
          </div>
        </form>
      </Modal>

      {/* ── View Invoice Modal ── */}
      <Modal open={!!viewInvoice} onClose={() => setViewInvoice(null)} maxWidth={600}>
        {viewInvoice && (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
              <div>
                <h2 style={{ fontSize: 18, fontWeight: 700 }}>{viewInvoice.invoice_number}</h2>
                <p style={{ color: '#64748b', fontSize: 13 }}>{viewInvoice.client_name}</p>
              </div>
              <span style={{
                padding: '4px 12px', borderRadius: 12, fontSize: 11, fontWeight: 600,
                background: `${statusColors[viewInvoice.status]}22`,
                color: statusColors[viewInvoice.status],
                border: `1px solid ${statusColors[viewInvoice.status]}44`,
              }}>
                {viewInvoice.status.toUpperCase()}
              </span>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20, fontSize: 13 }}>
              <div><span style={{ color: '#64748b' }}>Issue Date:</span> <span style={{ color: '#e2e8f0' }}>{viewInvoice.issue_date?.split('T')[0]}</span></div>
              {viewInvoice.due_date && <div><span style={{ color: '#64748b' }}>Due Date:</span> <span style={{ color: '#e2e8f0' }}>{viewInvoice.due_date?.split('T')[0]}</span></div>}
            </div>

            {/* Items */}
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginBottom: 16 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid rgba(255,165,0,0.15)' }}>
                  <th style={{ padding: 8, textAlign: 'left', color: '#64748b' }}>Description</th>
                  <th style={{ padding: 8, textAlign: 'center', color: '#64748b' }}>Qty</th>
                  <th style={{ padding: 8, textAlign: 'right', color: '#64748b' }}>Price</th>
                  <th style={{ padding: 8, textAlign: 'right', color: '#64748b' }}>Total</th>
                </tr>
              </thead>
              <tbody>
                {(viewInvoice.items || []).map((item, idx) => (
                  <tr key={idx} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                    <td style={{ padding: 8, color: '#e2e8f0' }}>{item.description}</td>
                    <td style={{ padding: 8, textAlign: 'center', color: '#94a3b8' }}>{item.quantity}</td>
                    <td style={{ padding: 8, textAlign: 'right', color: '#94a3b8' }}>{Number(item.unit_price).toFixed(2)}</td>
                    <td style={{ padding: 8, textAlign: 'right', color: '#e2e8f0', fontWeight: 600 }}>{Number(item.total).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Totals */}
            <div style={{ background: 'rgba(255,165,0,0.05)', borderRadius: 8, padding: 12, fontSize: 13, marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ color: '#94a3b8' }}>Subtotal:</span>
                <span style={{ color: '#e2e8f0' }}>{viewInvoice.currency} {Number(viewInvoice.subtotal).toFixed(2)}</span>
              </div>
              {viewInvoice.tax_percent > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span style={{ color: '#94a3b8' }}>Tax ({viewInvoice.tax_percent}%):</span>
                  <span style={{ color: '#e2e8f0' }}>{viewInvoice.currency} {Number(viewInvoice.tax_amount).toFixed(2)}</span>
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, borderTop: '1px solid rgba(255,165,0,0.2)', paddingTop: 8, marginTop: 4 }}>
                <span style={{ color: '#ffa500' }}>Total:</span>
                <span style={{ color: '#ffa500' }}>{viewInvoice.currency} {Number(viewInvoice.total).toFixed(2)}</span>
              </div>
            </div>

            {viewInvoice.notes && (
              <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 16 }}>
                <strong style={{ color: '#64748b' }}>Notes:</strong> {viewInvoice.notes}
              </div>
            )}

            {/* Actions */}
            {isAdmin && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {viewInvoice.status === 'draft' && (
                  <button className="btn btn-secondary btn-sm" onClick={() => handleStatusChange(viewInvoice.id, 'sent')}>Mark as Sent</button>
                )}
                {(viewInvoice.status === 'sent' || viewInvoice.status === 'overdue') && (
                  <button className="btn btn-primary btn-sm" onClick={() => handleStatusChange(viewInvoice.id, 'paid')}>Mark as Paid</button>
                )}
                {viewInvoice.status === 'sent' && (
                  <button className="btn btn-danger btn-sm" onClick={() => handleStatusChange(viewInvoice.id, 'overdue')}>Mark Overdue</button>
                )}
                <button className="btn btn-secondary btn-sm" onClick={() => handleDownloadPDF(viewInvoice.id, viewInvoice.invoice_number)}>
                  <Download size={12} /> Download PDF
                </button>
              </div>
            )}
          </>
        )}
      </Modal>

      {/* ── Company Settings Modal ── */}
      <Modal open={showSettings} onClose={() => setShowSettings(false)} maxWidth={500}>
        <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>Company Settings</h2>
        <p style={{ color: '#64748b', fontSize: 13, marginBottom: 20 }}>This info appears on your PDF invoices</p>
        <form onSubmit={saveSettings}>
          <div className="form-group">
            <label className="label">Company Name</label>
            <input className="input" value={companySettings.company_name}
              onChange={e => setCompanySettings(s => ({ ...s, company_name: e.target.value }))} />
          </div>
          <div className="form-group">
            <label className="label">Address</label>
            <textarea className="input" rows={2} value={companySettings.company_address}
              onChange={e => setCompanySettings(s => ({ ...s, company_address: e.target.value }))} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div className="form-group">
              <label className="label">Phone</label>
              <input className="input" value={companySettings.company_phone}
                onChange={e => setCompanySettings(s => ({ ...s, company_phone: e.target.value }))} />
            </div>
            <div className="form-group">
              <label className="label">Email</label>
              <input className="input" value={companySettings.company_email}
                onChange={e => setCompanySettings(s => ({ ...s, company_email: e.target.value }))} />
            </div>
          </div>
          <div className="form-group">
            <label className="label">Tax ID</label>
            <input className="input" value={companySettings.company_tax_id}
              onChange={e => setCompanySettings(s => ({ ...s, company_tax_id: e.target.value }))} />
          </div>
          <div className="form-group">
            <label className="label">Bank / Payment Details</label>
            <textarea className="input" rows={3} placeholder="Bank name, account number, IBAN, etc."
              value={companySettings.company_bank_details}
              onChange={e => setCompanySettings(s => ({ ...s, company_bank_details: e.target.value }))} />
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
            <button type="button" className="btn btn-secondary" style={{ flex: 1 }} onClick={() => setShowSettings(false)}>Cancel</button>
            <button type="submit" className="btn btn-primary" style={{ flex: 1 }}>Save Settings</button>
          </div>
        </form>
      </Modal>
    </>
  );
}
