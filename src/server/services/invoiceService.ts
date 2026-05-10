import PDFDocument from 'pdfkit';

interface InvoiceItem {
  description: string;
  quantity: number;
  unit_price: number;
  total: number;
}

interface Invoice {
  invoice_number: string;
  client_name: string;
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

export async function generateInvoicePDF(
  invoice: Invoice,
  settings: Record<string, string>
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks: Buffer[] = [];

    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const pageWidth = doc.page.width - 100; // margins
    const currency = invoice.currency || 'EGP';

    // ── Header ──────────────────────────────────────────────────────────
    // Company info (left)
    doc.fontSize(20).font('Helvetica-Bold')
      .text(settings.company_name || 'Your Company', 50, 50);

    doc.fontSize(9).font('Helvetica').fillColor('#555');
    let yPos = 75;
    if (settings.company_address) {
      doc.text(settings.company_address, 50, yPos);
      yPos += 13;
    }
    if (settings.company_phone) {
      doc.text(`Phone: ${settings.company_phone}`, 50, yPos);
      yPos += 13;
    }
    if (settings.company_email) {
      doc.text(`Email: ${settings.company_email}`, 50, yPos);
      yPos += 13;
    }
    if (settings.company_tax_id) {
      doc.text(`Tax ID: ${settings.company_tax_id}`, 50, yPos);
      yPos += 13;
    }

    // Invoice title (right)
    doc.fontSize(28).font('Helvetica-Bold').fillColor('#FFA500')
      .text('INVOICE', 350, 50, { width: 200, align: 'right' });

    doc.fontSize(10).font('Helvetica').fillColor('#333');
    doc.text(`#${invoice.invoice_number}`, 350, 82, { width: 200, align: 'right' });

    // ── Invoice meta ────────────────────────────────────────────────────
    const metaY = Math.max(yPos + 20, 130);
    doc.fontSize(9).fillColor('#555');
    doc.text('Issue Date:', 50, metaY);
    doc.font('Helvetica-Bold').fillColor('#333')
      .text(formatDate(invoice.issue_date), 120, metaY);

    if (invoice.due_date) {
      doc.font('Helvetica').fillColor('#555')
        .text('Due Date:', 50, metaY + 16);
      doc.font('Helvetica-Bold').fillColor('#333')
        .text(formatDate(invoice.due_date), 120, metaY + 16);
    }

    doc.font('Helvetica').fillColor('#555')
      .text('Status:', 50, metaY + 32);
    doc.font('Helvetica-Bold').fillColor(invoice.status === 'paid' ? '#16a34a' : '#f59e0b')
      .text(invoice.status.toUpperCase(), 120, metaY + 32);

    // Bill To (right side)
    doc.font('Helvetica').fontSize(9).fillColor('#555')
      .text('Bill To:', 350, metaY, { width: 200, align: 'right' });
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#333')
      .text(invoice.client_name, 350, metaY + 14, { width: 200, align: 'right' });

    // ── Line Items Table ────────────────────────────────────────────────
    const tableTop = metaY + 70;
    const colX = { desc: 50, qty: 320, price: 390, total: 470 };

    // Table header
    doc.rect(50, tableTop - 5, pageWidth, 22).fill('#FFA500');
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#000');
    doc.text('Description', colX.desc + 8, tableTop);
    doc.text('Qty', colX.qty, tableTop, { width: 50, align: 'center' });
    doc.text('Unit Price', colX.price, tableTop, { width: 70, align: 'right' });
    doc.text('Total', colX.total, tableTop, { width: 75, align: 'right' });

    // Table rows
    let rowY = tableTop + 25;
    doc.font('Helvetica').fontSize(9).fillColor('#333');

    for (let i = 0; i < invoice.items.length; i++) {
      const item = invoice.items[i];
      if (i % 2 === 0) {
        doc.rect(50, rowY - 4, pageWidth, 20).fill('#f8f9fa');
        doc.fillColor('#333');
      }
      doc.text(item.description, colX.desc + 8, rowY, { width: 260 });
      doc.text(String(item.quantity), colX.qty, rowY, { width: 50, align: 'center' });
      doc.text(`${Number(item.unit_price).toFixed(2)}`, colX.price, rowY, { width: 70, align: 'right' });
      doc.text(`${Number(item.total).toFixed(2)}`, colX.total, rowY, { width: 75, align: 'right' });
      rowY += 22;
    }

    // Bottom line
    doc.moveTo(50, rowY + 5).lineTo(50 + pageWidth, rowY + 5).strokeColor('#ddd').stroke();

    // ── Totals ──────────────────────────────────────────────────────────
    const totalsX = 380;
    const totalsValueX = 470;
    let totalsY = rowY + 20;

    doc.font('Helvetica').fontSize(10).fillColor('#555');
    doc.text('Subtotal:', totalsX, totalsY, { width: 80, align: 'right' });
    doc.font('Helvetica-Bold').fillColor('#333')
      .text(`${currency} ${Number(invoice.subtotal).toFixed(2)}`, totalsValueX, totalsY, { width: 75, align: 'right' });

    if (invoice.tax_percent > 0) {
      totalsY += 18;
      doc.font('Helvetica').fillColor('#555')
        .text(`Tax (${invoice.tax_percent}%):`, totalsX, totalsY, { width: 80, align: 'right' });
      doc.font('Helvetica-Bold').fillColor('#333')
        .text(`${currency} ${Number(invoice.tax_amount).toFixed(2)}`, totalsValueX, totalsY, { width: 75, align: 'right' });
    }

    totalsY += 22;
    doc.rect(totalsX - 10, totalsY - 4, 160, 24).fill('#FFA500');
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#000')
      .text('Total:', totalsX, totalsY, { width: 80, align: 'right' });
    doc.text(`${currency} ${Number(invoice.total).toFixed(2)}`, totalsValueX, totalsY, { width: 75, align: 'right' });

    // ── Notes ───────────────────────────────────────────────────────────
    if (invoice.notes) {
      const notesY = totalsY + 50;
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#333')
        .text('Notes:', 50, notesY);
      doc.font('Helvetica').fontSize(9).fillColor('#555')
        .text(invoice.notes, 50, notesY + 15, { width: pageWidth });
    }

    // ── Bank Details ────────────────────────────────────────────────────
    if (settings.company_bank_details) {
      const bankY = (invoice.notes ? totalsY + 90 : totalsY + 50);
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#333')
        .text('Payment Details:', 50, bankY);
      doc.font('Helvetica').fontSize(9).fillColor('#555')
        .text(settings.company_bank_details, 50, bankY + 15, { width: pageWidth });
    }

    // ── Footer ──────────────────────────────────────────────────────────
    doc.fontSize(8).font('Helvetica').fillColor('#999')
      .text('Thank you for your business!', 50, doc.page.height - 60, { width: pageWidth, align: 'center' });

    doc.end();
  });
}

function formatDate(dateStr: string): string {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
