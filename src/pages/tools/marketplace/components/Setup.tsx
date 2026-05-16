import { Search, Loader2, Link2, TableProperties } from "lucide-react";
import { useState } from "react";

interface SetupProps {
  onIdSubmit: (id: string, sheetTab: string) => void;
  isLoading: boolean;
}

export function Setup({ onIdSubmit, isLoading }: SetupProps) {
  const [url, setUrl] = useState("");
  const [sheetTab, setSheetTab] = useState("Products");

  const extractId = (input: string) => {
    const match = input.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    return match ? match[1] : input;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const id = extractId(url);
    if (id) onIdSubmit(id, sheetTab || "Products");
  };

  return (
    <div style={{ maxWidth: 640, margin: '60px auto 0' }}>
      <div className="mcg-card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
          <div style={{ padding: 12, background: 'rgba(16,185,129,0.1)', borderRadius: 16 }}>
            <Link2 size={24} style={{ color: '#10b981' }} />
          </div>
          <div>
            <h2 style={{ fontSize: 22, fontWeight: 700, color: '#f1f5f9' }}>Connect your Sheet</h2>
            <p style={{ fontSize: 14, color: '#64748b' }}>Paste your Google Sheet URL or ID to get started.</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ position: 'relative' }}>
            <Search size={20} style={{ position: 'absolute', left: 16, top: '50%', transform: 'translateY(-50%)', color: '#64748b', pointerEvents: 'none' }} />
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://docs.google.com/spreadsheets/d/..."
              style={{
                width: '100%',
                paddingLeft: 48,
                paddingRight: 16,
                paddingTop: 16,
                paddingBottom: 16,
                background: 'rgba(0,0,0,0.4)',
                border: '1px solid rgba(255,255,255,0.05)',
                borderRadius: 12,
                outline: 'none',
                color: '#e2e8f0',
                fontSize: 14,
                boxSizing: 'border-box',
              }}
              required
            />
          </div>
          <div style={{ position: 'relative' }}>
            <TableProperties size={20} style={{ position: 'absolute', left: 16, top: '50%', transform: 'translateY(-50%)', color: '#64748b', pointerEvents: 'none' }} />
            <input
              type="text"
              value={sheetTab}
              onChange={(e) => setSheetTab(e.target.value)}
              placeholder="Sheet tab name"
              style={{
                width: '100%',
                paddingLeft: 48,
                paddingRight: 16,
                paddingTop: 12,
                paddingBottom: 12,
                background: 'rgba(0,0,0,0.4)',
                border: '1px solid rgba(255,255,255,0.05)',
                borderRadius: 12,
                outline: 'none',
                color: '#e2e8f0',
                fontSize: 14,
                boxSizing: 'border-box',
              }}
            />
            <span style={{ position: 'absolute', right: 14, top: '50%', transform: 'translateY(-50%)', fontSize: 10, color: '#475569', fontFamily: 'monospace', textTransform: 'uppercase' }}>tab name</span>
          </div>
          <button
            type="submit"
            disabled={isLoading || !url}
            style={{
              width: '100%',
              padding: '16px',
              background: isLoading || !url ? 'rgba(16,185,129,0.5)' : '#10b981',
              color: '#000',
              border: 'none',
              borderRadius: 12,
              fontWeight: 700,
              fontSize: 14,
              cursor: isLoading || !url ? 'not-allowed' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
            }}
          >
            {isLoading ? <Loader2 size={20} style={{ animation: 'spin 1s linear infinite' }} /> : "Verify Spreadsheet"}
          </button>
        </form>

        <div style={{ marginTop: 24, paddingTop: 24, borderTop: '1px solid rgba(255,255,255,0.05)' }}>
          <p className="mcg-label" style={{ marginBottom: 8 }}>Instructions</p>
          <div style={{ fontSize: 12, color: '#64748b', display: 'flex', flexDirection: 'column', gap: 4 }}>
            <p>• Make sure the sheet has a tab matching the name above (default: <code style={{ background: 'rgba(255,255,255,0.05)', padding: '0 4px', borderRadius: 4, color: '#e2e8f0' }}>Products</code>)</p>
            <p>• Ensure row 1 contains headers (Title, Description, etc.)</p>
          </div>
        </div>
      </div>
    </div>
  );
}
