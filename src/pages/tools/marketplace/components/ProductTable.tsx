import { CheckCircle2, Circle, Clock, Loader2, Sparkles } from "lucide-react";

export type Status = 'idle' | 'processing' | 'done' | 'error';

interface ProductTableProps {
  products: any[];
  processingStates: Record<number, Status>;
  errorMessages?: Record<number, string>;
  onProcess: (index: number) => void;
  onPreview: (index: number) => void;
  isWriting: boolean;
}

export function ProductTable({ products, processingStates, errorMessages = {}, onProcess, onPreview }: ProductTableProps) {
  if (products.length === 0) return null;

  return (
    <div className="mcg-card overflow-hidden mt-8">
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr style={{ background: 'rgba(255,255,255,0.05)' }}>
              <th className="px-6 py-4 mcg-label">Product</th>
              <th className="px-6 py-4 mcg-label">Attributes</th>
              <th className="px-6 py-4 mcg-label" style={{ textAlign: 'center' }}>Status</th>
              <th className="px-6 py-4 mcg-label" style={{ textAlign: 'right' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {products.map((product, idx) => {
              const status = processingStates[idx] || 'idle';
              const name = product.Title || product.title || product.Name || Object.values(product)[0];

              return (
                <tr key={idx} style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                  <td className="px-6 py-4">
                    <div style={{ fontWeight: 500, color: '#e2e8f0', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 1, WebkitBoxOrient: 'vertical' as any }}>{String(name)}</div>
                  </td>
                  <td className="px-6 py-4">
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      {Object.keys(product).slice(1, 4).map(key => (
                        <span key={key} style={{
                          padding: '2px 8px',
                          background: 'rgba(255,255,255,0.05)',
                          border: '1px solid rgba(255,255,255,0.1)',
                          fontSize: 10,
                          borderRadius: 4,
                          color: '#64748b',
                          textTransform: 'uppercase',
                          fontFamily: 'monospace',
                        }}>
                          {key}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-6 py-4" style={{ textAlign: 'center' }}>
                    <StatusBadge status={status} />
                  </td>
                  <td className="px-6 py-4" style={{ textAlign: 'right' }}>
                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                      {status === 'done' ? (
                        <button
                          onClick={() => onPreview(idx)}
                          style={{ padding: 8, color: '#10b981', background: 'rgba(16,185,129,0.1)', borderRadius: 12, border: 'none', cursor: 'pointer' }}
                          title="Preview Content"
                        >
                          <Sparkles size={20} />
                        </button>
                      ) : (
                        <button
                          onClick={() => onProcess(idx)}
                          disabled={status === 'processing'}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 8,
                            padding: '8px 16px',
                            background: status === 'processing' ? 'rgba(16,185,129,0.5)' : '#10b981',
                            color: '#000',
                            borderRadius: 12, border: 'none',
                            fontSize: 12, fontWeight: 700,
                            cursor: status === 'processing' ? 'not-allowed' : 'pointer',
                            opacity: status === 'processing' ? 0.7 : 1,
                            textTransform: 'uppercase',
                          }}
                        >
                          {status === 'processing' ? <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /> : "Generate"}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatusBadge({ status, errorMessage }: { status: Status; errorMessage?: string }) {
  const base: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '2px 12px', borderRadius: 999,
    fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
  };
  if (status === 'processing') return (
    <span style={{ ...base, background: 'rgba(16,185,129,0.1)', color: '#10b981' }}>
      <Clock size={12} /> Processing
    </span>
  );
  if (status === 'done') return (
    <span style={{ ...base, background: 'rgba(16,185,129,0.2)', color: '#10b981' }}>
      <CheckCircle2 size={12} /> Ready
    </span>
  );
  if (status === 'error') return (
    <span style={{ ...base, background: 'rgba(239,68,68,0.1)', color: '#ef4444', cursor: 'help', maxWidth: 260 }}
      title={errorMessage || 'Unknown error'}>
      Error{errorMessage ? ': ' + errorMessage.slice(0, 60) + (errorMessage.length > 60 ? '…' : '') : ''}
    </span>
  );
  return (
    <span style={{ ...base, background: 'rgba(255,255,255,0.05)', color: '#475569' }}>
      <Circle size={12} /> Idle
    </span>
  );
}
