import { useEffect, useState, useRef, useCallback } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../hooks/useAuth';
import { Zap, Play, XCircle, RefreshCw, CheckCircle, AlertTriangle, Clock, ChevronDown, ChevronUp, Plus, Trash2, Filter, ArrowLeft, Eye, Download, FileText } from 'lucide-react';

interface Channel { id: string; name: string; type: string; client_id: string; }
interface Feed { id: string; name: string; client_id: string; type?: string; }
interface SyncJob {
  id: string; channel_id: string; channel_name: string; feed_id: string;
  preset: string; status: string; total_products: number;
  created_count: number; updated_count: number; failed_count: number; skipped_count: number;
  started_at: string | null; completed_at: string | null; created_at: string;
  triggered_by_name: string; error_message: string | null;
}
interface SyncLog {
  id: string; sku: string; action: string; message: string; created_at: string;
  details?: { stock_from?: number | null; stock_to?: number | null; price_from?: string | null; price_to?: string | null; warehouse_name?: string | null };
}
interface ContentJob {
  id: string; channel_id: string; feed_id: string; status: string;
  total_products: number; processed_count: number; updated_count: number;
  error_message?: string; created_at: string; completed_at?: string;
}
interface FilterRule {
  field: string; operator: string; value: string; logic?: string;
}

const PRESETS = [
  { value: 'price_stock_meta', label: '⚡ Price + Stock + Meta', desc: 'Turbo Mode — ~5-10 min for 10K products' },
  { value: 'sync_all_no_images', label: '🔄 Sync All (No Images)', desc: 'Bulk Ops + Turbo — ~10-15 min' },
  { value: 'sync_all', label: '🚀 Sync All', desc: 'Full catalog sync — ~20-30 min' },
  { value: 'custom', label: '⚙️ Custom', desc: 'Select specific fields to sync' },
];

const CUSTOM_FIELDS = [
  { value: 'stock', label: 'Stock' },
  { value: 'price', label: 'Price' },
  { value: 'tags', label: 'Tags' },
  { value: 'status', label: 'Status' },
  { value: 'images', label: 'Images' },
  { value: 'metafields', label: 'Metafields' },
  { value: 'title', label: 'Title' },
  { value: 'body_html', label: 'Description' },
  { value: 'vendor', label: 'Vendor' },
  { value: 'product_type', label: 'Product Type' },
];

const OPERATORS = [
  { value: 'equals', label: 'Equals' },
  { value: 'not_equals', label: 'Not Equals' },
  { value: 'greater_than', label: 'Greater Than' },
  { value: 'less_than', label: 'Less Than' },
  { value: 'greater_or_equal', label: 'Greater or Equal' },
  { value: 'less_or_equal', label: 'Less or Equal' },
  { value: 'contains', label: 'Contains' },
  { value: 'not_contains', label: 'Not Contains' },
  { value: 'equals_any', label: 'Equals Any (Multi-value)' },
  { value: 'not_equals_any', label: 'Not Equals Any (Multi-value)' },
  { value: 'starts_with', label: 'Starts With' },
  { value: 'ends_with', label: 'Ends With' },
  { value: 'is_empty', label: 'Is Empty' },
  { value: 'is_not_empty', label: 'Is Not Empty' },
];

type View = 'main' | 'history' | 'validation' | 'filter-rules' | 'content';

