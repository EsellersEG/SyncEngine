import PDFDocument from 'pdfkit';
import path from 'path';
import fs from 'fs';

interface InvoiceItem {
  description: string;
  quantity: number;
  unit_price: number;
  total: number;
}

interface Invoice {
  invoice_number: string;
  client_name: string;
  client_address?: string | null;
  client_phone?: string | null;
  client_email?: string | null;
  client_tax_id?: string | null;
  status: string;
  issue_date: string;
  due_date: string | null;
  currency: string;
  subtotal: number;
  tax_percent: number;
  tax_amount: number;
  total: number;
  notes: string | null;
  items: InvoiceItem[];
}

const C = {
  primary: '#0F172A',
  accent: '#FF9500',
  accentDark: '#E68600',
  text: '#1E293B',
  textLight: '#64748B',
  textMuted: '#94A3B8',
  border: '#E2E8F0',
  bgLight: '#F8FAFC',
  bgStripe: '#FFF8EE',
  white: '#FFFFFF',
  success: '#10B981',
  warning: '#F59E0B',
  danger: '#EF4444',
};

const LOGO_PATH = path.resolve('src/server/assets/logo.png');

export async function generateInvoicePDF(
  invoice: Invoice,
  settings: Record<string, string>
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const pageW = doc.page.width;
    const pageH = doc.page.height;
    const mg = 50;
    const cW = pageW - mg * 2;
    const cur = invoice.currency || 'EGP';

    // ── Top accent bar ─────────────────────────────────────────
    doc.rect(0, 0, pageW, 6).fill(C.accent);

    // ── Header ─────────────────────────────────────────────────
    const hY = 30;
    let logoEndX = mg;
    if (fs.existsSync(LOGO_PATH)) {
      doc.image(LOGO_PATH, mg, hY, { height: 36 });
      logoEndX = mg + 44;
    }
    doc.fontSize(22).font('Helvetica-Bold').fillColor(C.primary)
      .text(settings.company_name || 'E-Sellers', logoEndX, hY + 6);

    doc.fontSize(8.5).font('Helvetica').fillColor(C.textLight);
    let iY = hY + 38;
    if (settings.company_address) { doc.text(settings.company_address, mg, iY); iY += 13; }
    if (settings.company_phone) { doc.text(settings.company_phone, mg, iY); iY += 13; }
    if (settings.company_email) { doc.text(settings.company_email, mg, iY); iY += 13; }
    if (settings.company_tax_id) { doc.text('Tax ID: ' + settings.company_tax_id, mg, iY); iY += 13; }

    doc.fontSize(36).font('Helvetica-Bold').fillColor(C.accent)
      .text('INVOICE', mg, hY, { width: cW, align: 'right' });
    doc.fontSize(11).font('Helvetica').fillColor(C.textLight)
      .text('# ' + invoice.invoice_number, mg, hY + 42, { width: cW, align: 'right' });

    // ── Divider ────────────────────────────────────────────────
    const dY = Math.max(iY + 10, hY + 65);
    doc.moveTo(mg, dY).lineTo(pageW - mg, dY).strokeColor(C.border).lineWidth(1).stroke();

    // ── Meta cards ─────────────────────────────────────────────
    const mY = dY + 16;
    const cardW = (cW - 30) / 2;

    // Left: Invoice Details
    doc.rect(mg, mY, cardW, 80).lineWidth(0.5).strokeColor(C.border).fillAndStroke(C.bgLight, C.border);
    doc.fontSize(8).font('Helvetica-Bold').fillColor(C.accent).text('INVOICE DETAILS', mg + 14, mY + 10);
    doc.fontSize(8.5).font('Helvetica').fillColor(C.textLight);
    const lX = mg + 14, vX = mg + 90;
    let cY = mY + 26;
    doc.text('Issue Date', lX, cY);
    doc.font('Helvetica-Bold').fillColor(C.text).text(formatDate(invoice.issue_date), vX, cY);
    cY += 15;
    if (invoice.due_date) {
      doc.font('Helvetica').fillColor(C.textLight).text('Due Date', lX, cY);
      doc.font('Helvetica-Bold').fillColor(C.text).text(formatDate(invoice.due_date), vX, cY);
      cY += 15;
    }
    doc.font('Helvetica').fillColor(C.textLight).text('Status', lX, cY);
    const sColor = invoice.status === 'paid' ? C.success : invoice.status === 'overdue' ? C.danger : C.warning;
    doc.font('Helvetica-Bold').fillColor(sColor).text(invoice.status.toUpperCase(), vX, cY);

    // Right: Bill To
    const rX = mg + cardW + 30;
    doc.rect(rX, mY, cardW, 80).lineWidth(0.5).strokeColor(C.border).fillAndStroke(C.bgLight, C.border);
    doc.fontSize(8).font('Helvetica-Bold').fillColor(C.accent).text('BILL TO', rX + 14, mY + 10);
    doc.fontSize(10).font('Helvetica-Bold').fillColor(C.text)
      .text(invoice.client_name, rX + 14, mY + 26, { width: cardW - 28 });
    doc.fontSize(8.5).font('Helvetica').fillColor(C.textLight);
    let bY = mY + 42;
    if (invoice.client_address) { doc.text(invoice.client_address, rX + 14, bY, { width: cardW - 28 }); bY += 13; }
    if (invoice.client_phone) { doc.text(invoice.client_phone, rX + 14, bY); bY += 13; }
    if (invoice.client_email) { doc.text(invoice.client_email, rX + 14, bY); bY += 13; }
    if (invoice.client_tax_id) { doc.text('Tax ID: ' + invoice.client_tax_id, rX + 14, bY); }

    // ── Line items table ──────────────────────────────────────
    const tT = mY + 100;
    const col = { n: mg, d: mg + 35, q: mg + cW - 200, p: mg + cW - 130, t: mg + cW - 55 };
    const hH = 28;

    // Header row
    doc.rect(mg, tT, cW, hH).fill(C.primary);
    doc.fontSize(8).font('Helvetica-Bold').fillColor(C.white);
    doc.text('#', col.n + 10, tT + 9, { width: 25 });
    doc.text('DESCRIPTION', col.d, tT + 9, { width: 200 });
    doc.text('QTY', col.q, tT + 9, { width: 60, align: 'center' });
    doc.text('UNIT PRICE', col.p, tT + 9, { width: 70, align: 'right' });
    doc.text('TOTAL', col.t, tT + 9, { width: 55, align: 'right' });

    // Data rows
    let rY = tT + hH;
    const rH = 28;
    for (let i = 0; i < invoice.items.length; i++) {
      const it = invoice.items[i];
      if (i % 2 === 0) doc.rect(mg, rY, cW, rH).fill(C.bgStripe);
      doc.moveTo(mg, rY + rH).lineTo(mg + cW, rY + rH).strokeColor(C.border).lineWidth(0.5).stroke();
      doc.fontSize(8.5).fillColor(C.text);
      doc.font('Helvetica').text(String(i + 1), col.n + 10, rY + 9, { width: 25 });
      doc.font('Helvetica-Bold').text(it.description, col.d, rY + 9, { width: col.q - col.d - 10 });
      doc.font('Helvetica').text(String(it.quantity), col.q, rY + 9, { width: 60, align: 'center' });
      doc.text(Number(it.unit_price).toFixed(2), col.p, rY + 9, { width: 70, align: 'right' });
      doc.font('Helvetica-Bold').text(Number(it.total).toFixed(2), col.t, rY + 9, { width: 55, align: 'right' });
      rY += rH;
    }

    // ── Totals ─────────────────────────────────────────────────
    const tBW = 220;
    const tX = mg + cW - tBW;
    let tY = rY + 16;

    doc.fontSize(9).font('Helvetica').fillColor(C.textLight)
      .text('Subtotal', tX, tY, { width: 110, align: 'right' });
    doc.font('Helvetica-Bold').fillColor(C.text)
      .text(cur + ' ' + Number(invoice.subtotal).toFixed(2), tX + 120, tY, { width: 100, align: 'right' });

    if (invoice.tax_percent > 0) {
      tY += 20;
      doc.font('Helvetica').fillColor(C.textLight)
        .text('Tax (' + invoice.tax_percent + '%)', tX, tY, { width: 110, align: 'right' });
      doc.font('Helvetica-Bold').fillColor(C.text)
        .text(cur + ' ' + Number(invoice.tax_amount).toFixed(2), tX + 120, tY, { width: 100, align: 'right' });
    }

    tY += 22;
    doc.moveTo(tX, tY).lineTo(tX + tBW, tY).strokeColor(C.accent).lineWidth(1.5).stroke();
    tY += 6;
    doc.rect(tX, tY, tBW, 32).fill(C.accent);
    doc.fontSize(11).font('Helvetica-Bold').fillColor(C.white)
      .text('TOTAL', tX + 10, tY + 9, { width: 90, align: 'right' });
    doc.fontSize(12)
      .text(cur + ' ' + Number(invoice.total).toFixed(2), tX + 110, tY + 9, { width: 100, align: 'right' });

    // ── Notes & Payment ───────────────────────────────────────
    let btY = tY + 55;
    if (invoice.notes) {
      doc.fontSize(8.5).font('Helvetica-Bold').fillColor(C.primary).text('NOTES', mg, btY);
      btY += 14;
      doc.fontSize(8.5).font('Helvetica').fillColor(C.textLight)
        .text(invoice.notes, mg, btY, { width: cW * 0.55 });
      btY += 30;
    }
    if (settings.company_bank_details) {
      doc.fontSize(8.5).font('Helvetica-Bold').fillColor(C.primary).text('PAYMENT DETAILS', mg, btY);
      btY += 14;
      doc.fontSize(8.5).font('Helvetica').fillColor(C.textLight)
        .text(settings.company_bank_details, mg, btY, { width: cW * 0.55 });
    }

    // ── Footer ─────────────────────────────────────────────────
    const fY = pageH - 40;
    doc.rect(0, fY - 3, pageW, 3).fill(C.accent);
    doc.rect(0, fY, pageW, 40).fill(C.primary);
    doc.fontSize(8).font('Helvetica').fillColor(C.textMuted)
      .text('Thank you for your business!', mg, fY + 14, { width: cW / 2 });
    doc.fillColor(C.textMuted)
      .text(settings.company_name || 'E-Sellers', mg, fY + 14, { width: cW, align: 'right' });

    doc.end();
  });
}

function formatDate(dateStr: string): string {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
