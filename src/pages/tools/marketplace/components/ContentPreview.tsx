import { X, Globe, Check, Loader2, Sparkles } from "lucide-react";
import { MarketplaceContent } from "../services/geminiService";

interface ContentPreviewProps {
  content: MarketplaceContent | null;
  onClose: () => void;
  onWrite: () => void;
  isWriting: boolean;
  wasWritten: boolean;
}

export function ContentPreview({ content, onClose, onWrite, isWriting, wasWritten }: ContentPreviewProps) {
  if (!content) return null;

  return (
    <div
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,0.6)',
        backdropFilter: 'blur(4px)',
        zIndex: 1000,
        display: 'flex',
        justifyContent: 'flex-end',
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 640,
          background: '#151518',
          height: '100%',
          boxShadow: '-4px 0 40px rgba(0,0,0,0.5)',
          display: 'flex',
          flexDirection: 'column',
          borderLeft: '1px solid rgba(255,255,255,0.1)',
          animation: 'slideInRight 0.25s ease',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ padding: 24, borderBottom: '1px solid rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <h3 style={{ fontSize: 20, fontWeight: 700, color: '#f1f5f9' }}>Generated Content</h3>
            <p style={{ fontSize: 13, color: '#64748b' }}>Unified for Amazon & Noon</p>
          </div>
          <button onClick={onClose} style={{ padding: 8, background: 'transparent', border: 'none', cursor: 'pointer', color: '#64748b', borderRadius: '50%' }}>
            <X size={24} />
          </button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 24, background: 'rgba(0,0,0,0.2)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 24, color: '#f1f5f9' }}>
            <Sparkles size={16} style={{ color: '#10b981' }} />
            <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', opacity: 0.5 }}>Global Marketplace Content</span>
          </div>

          {/* English */}
          <div style={{ marginBottom: 32 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, fontSize: 10, fontFamily: 'monospace', color: '#10b981', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
              <Globe size={12} /> English
            </div>
            <ContentSection label="Title" value={content.en.title} />
            <ContentSection label="Description" value={content.en.description} />
            <BulletSection label="Bullet Points" bullets={content.en.bulletPoints} />
          </div>

          {/* Arabic */}
          <div style={{ paddingTop: 32, borderTop: '1px solid rgba(255,255,255,0.05)' }} dir="rtl">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, fontSize: 10, fontFamily: 'monospace', color: '#10b981', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
              <Globe size={12} /> Arabic
            </div>
            <ContentSection label="العنوان" value={content.ar.title} rtl />
            <ContentSection label="الوصف" value={content.ar.description} rtl />
            <BulletSection label="النقاط" bullets={content.ar.bulletPoints} rtl />
          </div>
        </div>

        {/* Footer */}
        <div style={{ padding: 24, borderTop: '1px solid rgba(255,255,255,0.05)', background: 'rgba(0,0,0,0.4)' }}>
          <button
            onClick={onWrite}
            disabled={isWriting || wasWritten}
            style={{
              width: '100%',
              padding: 16,
              background: wasWritten ? 'rgba(16,185,129,0.3)' : '#10b981',
              color: '#000',
              border: 'none',
              borderRadius: 12,
              fontWeight: 700,
              fontSize: 14,
              cursor: isWriting || wasWritten ? 'not-allowed' : 'pointer',
              opacity: isWriting || wasWritten ? 0.7 : 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
            }}
          >
            {isWriting ? (
              <Loader2 size={20} style={{ animation: 'spin 1s linear infinite' }} />
            ) : wasWritten ? (
              <><Check size={20} /> Written to Spreadsheet</>
            ) : (
              <>Update Spreadsheet</>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function ContentSection({ label, value, rtl }: { label: string; value: string; rtl?: boolean }) {
  return (
    <div style={{ padding: 16, background: 'rgba(0,0,0,0.4)', borderRadius: 12, border: '1px solid rgba(255,255,255,0.05)', marginBottom: 12 }}>
      <div className="mcg-label">{label}</div>
      <p style={{ color: rtl ? '#94a3b8' : '#e2e8f0', fontWeight: rtl ? 400 : 500, fontSize: rtl ? 13 : 14, lineHeight: 1.6 }}>{value}</p>
    </div>
  );
}

function BulletSection({ label, bullets, rtl }: { label: string; bullets: string[]; rtl?: boolean }) {
  return (
    <div style={{ padding: 16, background: 'rgba(0,0,0,0.4)', borderRadius: 12, border: '1px solid rgba(255,255,255,0.05)', marginBottom: 12 }}>
      <div className="mcg-label">{label}</div>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
        {bullets.map((bp, i) => (
          <li key={i} style={{ display: 'flex', gap: 8, fontSize: 13, color: '#94a3b8', textAlign: rtl ? 'right' : 'left' }}>
            <span style={{ color: '#10b981', fontWeight: 700, flexShrink: 0 }}>•</span> {bp}
          </li>
        ))}
      </ul>
    </div>
  );
}
