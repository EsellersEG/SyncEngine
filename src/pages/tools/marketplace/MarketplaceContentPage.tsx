import { useState, useEffect } from "react";
import { User } from "firebase/auth";
import {
  ShoppingBag, LogOut, CheckCircle2, AlertCircle,
  Database, Settings, Sparkles, Loader2
} from "lucide-react";
import { initAuth, googleSignIn, marketplaceLogout, loadFirebaseConfig } from "./lib/firebase";
import { SheetsService } from "./services/sheetsService";
import { generateMarketplaceContent, MarketplaceContent } from "./services/geminiService";
import { Setup } from "./components/Setup";
import { ProductTable, Status } from "./components/ProductTable";
import { ContentPreview } from "./components/ContentPreview";

export default function MarketplaceContentPage() {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [configMissing, setConfigMissing] = useState(false);
  const [isInitializing, setIsInitializing] = useState(true);

  const [spreadsheetId, setSpreadsheetId] = useState<string | null>(null);
  const [sheetTab, setSheetTab] = useState("Products");
  const [products, setProducts] = useState<any[]>([]);
  const [processingStates, setProcessingStates] = useState<Record<number, Status>>({});
  const [errorMessages, setErrorMessages] = useState<Record<number, string>>({});
  const [generatedResults, setGeneratedResults] = useState<Record<number, MarketplaceContent>>({});
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);

  const [isLoading, setIsLoading] = useState(false);
  const [isWriting, setIsWriting] = useState(false);
  const [writtenIndices, setWrittenIndices] = useState<Set<number>>(new Set());
  const [isGeneratingAll, setIsGeneratingAll] = useState(false);

  useEffect(() => {
    const checkConfig = async () => {
      const config = await loadFirebaseConfig();
      if (!config) {
        setConfigMissing(true);
        setIsInitializing(false);
        return;
      }

      initAuth(
        (u, t) => {
          setUser(u);
          setToken(t);
          setIsInitializing(false);
        },
        () => {
          setIsInitializing(false);
        }
      );
    };
    checkConfig();
  }, []);

  const handleLogin = async () => {
    try {
      const res = await googleSignIn();
      if (res) {
        setUser(res.user);
        setToken(res.accessToken);
      }
    } catch (err: any) {
      alert("Sign-in failed: " + err.message);
    }
  };

  const handleLogout = async () => {
    await marketplaceLogout();
    setUser(null);
    setToken(null);
    setSpreadsheetId(null);
    setProducts([]);
    setProcessingStates({});
    setGeneratedResults({});
    setWrittenIndices(new Set());
  };

  const handleIdSubmit = async (id: string, tab: string) => {
    if (!token) return;
    setIsLoading(true);
    try {
      const service = new SheetsService(token);
      const values = await service.getValues(id, `${tab}!A:Z`);
      const parsed = SheetsService.parseSheetData(values);
      setProducts(parsed);
      setSpreadsheetId(id);
      setSheetTab(tab);
      setProcessingStates({});
      setGeneratedResults({});
      setWrittenIndices(new Set());
    } catch (err: any) {
      alert("Error: " + err.message + `. Make sure the sheet has a '${tab}' tab.`);
    } finally {
      setIsLoading(false);
    }
  };

  const handleProcess = async (index: number) => {
    const product = products[index];
    setProcessingStates(prev => ({ ...prev, [index]: 'processing' }));
    try {
      const content = await generateMarketplaceContent(product);
      setGeneratedResults(prev => ({ ...prev, [index]: content }));
      setProcessingStates(prev => ({ ...prev, [index]: 'done' }));
      setSelectedIdx(index);
    } catch (err: any) {
      console.error(err);
      setProcessingStates(prev => ({ ...prev, [index]: 'error' }));
      setErrorMessages(prev => ({ ...prev, [index]: err?.message || 'Unknown error' }));
    }
  };

  const handleGenerateAll = async () => {
    if (!spreadsheetId || !token || products.length === 0) return;
    setIsGeneratingAll(true);

    const modelCache: Record<string, MarketplaceContent> = {};

    try {
      const service = new SheetsService(token);

      const metadata = await service.getSpreadsheet(spreadsheetId);
      const sheetExists = metadata.sheets.some((s: any) => s.properties.title === 'Marketplace Content');
      if (!sheetExists) {
        await service.createSheet(spreadsheetId, 'Marketplace Content');
        await service.appendValues(spreadsheetId, 'Marketplace Content!A1', [[
          'SKU', 'International Barcode', 'Platform', 'Language',
          'Title EN', 'Description EN', 'Bullet 1 EN', 'Bullet 2 EN', 'Bullet 3 EN', 'Bullet 4 EN', 'Bullet 5 EN',
          'Title AR', 'Description AR', 'Bullet 1 AR', 'Bullet 2 AR', 'Bullet 3 AR', 'Bullet 4 AR', 'Bullet 5 AR',
        ]]);
      }

      // Resume: check which SKUs are already in "Marketplace Content" sheet
      const doneSKUs = new Set<string>();
      try {
        const existingRows = await service.getValues(spreadsheetId, 'Marketplace Content!A:A');
        if (existingRows) {
          for (const row of existingRows) {
            if (row[0]) doneSKUs.add(String(row[0]).trim());
          }
        }
      } catch { /* sheet may be empty */ }

      for (let i = 0; i < products.length; i++) {
        if (processingStates[i] === 'done') continue;

        // Skip already-written SKUs (resume support)
        const sku = (products[i].SKU || products[i].sku || '').trim();
        if (sku && doneSKUs.has(sku)) {
          setProcessingStates(prev => ({ ...prev, [i]: 'done' }));
          setWrittenIndices(prev => new Set(prev).add(i));
          continue;
        }

        // Pace requests: 4.5s gap keeps us safely under 15 RPM free-tier limit
        if (i > 0) await new Promise(resolve => setTimeout(resolve, 4500));

        setProcessingStates(prev => ({ ...prev, [i]: 'processing' }));
        try {
          const product = products[i];
          const brand = (product.Brand || product.brand || '').trim();
          const model = (product['Model Number'] || product.model || product.Model || '').trim();
          const cacheKey = `${brand}-${model}`.toLowerCase();

          let content: MarketplaceContent;
          if (model && modelCache[cacheKey]) {
            // Reuse cached content for same brand+model variants (saves quota)
            content = JSON.parse(JSON.stringify(modelCache[cacheKey]));
            // Swap color/size in titles for this specific variant
            const color = (product.Color || product.color || '').trim();
            const size = (product.Size || product.size || '').trim();
            if (color || size) {
              const suffix = [color, size].filter(Boolean).join(' - ');
              // Replace last color/size segment in title
              content.en.title = content.en.title.replace(/ - [^-]+$/, '') + (suffix ? ' - ' + suffix : '');
            }
          } else {
            content = await generateMarketplaceContent(product);
            if (model) modelCache[cacheKey] = content;
          }

          setGeneratedResults(prev => ({ ...prev, [i]: content }));

          const barcode = product['International Barcode'] || product.barcode || '';

          const rowData = [
            sku, barcode, 'Amazon/Noon', 'Bilingual',
            content.en.title, content.en.description, ...content.en.bulletPoints,
            content.ar.title, content.ar.description, ...content.ar.bulletPoints,
          ];

          await service.appendValues(spreadsheetId, 'Marketplace Content!A1', [rowData]);
          doneSKUs.add(sku);
          setProcessingStates(prev => ({ ...prev, [i]: 'done' }));
          setWrittenIndices(prev => new Set(prev).add(i));
        } catch (err: any) {
          console.error(`Error processing product ${i}:`, err);
          setProcessingStates(prev => ({ ...prev, [i]: 'error' }));
          setErrorMessages(prev => ({ ...prev, [i]: err?.message || 'Unknown error' }));
          if (err.message?.includes('429') || err.message?.includes('quota') || err.message?.includes('RESOURCE_EXHAUSTED')) {
            // Server retries will handle transient 429s; if it still fails, pause and continue
            console.log(`[GenerateAll] Rate limited at product ${i}, waiting 60s before continuing...`);
            await new Promise(resolve => setTimeout(resolve, 60000));
          }
        }
      }
    } catch (err: any) {
      alert("Generate All failed: " + err.message);
    } finally {
      setIsGeneratingAll(false);
    }
  };

  const handleWriteToSheet = async () => {
    if (selectedIdx === null || !spreadsheetId || !token) return;
    const content = generatedResults[selectedIdx];
    const product = products[selectedIdx];

    const sku = product.SKU || product.sku || '';
    const barcode = product['International Barcode'] || product.barcode || '';

    setIsWriting(true);
    try {
      const service = new SheetsService(token);
      const metadata = await service.getSpreadsheet(spreadsheetId);
      const sheetExists = metadata.sheets.some((s: any) => s.properties.title === 'Marketplace Content');

      if (!sheetExists) {
        await service.createSheet(spreadsheetId, 'Marketplace Content');
        await service.appendValues(spreadsheetId, 'Marketplace Content!A1', [[
          'SKU', 'International Barcode', 'Platform', 'Language',
          'Title EN', 'Description EN', 'Bullet 1 EN', 'Bullet 2 EN', 'Bullet 3 EN', 'Bullet 4 EN', 'Bullet 5 EN',
          'Title AR', 'Description AR', 'Bullet 1 AR', 'Bullet 2 AR', 'Bullet 3 AR', 'Bullet 4 AR', 'Bullet 5 AR',
        ]]);
      }

      const rowData = [
        sku, barcode, 'Amazon/Noon', 'Bilingual',
        content.en.title, content.en.description, ...content.en.bulletPoints,
        content.ar.title, content.ar.description, ...content.ar.bulletPoints,
      ];

      await service.appendValues(spreadsheetId, 'Marketplace Content!A1', [rowData]);
      setWrittenIndices(prev => new Set(prev).add(selectedIdx));
    } catch (err: any) {
      alert("Failed to write to sheet: " + err.message);
    } finally {
      setIsWriting(false);
    }
  };

  /* ── Loading state ── */
  if (isInitializing) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 400 }}>
        <div style={{ textAlign: 'center' }}>
          <Loader2 size={36} style={{ color: '#10b981', animation: 'spin 1s linear infinite', margin: '0 auto 12px' }} />
          <p style={{ color: '#64748b', fontSize: 13, fontFamily: 'monospace' }}>Initializing...</p>
        </div>
      </div>
    );
  }

  /* ── Firebase config missing ── */
  if (configMissing) {
    return (
      <div style={{ maxWidth: 480, margin: '60px auto', textAlign: 'center' }}>
        <div className="mcg-card">
          <div style={{ width: 72, height: 72, background: 'rgba(239,68,68,0.1)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px', color: '#ef4444' }}>
            <AlertCircle size={36} />
          </div>
          <h2 style={{ fontSize: 20, fontWeight: 700, color: '#f1f5f9', marginBottom: 8 }}>Firebase Config Missing</h2>
          <p style={{ color: '#64748b', fontSize: 14, lineHeight: 1.6, marginBottom: 16 }}>
            Place a <code style={{ background: 'rgba(255,255,255,0.05)', padding: '0 4px', borderRadius: 4, color: '#e2e8f0' }}>firebase-applet-config.json</code> file in the <code style={{ background: 'rgba(255,255,255,0.05)', padding: '0 4px', borderRadius: 4, color: '#e2e8f0' }}>public/</code> folder of this project.
          </p>
          <p style={{ color: '#475569', fontSize: 12 }}>
            The file should contain your Firebase web app config with Google Sheets OAuth scopes enabled.
          </p>
        </div>
      </div>
    );
  }

  /* ── Main UI ── */
  return (
    <div style={{ minHeight: '100%' }}>
      {/* Tool header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 32 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 40, height: 40, background: 'rgba(16,185,129,0.1)', borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <ShoppingBag size={20} style={{ color: '#10b981' }} />
          </div>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 700, color: '#f1f5f9' }}>Marketplace Content Generator</h1>
            <p style={{ fontSize: 12, color: '#64748b' }}>Generate optimized titles, descriptions & bullets for Amazon and Noon</p>
          </div>
        </div>

        {user && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', background: 'rgba(255,255,255,0.05)', borderRadius: 999, border: '1px solid rgba(255,255,255,0.1)' }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#10b981' }} />
              <span style={{ fontSize: 11, fontFamily: 'monospace', color: '#94a3b8' }}>{user.displayName}</span>
            </div>
            <button
              onClick={handleLogout}
              title="Sign out from Google"
              style={{ padding: 8, background: 'transparent', border: 'none', cursor: 'pointer', color: '#64748b' }}
            >
              <LogOut size={16} />
            </button>
          </div>
        )}
      </div>

      {/* Not signed in */}
      {!user ? (
        <div style={{ textAlign: 'center', marginTop: 80 }}>
          <div style={{ width: 80, height: 80, background: 'rgba(16,185,129,0.05)', borderRadius: 24, border: '1px solid rgba(255,255,255,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 24px', color: '#10b981' }}>
            <ShoppingBag size={36} />
          </div>
          <h2 style={{ fontSize: 28, fontWeight: 700, color: '#f1f5f9', marginBottom: 8 }}>Marketplace Hub</h2>
          <p style={{ fontSize: 15, color: '#64748b', maxWidth: 400, margin: '0 auto 32px' }}>
            Sign in with Google to connect your spreadsheet and generate AI-powered marketplace content.
          </p>
          <button
            onClick={handleLogin}
            style={{
              padding: '14px 32px',
              background: '#10b981',
              color: '#000',
              border: 'none',
              borderRadius: 16,
              fontWeight: 700,
              fontSize: 13,
              cursor: 'pointer',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
            }}
          >
            Sign in with Google
          </button>
        </div>

      ) : !spreadsheetId ? (
        <Setup onIdSubmit={handleIdSubmit} isLoading={isLoading} />  

      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          {/* Active file banner */}
          <div className="mcg-card" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <div style={{ padding: 12, background: 'rgba(16,185,129,0.1)', color: '#10b981', borderRadius: 12 }}>
                <Database size={20} />
              </div>
              <div>
                <span className="mcg-label">Active File</span>
                <p style={{ fontSize: 13, fontWeight: 500, color: '#f1f5f9', fontFamily: 'monospace' }}>
                  {spreadsheetId}
                </p>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button
                onClick={handleGenerateAll}
                disabled={isGeneratingAll || products.length === 0}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '8px 20px',
                  background: isGeneratingAll ? 'rgba(16,185,129,0.5)' : '#10b981',
                  color: '#000',
                  border: 'none',
                  borderRadius: 8,
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: isGeneratingAll ? 'not-allowed' : 'pointer',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                }}
              >
                {isGeneratingAll ? <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /> : <Sparkles size={16} />}
                Generate All
              </button>
              <button
                onClick={() => setSpreadsheetId(null)}
                style={{
                  padding: '8px 16px',
                  background: 'rgba(255,255,255,0.05)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: 8,
                  fontSize: 12,
                  fontWeight: 700,
                  color: '#94a3b8',
                  cursor: 'pointer',
                  textTransform: 'uppercase',
                }}
              >
                Change
              </button>
            </div>
          </div>

          {/* Stats row */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
            <StatCard label="Products" value={products.length} />
            <StatCard label="Processed" value={Object.values(processingStates).filter(s => s === 'done').length} />
            <StatCard label="Written to Sheet" value={writtenIndices.size} badge="Connected" />
          </div>

          {/* Products table */}
          <ProductTable
            products={products}
            processingStates={processingStates}
            errorMessages={errorMessages}
            onProcess={handleProcess}
            onPreview={setSelectedIdx}
            isWriting={isWriting}
          />
        </div>
      )}

      {/* Content preview panel */}
      <ContentPreview
        content={selectedIdx !== null ? generatedResults[selectedIdx] : null}
        onClose={() => setSelectedIdx(null)}
        onWrite={handleWriteToSheet}
        isWriting={isWriting}
        wasWritten={selectedIdx !== null && writtenIndices.has(selectedIdx)}
      />
    </div>
  );
}

function StatCard({ label, value, badge }: { label: string; value: number; badge?: string }) {
  return (
    <div className="mcg-card" style={{ position: 'relative', overflow: 'hidden' }}>
      <div style={{
        position: 'absolute', top: 0, right: 0,
        width: 80, height: 80,
        background: 'rgba(16,185,129,0.05)',
        borderRadius: '50%',
        transform: 'translate(30%, -30%)',
      }} />
      <span className="mcg-label">{label}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 4 }}>
        <span style={{ fontSize: 36, fontWeight: 900, color: '#f1f5f9' }}>{value}</span>
        {badge && (
          <span style={{
            padding: '2px 8px',
            background: 'rgba(16,185,129,0.1)',
            color: '#10b981',
            fontSize: 10,
            fontFamily: 'monospace',
            borderRadius: 4,
            border: '1px solid rgba(16,185,129,0.2)',
            textTransform: 'uppercase',
          }}>
            {badge}
          </span>
        )}
      </div>
    </div>
  );
}