export default function SyncPage() {
  const { user, isClient } = useAuth();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [jobs, setJobs] = useState<SyncJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [view, setView] = useState<View>('main');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Content sync state
  const [contentJobs, setContentJobs] = useState<ContentJob[]>([]);
  const [contentStarting, setContentStarting] = useState(false);
  const [contentConfig, setContentConfig] = useState({ channel_id: '', feed_id: '' });
  const contentPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Sync config
  const [config, setConfig] = useState({ channel_id: '', feed_id: '', preset: 'sync_all' });
  const [customFields, setCustomFields] = useState<string[]>([]);
  const [filterRules, setFilterRules] = useState<FilterRule[]>([]);
  const [feedHeaders, setFeedHeaders] = useState<string[]>([]);
  const [filterPreview, setFilterPreview] = useState<{ total: number; matched: number; filtered: number } | null>(null);
  const [mappingCount, setMappingCount] = useState<number | null>(null);
  const [includeImages, setIncludeImages] = useState(false);

  // History state
  const [historyJobs, setHistoryJobs] = useState<SyncJob[]>([]);

  // Validation state
  const [validationJobId, setValidationJobId] = useState('');
  const [validationLogs, setValidationLogs] = useState<SyncLog[]>([]);
  const [validationTotal, setValidationTotal] = useState(0);
  const [validationPage, setValidationPage] = useState(1);
  const [validationFilter, setValidationFilter] = useState('all');
  const [validationCounts, setValidationCounts] = useState<Array<{ action: string; count: number }>>([]);
  const [validationLoading, setValidationLoading] = useState(false);

  useEffect(() => {
    Promise.all([api.get('/channels'), api.get('/feeds'), api.get('/sync/jobs?limit=50')])
      .then(([ch, f, j]) => { setChannels(ch as Channel[]); setFeeds(f as Feed[]); setJobs(j as SyncJob[]); setHistoryJobs(j as SyncJob[]); })
      .finally(() => setLoading(false));

    pollRef.current = setInterval(() => {
      api.get('/sync/jobs?limit=50').then((j: unknown) => { setJobs(j as SyncJob[]); setHistoryJobs(j as SyncJob[]); }).catch(() => {});
    }, 5000);

    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  // Load feed headers when feed changes
  useEffect(() => {
    if (config.feed_id) {
      api.get(`/sync/feed-headers/${config.feed_id}`).then((r: { headers: string[] }) => setFeedHeaders(r.headers)).catch(() => {});
    }
  }, [config.feed_id]);

  const selectedFeed = feeds.find(f => f.id === config.feed_id);

  useEffect(() => {
    if (selectedFeed?.type === 'odoo' && config.preset !== 'price_stock_meta') {
      setConfig(prev => ({ ...prev, preset: 'price_stock_meta' }));
      setCustomFields([]);
    }
  }, [selectedFeed, config.preset]);

  // Check mapping count when feed+channel are selected
  useEffect(() => {
    if (config.feed_id && config.channel_id) {
      api.get(`/mappings?feed_id=${config.feed_id}&channel_id=${config.channel_id}`)
        .then((m: unknown[]) => setMappingCount(m.length))
        .catch(() => setMappingCount(null));
    } else {
      setMappingCount(null);
    }
  }, [config.feed_id, config.channel_id]);

  async function handleStart(e: React.FormEvent) {
    e.preventDefault();
    setStarting(true);
    try {
      const body: Record<string, unknown> = { ...config };
      if (config.preset === 'custom') body.fields = customFields;
      if (filterRules.length > 0) body.filter_rules = filterRules;
      // Include images toggle for Shopify and Amazon
      const selectedCh = channels.find(ch => ch.id === config.channel_id);
      if ((selectedCh?.type === 'amazon' || selectedCh?.type === 'shopify') && includeImages) body.include_images = true;
      await api.post('/sync/start', body);
      const updated = await api.get('/sync/jobs?limit=50') as SyncJob[];
      setJobs(updated);
      setHistoryJobs(updated);
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Failed to start sync');
    } finally {
      setStarting(false);
    }
  }

  async function handleCancel(jobId: string) {
    await api.post(`/sync/jobs/${jobId}/cancel`, {});
    setJobs(prev => prev.map(j => j.id === jobId ? { ...j, status: 'cancelled' } : j));
  }

  async function handleExportCSV() {
    if (!validationJobId) return;
    try {
      const token = localStorage.getItem('sync_engine_token');
      const params = validationFilter !== 'all' ? `?action=${validationFilter}` : '';
      const res = await fetch(`/api/sync/jobs/${validationJobId}/export${params}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) { alert('Export failed'); return; }
      const blob = await res.blob();
      const disposition = res.headers.get('Content-Disposition') || '';
      const nameMatch = disposition.match(/filename="(.+)"/);
      const filename = nameMatch ? nameMatch[1] : 'sync-export.csv';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      alert('Export failed: ' + (err instanceof Error ? err.message : String(err)));
    }
  }

  async function previewFilter() {
    try {
      const result = await api.post('/sync/preview-filter', { feed_id: config.feed_id, filter_rules: filterRules }) as { total: number; matched: number; filtered: number };
      setFilterPreview(result);
    } catch { /* ignore */ }
  }

  const fetchValidationLogs = useCallback(async () => {
    if (!validationJobId) return;
    setValidationLoading(true);
    try {
      const params = new URLSearchParams({ page: String(validationPage), limit: '50' });
      if (validationFilter !== 'all') params.set('action', validationFilter);
      const result = await api.get(`/sync/jobs/${validationJobId}/logs?${params}`) as {
        logs: SyncLog[]; total: number; counts: Array<{ action: string; count: number }>; page: number;
      };
      setValidationLogs(result.logs);
      setValidationTotal(result.total);
      setValidationCounts(result.counts);
    } catch { /* ignore */ }
    setValidationLoading(false);
  }, [validationJobId, validationPage, validationFilter]);

  useEffect(() => { fetchValidationLogs(); }, [fetchValidationLogs]);

  // Poll content jobs while in content view
  useEffect(() => {
    if (view !== 'content' || !contentConfig.channel_id) return;
    const channelId = contentConfig.channel_id;
    const load = async () => {
      try {
        const jobs = await api.get(`/noon/content/jobs?channel_id=${channelId}`) as ContentJob[];
        setContentJobs(jobs);
      } catch { /* ignore */ }
    };
    load();
    const timer = setInterval(load, 4000);
    return () => clearInterval(timer);
  }, [view, contentConfig.channel_id]);

  function toggleCustomField(field: string) {
    setCustomFields(prev => prev.includes(field) ? prev.filter(f => f !== field) : [...prev, field]);
  }

  function addRule() {
    setFilterRules(prev => [...prev, { field: '', operator: 'equals', value: '' }]);
  }

  function updateRule(index: number, updates: Partial<FilterRule>) {
    setFilterRules(prev => prev.map((r, i) => i === index ? { ...r, ...updates } : r));
  }

  function removeRule(index: number) {
    setFilterRules(prev => prev.filter((_, i) => i !== index));
  }

  async function loadContentJobs(channelId: string) {
    if (!channelId) return;
    try {
      const jobs = await api.get(`/noon/content/jobs?channel_id=${channelId}`) as ContentJob[];
      setContentJobs(jobs);
    } catch { /* ignore */ }
  }

  async function handleContentSync(e: React.FormEvent) {
    e.preventDefault();
    setContentStarting(true);
    try {
      await api.post('/noon/content/start', { channel_id: contentConfig.channel_id, feed_id: contentConfig.feed_id });
      await loadContentJobs(contentConfig.channel_id);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to start content sync');
    } finally {
      setContentStarting(false);
    }
  }

  async function handleDownloadContentCSV(jobId: string, channelName: string) {
    try {
      const token = localStorage.getItem('sync_engine_token');
      const res = await fetch(`/api/noon/content/${jobId}/download`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) { alert('Download failed'); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `noon-content-${channelName}-${jobId}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      alert('Download failed: ' + (err instanceof Error ? err.message : String(err)));
    }
  }

  const shopifyChannels = channels.filter(ch => ch.type === 'shopify' || ch.type === 'noon' || ch.type === 'amazon');

  function getDuration(job: SyncJob): string {
    if (!job.started_at || (job.status !== 'completed' && job.status !== 'failed')) return '-';
    const end = job.completed_at ? new Date(job.completed_at) : new Date();
    const totalSeconds = Math.max(0, Math.round((end.getTime() - new Date(job.started_at).getTime()) / 1000));
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    return `${h}H ${m}M ${s}S`;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // VIEW: Filter Rules
  // ─────────────────────────────────────────────────────────────────────────
  if (view === 'filter-rules') {
    return (
      <>
      <div className="animate-fade-in">
        <div className="page-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button className="btn btn-secondary btn-sm btn-icon" onClick={() => setView('main')}><ArrowLeft size={14} /></button>
            <div>
              <h1 className="page-title">Filter Rules</h1>
              <p className="page-subtitle">Control which products are synced to Shopify</p>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn btn-secondary btn-sm" onClick={addRule}><Plus size={12} /> Add Rule</button>
            <button className="btn btn-danger btn-sm" onClick={() => setFilterRules([])}>Clear All Rules</button>
            <button className="btn btn-primary btn-sm" onClick={() => setView('main')}>Save Rules</button>
          </div>
        </div>
        <div className="page-body">
          {/* Info Box */}
          <div className="glass-card" style={{ padding: 16, marginBottom: 20, borderColor: 'rgba(59,130,246,0.3)' }}>
            <span style={{ fontSize: 13, color: '#94a3b8' }}>
              <strong style={{ color: '#60a5fa' }}>How rules work:</strong> Only products that match ALL conditions will be synced to Shopify. Use OR between rules to create alternative conditions.
            </span>
          </div>

          {/* Preview */}
          {config.feed_id && (
            <div className="glass-card" style={{ padding: 20, marginBottom: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, color: '#e2e8f0', marginBottom: 12 }}>Products Preview</div>
                <div style={{ display: 'flex', gap: 32 }}>
                  <div>
                    <div style={{ fontSize: 11, color: '#64748b' }}>Total in Sheet</div>
                    <div style={{ fontSize: 24, fontWeight: 700, color: '#e2e8f0' }}>{filterPreview?.total?.toLocaleString() || '—'}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: '#64748b' }}>Will Be Synced</div>
                    <div style={{ fontSize: 24, fontWeight: 700, color: '#60a5fa' }}>{filterPreview?.matched?.toLocaleString() || '—'}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: '#64748b' }}>Will Be Filtered Out</div>
                    <div style={{ fontSize: 24, fontWeight: 700, color: '#f87171' }}>{filterPreview?.filtered?.toLocaleString() || '—'}</div>
                  </div>
                </div>
              </div>
              <button className="btn btn-secondary btn-sm" onClick={previewFilter}>Calculate Preview</button>
            </div>
          )}

          {/* Active Rules */}
          <div className="glass-card" style={{ padding: 20 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#e2e8f0', marginBottom: 16 }}>Active Rules ({filterRules.length})</div>
            {filterRules.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 32, color: '#475569', fontSize: 14 }}>
                No filter rules — all products will be synced.
                <div style={{ marginTop: 12 }}>
                  <button className="btn btn-secondary btn-sm" onClick={addRule}><Plus size={12} /> Add Rule</button>
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                {filterRules.map((rule, idx) => (
                  <div key={idx} style={{ padding: 16, border: '1px solid rgba(79,110,247,0.2)', borderRadius: 12, background: 'rgba(13,18,36,0.5)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                      <span className="badge badge-info">Rule {idx + 1}</span>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        {idx > 0 && (
                          <select className="input" style={{ width: 80, padding: '4px 8px', fontSize: 12 }}
                            value={rule.logic || 'and'}
                            onChange={e => updateRule(idx, { logic: e.target.value })}>
                            <option value="and">AND</option>
                            <option value="or">OR</option>
                          </select>
                        )}
                        <button className="btn btn-danger btn-sm" style={{ padding: '4px 8px' }} onClick={() => removeRule(idx)}>
                          <Trash2 size={12} /> Remove
                        </button>
                      </div>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
                      <div className="form-group">
                        <label className="label">Field</label>
                        <select className="input" value={rule.field} onChange={e => updateRule(idx, { field: e.target.value })}>
                          <option value="">Select field...</option>
                          {feedHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                        </select>
                      </div>
                      <div className="form-group">
                        <label className="label">Operator</label>
                        <select className="input" value={rule.operator} onChange={e => updateRule(idx, { operator: e.target.value })}>
                          {OPERATORS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      </div>
                      <div className="form-group">
                        <label className="label">Value</label>
                        <input className="input" placeholder="Enter value..."
                          value={rule.value} onChange={e => updateRule(idx, { value: e.target.value })}
                          disabled={rule.operator === 'is_empty' || rule.operator === 'is_not_empty'} />
                      </div>
                    </div>
                  </div>
                ))}
                <button className="btn btn-secondary btn-sm" style={{ alignSelf: 'flex-start' }} onClick={addRule}><Plus size={12} /> Add Another Rule</button>
              </div>
            )}
          </div>
        </div>
      </div>
      </>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // VIEW: Sync History
  // ─────────────────────────────────────────────────────────────────────────
  if (view === 'history') {
    return (
      <div className="animate-fade-in">
        <div className="page-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button className="btn btn-secondary btn-sm btn-icon" onClick={() => setView('main')}><ArrowLeft size={14} /></button>
            <div>
              <h1 className="page-title">Sync History</h1>
              <p className="page-subtitle">View all product sync operations</p>
            </div>
          </div>
        </div>
        <div className="page-body">
          <div className="glass-card" style={{ padding: 20 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#e2e8f0', marginBottom: 16 }}>
              Recent Syncs ({historyJobs.length})
            </div>
            <div className="table-container">
              <table className="table">
                <thead>
                  <tr>
                    <th>Date & Time</th>
                    <th>Status</th>
                    <th>Sync Type</th>
                    <th>Progress</th>
                    <th>Created</th>
                    <th>Updated</th>
                    <th>Skipped</th>
                    <th>Failed</th>
                    <th>Duration</th>
                    <th>Error</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {historyJobs.map(job => (
                    <tr key={job.id}>
                      <td style={{ fontSize: 12, color: '#94a3b8', whiteSpace: 'nowrap' }}>{new Date(job.created_at).toLocaleString()}</td>
                      <td>
                        <span className={`badge ${
                          job.status === 'completed' ? 'badge-success' :
                          job.status === 'failed' ? 'badge-danger' :
                          job.status === 'running' ? 'badge-info' :
                          job.status === 'pending' ? 'badge-warning' : 'badge-muted'
                        }`}>{job.status === 'completed' && job.failed_count > 0 ? 'Partial' : job.status}</span>
                      </td>
                      <td><span className="badge badge-info">{job.preset === 'price_stock_meta' ? 'Price + Stock + Meta' : job.preset === 'sync_all_no_images' ? 'No Images' : job.preset === 'sync_all' ? 'Sync All' : 'Custom'}</span></td>
                      <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: '#94a3b8' }}>
                        {(job.created_count + job.updated_count + job.failed_count + job.skipped_count)}/{job.total_products}
                      </td>
                      <td style={{ fontSize: 13, color: '#4ade80' }}>{job.created_count}</td>
                      <td style={{ fontSize: 13, color: '#60a5fa' }}>{job.updated_count}</td>
                      <td style={{ fontSize: 13, color: '#94a3b8' }}>{job.skipped_count}</td>
                      <td style={{ fontSize: 13, color: '#f87171' }}>{job.failed_count}</td>
                      <td style={{ fontSize: 12, color: '#a78bfa', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>{getDuration(job)}</td>
                      <td style={{ fontSize: 11, color: '#f87171', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={job.error_message || ''}>
                        {job.error_message ? job.error_message.slice(0, 30) : '-'}
                      </td>
                      <td>
                        <button className="btn btn-secondary btn-sm" onClick={() => { setValidationJobId(job.id); setValidationPage(1); setView('validation'); }}>
                          <Eye size={11} /> Details
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // VIEW: Sync Validation
  // ─────────────────────────────────────────────────────────────────────────
  if (view === 'validation') {
    const totalPages = Math.ceil(validationTotal / 50);
    const selectedJob = jobs.find(j => j.id === validationJobId);
    return (
      <div className="animate-fade-in">
        <div className="page-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button className="btn btn-secondary btn-sm btn-icon" onClick={() => setView('history')}><ArrowLeft size={14} /></button>
            <div>
              <h1 className="page-title">Sync Validation</h1>
              <p className="page-subtitle">View detailed results for each product across all syncs</p>
            </div>
          </div>
          {validationJobId && (
            <button
              className="btn btn-secondary btn-sm"
              style={{ display: 'flex', alignItems: 'center', gap: 6 }}
              onClick={handleExportCSV}
            >
              <Download size={13} /> Export CSV
            </button>
          )}
        </div>
        <div className="page-body">
          <div className="glass-card" style={{ padding: 20, marginBottom: 20 }}>
            <div style={{ display: 'flex', gap: 16, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div className="form-group" style={{ minWidth: 240 }}>
                <label className="label">Sync Operation</label>
                <select className="input" value={validationJobId} onChange={e => { setValidationJobId(e.target.value); setValidationPage(1); }}>
                  <option value="">All Syncs</option>
                  {jobs.map(j => (
                    <option key={j.id} value={j.id}>
                      {new Date(j.created_at).toLocaleString()} - {j.preset === 'price_stock_meta' ? 'PRICE+STOCK+META' : 'ALL'}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-group" style={{ minWidth: 180 }}>
                <label className="label">Status Filter</label>
                <select className="input" value={validationFilter} onChange={e => { setValidationFilter(e.target.value); setValidationPage(1); }}>
                  <option value="all">All Statuses</option>
                  {validationCounts.map(c => (
                    <option key={c.action} value={c.action}>{c.action.charAt(0).toUpperCase() + c.action.slice(1)} ({c.count})</option>
                  ))}
                </select>
              </div>
            </div>
            <div style={{ marginTop: 12, display: 'flex', gap: 16, fontSize: 12 }}>
              {validationCounts.map(c => (
                <span key={c.action} style={{ color: c.action === 'created' ? '#4ade80' : c.action === 'updated' ? '#60a5fa' : c.action === 'failed' ? '#f87171' : '#94a3b8' }}>
                  {c.action.charAt(0).toUpperCase() + c.action.slice(1)}: {c.count}
                </span>
              ))}
            </div>
            <div style={{ fontSize: 12, color: '#64748b', marginTop: 8 }}>
              Showing {validationLogs.length > 0 ? `${(validationPage - 1) * 50 + 1}-${Math.min(validationPage * 50, validationTotal)}` : '0'} of {validationTotal} results
            </div>
          </div>

          <div className="table-container">
            <table className="table">
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>Status</th>
                  <th>Action</th>
                  {selectedJob?.preset === 'price_stock_meta' && <>
                    <th>Stock</th>
                    <th>Price</th>
                    <th>Warehouse</th>
                  </>}
                  <th>Message</th>
                  <th>Date & Time</th>
                </tr>
              </thead>
              <tbody>
                {validationLoading ? (
                  <tr><td colSpan={selectedJob?.preset === 'price_stock_meta' ? 8 : 5} style={{ textAlign: 'center', padding: 40 }}>
                    <div className="spinner" style={{ width: 24, height: 24, border: '3px solid rgba(79,110,247,0.2)', borderTopColor: '#4f6ef7', borderRadius: '50%', margin: '0 auto' }} />
                  </td></tr>
                ) : validationLogs.length === 0 ? (
                  <tr><td colSpan={selectedJob?.preset === 'price_stock_meta' ? 8 : 5} style={{ textAlign: 'center', padding: 40, color: '#475569' }}>No logs found</td></tr>
                ) : validationLogs.map(log => (
                  <tr key={log.id}>
                    <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600, color: '#e2e8f0' }}>{log.sku}</td>
                    <td>
                      <span className={`badge ${
                        log.action === 'created' || log.action === 'updated' ? 'badge-success' :
                        log.action === 'failed' ? 'badge-danger' : 'badge-muted'
                      }`}>
                        {log.action === 'created' || log.action === 'updated' ? 'Success' : log.action === 'failed' ? 'Failed' : 'Skipped'}
                      </span>
                    </td>
                    <td><span className="badge badge-info">{log.action.charAt(0).toUpperCase() + log.action.slice(1)}</span></td>
                    {selectedJob?.preset === 'price_stock_meta' && <>
                      <td style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                        {log.details?.stock_from != null || log.details?.stock_to != null ? (
                          <span>
                            <span style={{ color: '#94a3b8' }}>{log.details?.stock_from ?? '-'}</span>
                            <span style={{ color: '#475569', margin: '0 4px' }}>→</span>
                            <span style={{ color: log.details?.stock_to != null && log.details?.stock_from != null && log.details.stock_to > log.details.stock_from ? '#4ade80' : log.details?.stock_to != null && log.details?.stock_from != null && log.details.stock_to < log.details.stock_from ? '#f87171' : '#e2e8f0' }}>{log.details?.stock_to ?? '-'}</span>
                          </span>
                        ) : <span style={{ color: '#475569' }}>-</span>}
                      </td>
                      <td style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                        {log.details?.price_from != null || log.details?.price_to != null ? (
                          <span>
                            <span style={{ color: '#94a3b8' }}>{log.details?.price_from ?? '-'}</span>
                            <span style={{ color: '#475569', margin: '0 4px' }}>→</span>
                            <span style={{ color: '#60a5fa' }}>{log.details?.price_to ?? '-'}</span>
                          </span>
                        ) : <span style={{ color: '#475569' }}>-</span>}
                      </td>
                      <td style={{ fontSize: 12, color: '#94a3b8', whiteSpace: 'nowrap' }}>
                        {log.details?.warehouse_name ?? <span style={{ color: '#475569', fontStyle: 'italic' }}>All warehouses</span>}
                      </td>
                    </>}
                    <td style={{ fontSize: 12, color: '#64748b', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={log.message}>{log.message || '-'}</td>
                    <td style={{ fontSize: 12, color: '#94a3b8', whiteSpace: 'nowrap' }}>{new Date(log.created_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 16 }}>
              <span style={{ fontSize: 13, color: '#64748b' }}>Page {validationPage} of {totalPages}</span>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn btn-secondary btn-sm" disabled={validationPage === 1} onClick={() => setValidationPage(p => p - 1)}>← Prev</button>
                <button className="btn btn-secondary btn-sm" disabled={validationPage === totalPages} onClick={() => setValidationPage(p => p + 1)}>Next →</button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // VIEW: Noon Content Sync
  // ─────────────────────────────────────────────────────────────────────────
  if (view === 'content') {
    const noonChannels = channels.filter(ch => ch.type === 'noon');
    return (
      <div className="animate-fade-in">
        <div className="page-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button className="btn btn-secondary btn-sm btn-icon" onClick={() => {
              if (contentPollRef.current) clearInterval(contentPollRef.current);
              setView('main');
            }}><ArrowLeft size={14} /></button>
            <div>
              <h1 className="page-title">🌙 Noon Content Sync</h1>
              <p className="page-subtitle">Generate & download catalog content CSV for Noon Seller Lab</p>
            </div>
          </div>
        </div>
        <div className="page-body" style={{ display: 'grid', gridTemplateColumns: '380px 1fr', gap: 24, alignItems: 'flex-start' }}>
          {/* Left: Generate */}
          <div className="glass-card" style={{ padding: 24 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
              <div style={{ width: 36, height: 36, borderRadius: 10, background: 'linear-gradient(135deg, #4f6ef7, #7c3aed)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18 }}>🌙</div>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: '#e2e8f0' }}>Generate Content CSV</div>
                <div style={{ fontSize: 12, color: '#64748b' }}>Builds upload file from your attribute mappings</div>
              </div>
            </div>
            <form onSubmit={handleContentSync} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div className="form-group">
                <label className="label">Noon Channel</label>
                <select className="input" value={contentConfig.channel_id}
                  onChange={e => { setContentConfig(c => ({ ...c, channel_id: e.target.value, feed_id: '' })); loadContentJobs(e.target.value); }}
                  required>
                  <option value="">Select Noon channel...</option>
                  {noonChannels.map(ch => <option key={ch.id} value={ch.id}>🌙 {ch.name}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label className="label">Feed</label>
                <select className="input" value={contentConfig.feed_id}
                  onChange={e => setContentConfig(c => ({ ...c, feed_id: e.target.value }))}
                  required>
                  <option value="">Select feed...</option>
                  {feeds.filter(f => !contentConfig.channel_id || channels.find(ch => ch.id === contentConfig.channel_id)?.client_id === f.client_id).map(f => (
                    <option key={f.id} value={f.id}>{f.name}</option>
                  ))}
                </select>
              </div>
              <div style={{ background: 'rgba(79,110,247,0.06)', border: '1px solid rgba(79,110,247,0.15)', borderRadius: 10, padding: '12px 14px', fontSize: 12, color: '#94a3b8', lineHeight: 1.6 }}>
                <strong style={{ color: '#a5b4fc' }}>How it works:</strong> Reads your feed products, applies attribute mappings (title, brand, bullet points, images, search keywords), and generates a ready-to-upload CSV. Upload it in Noon Seller Lab under <em>Catalog → Import Catalog</em>.
              </div>
              <button type="submit" className="btn btn-primary"
                disabled={contentStarting || !contentConfig.channel_id || !contentConfig.feed_id}
                style={{ marginTop: 4 }}>
                {contentStarting ? (
                  <span className="spinner" style={{ width: 14, height: 14, border: '2px solid rgba(255,255,255,0.3)', borderTopColor: 'white', borderRadius: '50%', display: 'inline-block' }} />
                ) : <FileText size={14} />}
                {contentStarting ? 'Generating...' : 'Generate CSV'}
              </button>
            </form>
          </div>

          {/* Right: Jobs */}
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#e2e8f0', marginBottom: 16 }}>Content Jobs</div>
            {contentJobs.length === 0 ? (
              <div className="glass-card" style={{ padding: 48, textAlign: 'center' }}>
                <FileText size={32} color="#334155" style={{ margin: '0 auto 12px' }} />
                <p style={{ color: '#475569', fontSize: 14 }}>No content jobs yet. Select a channel and generate your first CSV.</p>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {contentJobs.map(job => {
                  const ch = channels.find(c => c.id === job.channel_id);
                  const fd = feeds.find(f => f.id === job.feed_id);
                  const isDone = job.status === 'completed';
                  const isFailed = job.status === 'failed';
                  const isActive = job.status === 'exporting' || job.status === 'processing';
                  return (
                    <div key={job.id} className="glass-card" style={{ padding: '16px 20px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          {isDone ? <CheckCircle size={14} color="#4ade80" /> :
                           isFailed ? <AlertTriangle size={14} color="#f87171" /> :
                           <RefreshCw size={14} color="#60a5fa" className="spinner" />}
                          <div>
                            <div style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0' }}>{ch?.name || job.channel_id}</div>
                            <div style={{ fontSize: 11, color: '#64748b' }}>{fd?.name || job.feed_id} · {new Date(job.created_at).toLocaleString()}</div>
                          </div>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span className={`badge ${isDone ? 'badge-success' : isFailed ? 'badge-danger' : isActive ? 'badge-info' : 'badge-muted'}`}>{job.status}</span>
                          {isDone && (
                            <button className="btn btn-primary btn-sm" style={{ padding: '4px 10px', fontSize: 12 }}
                              onClick={() => handleDownloadContentCSV(job.id, ch?.name || 'noon')}>
                              <Download size={11} /> Download CSV
                            </button>
                          )}
                        </div>
                      </div>
                      {(job.total_products > 0 || isFailed) && (
                        <div style={{ marginTop: 6, fontSize: 11, color: '#64748b' }}>
                          {isFailed
                            ? <span style={{ color: '#f87171' }}>{job.error_message}</span>
                            : <span>{job.processed_count}/{job.total_products} products · {job.updated_count} rows mapped</span>
                          }
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // VIEW: Main (Start Sync + Job List)
  // ─────────────────────────────────────────────────────────────────────────
  return (
    <>
    <div className="animate-fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Sync Jobs</h1>
          <p className="page-subtitle">Manage and monitor synchronization between feeds and channels</p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn btn-secondary btn-sm" onClick={() => setView('history')}>
            <Clock size={13} /> Sync History
          </button>
          <button className="btn btn-secondary btn-sm" onClick={() => setView('validation')}>
            <Eye size={13} /> Sync Validation
          </button>
          {channels.some(ch => ch.type === 'noon') && (
            <button className="btn btn-secondary btn-sm" style={{ borderColor: 'rgba(99,102,241,0.4)', color: '#a5b4fc' }}
              onClick={() => {
                const noonChannelId = config.channel_id && channels.find(ch => ch.id === config.channel_id && ch.type === 'noon') ? config.channel_id : '';
                setContentConfig({ channel_id: noonChannelId, feed_id: noonChannelId ? config.feed_id : '' });
                if (noonChannelId) loadContentJobs(noonChannelId);
                setView('content');
              }}>
              <FileText size={13} /> Content Sync
            </button>
          )}
        </div>
      </div>

      <div className="page-body" style={{ display: 'grid', gridTemplateColumns: isClient ? '1fr' : '380px 1fr', gap: 24, alignItems: 'flex-start' }}>
        {/* Start Sync Panel — hidden for clients */}
        {!isClient && (
        <div className="glass-card" style={{ padding: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 24 }}>
            <div style={{ width: 36, height: 36, borderRadius: 10, background: 'linear-gradient(135deg, #4f6ef7, #7c3aed)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Zap size={16} color="white" />
            </div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, color: '#e2e8f0' }}>Start New Sync</div>
              <div style={{ fontSize: 12, color: '#64748b' }}>Configure and launch a sync job</div>
            </div>
          </div>

          <form onSubmit={handleStart} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div className="form-group">
              <label className="label">Channel</label>
              <select className="input" value={config.channel_id} onChange={e => setConfig(c => ({ ...c, channel_id: e.target.value }))} required>
                <option value="">Select channel...</option>
                {shopifyChannels.map(ch => <option key={ch.id} value={ch.id}>{ch.type === 'noon' ? '🌙' : ch.type === 'amazon' ? '📦' : '🛍️'} {ch.name}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="label">Feed</label>
              <select className="input" value={config.feed_id} onChange={e => setConfig(c => ({ ...c, feed_id: e.target.value }))} required>
                <option value="">Select feed...</option>
                {feeds.filter(f => !config.channel_id || channels.find(ch => ch.id === config.channel_id)?.client_id === f.client_id).map(f => (
                  <option key={f.id} value={f.id}>{f.name}</option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label className="label">Sync Preset</label>
              {selectedFeed?.type === 'odoo' && (
                <div style={{ marginBottom: 10, fontSize: 12, color: '#fbbf24' }}>
                  Odoo feeds are update-only. They only update existing Shopify SKUs for price, stock, and mapped metafields.
                </div>
              )}
              {PRESETS.map(p => (
                <label key={p.value} style={{
                  display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px', borderRadius: 10,
                  border: `1px solid ${config.preset === p.value ? 'rgba(79,110,247,0.4)' : 'rgba(79,110,247,0.1)'}`,
                  background: config.preset === p.value ? 'rgba(79,110,247,0.08)' : 'transparent',
                  cursor: 'pointer', marginBottom: 6, transition: 'all 0.2s',
                  opacity: selectedFeed?.type === 'odoo' && p.value !== 'price_stock_meta' ? 0.45 : 1,
                }}>
                  <input type="radio" name="preset" value={p.value}
                    checked={config.preset === p.value}
                    onChange={e => setConfig(c => ({ ...c, preset: e.target.value }))}
                    disabled={selectedFeed?.type === 'odoo' && p.value !== 'price_stock_meta'}
                    style={{ marginTop: 3, accentColor: '#4f6ef7' }}
                  />
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0' }}>{p.label}</div>
                    <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>{p.desc}</div>
                  </div>
                </label>
              ))}
            </div>

            {/* Custom Fields */}
            {config.preset === 'custom' && (
              <div className="form-group">
                <label className="label">Or select specific fields to sync:</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {CUSTOM_FIELDS.map(f => (
                    <label key={f.value} style={{
                      display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 8, fontSize: 12,
                      border: `1px solid ${customFields.includes(f.value) ? 'rgba(79,110,247,0.4)' : 'rgba(79,110,247,0.1)'}`,
                      background: customFields.includes(f.value) ? 'rgba(79,110,247,0.1)' : 'transparent',
                      cursor: 'pointer', color: customFields.includes(f.value) ? '#e2e8f0' : '#94a3b8',
                    }}>
                      <input type="checkbox" checked={customFields.includes(f.value)} onChange={() => toggleCustomField(f.value)}
                        style={{ accentColor: '#4f6ef7' }} />
                      {f.label}
                    </label>
                  ))}
                </div>
              </div>
            )}

            {/* Filter Rules Button */}
            {config.feed_id && (
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setView('filter-rules')}>
                <Filter size={12} /> Filter Rules {filterRules.length > 0 && `(${filterRules.length})`}
              </button>
            )}

            {/* Include Images Toggle (Amazon & Shopify custom sync) */}
            {(() => {
              const selectedCh = channels.find(ch => ch.id === config.channel_id);
              const showForAmazon = selectedCh?.type === 'amazon' && (config.preset === 'sync_all' || config.preset === 'content_only' || config.preset === 'price_stock_meta');
              const showForShopify = selectedCh?.type === 'shopify' && config.preset === 'custom';
              return (showForAmazon || showForShopify) ? (
                <label style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderRadius: 10,
                  border: `1px solid ${includeImages ? 'rgba(255,153,0,0.4)' : 'rgba(79,110,247,0.1)'}`,
                  background: includeImages ? 'rgba(255,153,0,0.08)' : 'transparent',
                  cursor: 'pointer', fontSize: 13, color: '#e2e8f0',
                }}>
                  <input type="checkbox" checked={includeImages} onChange={e => setIncludeImages(e.target.checked)} style={{ accentColor: '#ff9900' }} />
                  <div>
                    <div style={{ fontWeight: 600 }}>Include Images</div>
                    <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>Upload product images to Amazon (requires publicly accessible HTTPS URLs)</div>
                  </div>
                </label>
              ) : null;
            })()}

            {/* No Mapping Warning */}
            {mappingCount === 0 && config.feed_id && config.channel_id && (
              <div style={{
                background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.3)',
                borderRadius: 10, padding: '12px 14px', display: 'flex', alignItems: 'flex-start', gap: 10,
              }}>
                <AlertTriangle size={16} color="#f59e0b" style={{ flexShrink: 0, marginTop: 2 }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#f59e0b' }}>No mappings configured</div>
                  <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 3, marginBottom: 8 }}>
                    Sync requires attribute mappings to know which columns map to which channel fields.
                  </div>
                  <button type="button" className="btn btn-sm" style={{ background: 'rgba(245,158,11,0.2)', color: '#f59e0b', border: '1px solid rgba(245,158,11,0.3)', fontSize: 12 }}
                    onClick={async () => {
                      try {
                        const result = await api.post('/mappings/auto-map', { feed_id: config.feed_id, channel_id: config.channel_id }) as { count: number };
                        setMappingCount(result.count);
                        if (result.count > 0) alert(`✅ Auto-mapped ${result.count} columns!`);
                        else alert('No matching columns found. Please map manually.');
                      } catch { alert('Auto-map failed'); }
                    }}>
                    ⚡ Auto-Map Now
                  </button>
                </div>
              </div>
            )}

            <button type="submit" className="btn btn-primary" disabled={starting || !config.channel_id || !config.feed_id || (config.preset === 'custom' && customFields.length === 0)} style={{ marginTop: 4 }}>
              {starting ? (
                <span className="spinner" style={{ width: 14, height: 14, border: '2px solid rgba(255,255,255,0.3)', borderTopColor: 'white', borderRadius: '50%', display: 'inline-block' }} />
              ) : <Play size={14} />}
              {starting ? 'Starting...' : 'Start Sync'}
            </button>
          </form>
        </div>
        )}

        {/* Active/Recent Jobs */}
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#e2e8f0', marginBottom: 16 }}>Recent Jobs</div>
          {loading ? (
            <div style={{ textAlign: 'center', paddingTop: 40 }}>
              <div className="spinner" style={{ width: 28, height: 28, border: '3px solid rgba(79,110,247,0.2)', borderTopColor: '#4f6ef7', borderRadius: '50%', margin: '0 auto' }} />
            </div>
          ) : jobs.length === 0 ? (
            <div className="glass-card" style={{ padding: 48, textAlign: 'center' }}>
              <Zap size={32} color="#334155" style={{ margin: '0 auto 12px' }} />
              <p style={{ color: '#475569', fontSize: 14 }}>No sync jobs yet — start your first sync!</p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {jobs.slice(0, 10).map(job => (
                <div key={job.id} className="glass-card" style={{ padding: '16px 20px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      {job.status === 'completed' ? <CheckCircle size={14} color="#4ade80" /> :
                       job.status === 'failed' ? <AlertTriangle size={14} color="#f87171" /> :
                       job.status === 'running' ? <RefreshCw size={14} color="#60a5fa" className="spinner" /> :
                       <Clock size={14} color="#fbbf24" />}
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0' }}>{job.channel_name}</div>
                        <div style={{ fontSize: 11, color: '#64748b' }}>
                          {job.preset} · {new Date(job.created_at).toLocaleString()}
                        </div>
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span className={`badge ${
                        job.status === 'completed' ? 'badge-success' :
                        job.status === 'failed' ? 'badge-danger' :
                        job.status === 'running' ? 'badge-info' : 'badge-muted'
                      }`}>{job.status}</span>
                      {!isClient && (job.status === 'running' || job.status === 'pending') && (
                        <button className="btn btn-danger btn-sm" style={{ padding: '4px 8px' }} onClick={() => handleCancel(job.id)}>
                          <XCircle size={11} />
                        </button>
                      )}
                      <button className="btn btn-secondary btn-sm" style={{ padding: '4px 8px' }} onClick={() => { setValidationJobId(job.id); setValidationPage(1); setView('validation'); }}>
                        <Eye size={11} />
                      </button>
                    </div>
                  </div>
                  {job.total_products > 0 && (
                    <div style={{ marginTop: 8 }}>
                      <div className="progress-bar">
                        <div className="progress-fill" style={{ width: `${Math.min(100, Math.round(((job.created_count + job.updated_count + job.failed_count + job.skipped_count) / job.total_products) * 100))}%` }} />
                      </div>
                      <div style={{ display: 'flex', gap: 10, marginTop: 4, fontSize: 11 }}>
                        <span style={{ color: '#4ade80' }}>+{job.created_count}</span>
                        <span style={{ color: '#60a5fa' }}>↻{job.updated_count}</span>
                        <span style={{ color: '#f87171' }}>✗{job.failed_count}</span>
                        {job.skipped_count > 0 && <span style={{ color: '#fbbf24' }}>⊘{job.skipped_count}</span>}
                        <span style={{ color: '#64748b', marginLeft: 'auto' }}>{job.created_count + job.updated_count + job.failed_count + job.skipped_count}/{job.total_products}</span>
                        {(job.status === 'completed' || job.status === 'failed') && job.started_at && (
                          <span style={{ color: '#a78bfa', fontFamily: 'var(--font-mono)' }}>⏱ {getDuration(job)}</span>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
    </>
  );
}
