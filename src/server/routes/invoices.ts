import { Router } from 'express';
import { query } from '../db.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import type { AuthRequest } from '../middleware/auth.js';

const router = Router();
router.use(authenticate);

// GET /api/invoices — list invoices
router.get('/', async (req: AuthRequest, res) => {
  try {
    const { client_id, status } = req.query;
    const isAdmin = req.user!.role === 'admin';
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (client_id) {
      conditions.push(`i.client_id = $${idx++}::uuid`);
      params.push(client_id);
    }
    if (status) {
      conditions.push(`i.status = $${idx++}`);
      params.push(status);
    }
    if (!isAdmin) {
      conditions.push(`i.client_id IN (SELECT uc.client_id FROM user_clients uc WHERE uc.user_id = $${idx++}::uuid)`);
      params.push(req.user!.id);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await query(
      `SELECT i.*, c.name as client_name
       FROM invoices i
       JOIN clients c ON c.id = i.client_id
       ${where}
       ORDER BY i.created_at DESC`,
      params
    );
    return res.json(result.rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch invoices' });
  }
});

// GET /api/invoices/settings/company — get company settings
router.get('/settings/company', requireAdmin, async (_req, res) => {
  try {
    const result = await query("SELECT key, value FROM settings WHERE key LIKE 'company_%'");
    const settings: Record<string, string> = {};
    for (const row of result.rows) {
      settings[row.key] = row.value;
    }
    return res.json(settings);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// PUT /api/invoices/settings/company — save company settings
router.put('/settings/company', requireAdmin, async (req: AuthRequest, res) => {
  try {
    const fields = ['company_name', 'company_address', 'company_phone', 'company_email', 'company_tax_id', 'company_bank_details'];
    for (const key of fields) {
      if (req.body[key] !== undefined) {
        await query(
          `INSERT INTO settings (key, value) VALUES ($1, $2)
           ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
          [key, req.body[key] || '']
        );
      }
    }
    return res.json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to save settings' });
  }
});

// GET /api/invoices/:id — single invoice with items
router.get('/:id', async (req: AuthRequest, res) => {
  try {
    const invoiceResult = await query(
      `SELECT i.*, c.name as client_name FROM invoices i JOIN clients c ON c.id = i.client_id WHERE i.id = $1`,
      [req.params.id]
    );
    if (!invoiceResult.rows[0]) return res.status(404).json({ error: 'Invoice not found' });

    const itemsResult = await query(
      'SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY created_at ASC',
      [req.params.id]
    );

    return res.json({ ...invoiceResult.rows[0], items: itemsResult.rows });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch invoice' });
  }
});

// POST /api/invoices — create invoice (admin only)
router.post('/', requireAdmin, async (req: AuthRequest, res) => {
  try {
    const { client_id, issue_date, due_date, currency, tax_percent, notes, items } = req.body;
    if (!client_id || !items || !items.length) {
      return res.status(400).json({ error: 'client_id and at least one item required' });
    }

    // Verify client has billing info
    const clientResult = await query('SELECT name, address, phone, email FROM clients WHERE id = $1', [client_id]);
    if (!clientResult.rows[0]) return res.status(404).json({ error: 'Client not found' });
    const client = clientResult.rows[0];
    if (!client.address && !client.email && !client.phone) {
      return res.status(400).json({ error: 'Client must have billing information (address, email, or phone). Please update the client profile first.' });
    }

    // Generate invoice number
    const countResult = await query('SELECT COUNT(*) as cnt FROM invoices');
    const invoiceNumber = `INV-${String(parseInt(countResult.rows[0].cnt) + 1).padStart(4, '0')}`;

    // Calculate totals
    const subtotal = items.reduce((sum: number, item: { quantity: number; unit_price: number }) =>
      sum + (item.quantity * item.unit_price), 0);
    const taxPct = parseFloat(tax_percent) || 0;
    const taxAmount = subtotal * (taxPct / 100);
    const total = subtotal + taxAmount;

    const invoiceResult = await query(
      `INSERT INTO invoices (client_id, invoice_number, status, issue_date, due_date, currency, subtotal, tax_percent, tax_amount, total, notes)
       VALUES ($1, $2, 'draft', $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [client_id, invoiceNumber, issue_date || new Date().toISOString().split('T')[0], due_date || null, currency || 'EGP', subtotal, taxPct, taxAmount, total, notes || null]
    );
    const invoice = invoiceResult.rows[0];

    // Insert line items
    for (const item of items) {
      const itemTotal = item.quantity * item.unit_price;
      await query(
        `INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, total)
         VALUES ($1, $2, $3, $4, $5)`,
        [invoice.id, item.description, item.quantity, item.unit_price, itemTotal]
      );
    }

    const fullInvoice = await query(
      `SELECT i.*, c.name as client_name FROM invoices i JOIN clients c ON c.id = i.client_id WHERE i.id = $1`,
      [invoice.id]
    );
    const itemsResult = await query('SELECT * FROM invoice_items WHERE invoice_id = $1', [invoice.id]);

    return res.status(201).json({ ...fullInvoice.rows[0], items: itemsResult.rows });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to create invoice' });
  }
});

// PATCH /api/invoices/:id — update invoice (admin only)
router.patch('/:id', requireAdmin, async (req: AuthRequest, res) => {
  try {
    const { client_id, issue_date, due_date, currency, tax_percent, notes, status, items } = req.body;

    let subtotal, taxAmount, total;
    if (items && items.length > 0) {
      subtotal = items.reduce((sum: number, item: { quantity: number; unit_price: number }) =>
        sum + (item.quantity * item.unit_price), 0);
      const taxPct = parseFloat(tax_percent ?? 0);
      taxAmount = subtotal * (taxPct / 100);
      total = subtotal + taxAmount;

      // Replace items
      await query('DELETE FROM invoice_items WHERE invoice_id = $1', [req.params.id]);
      for (const item of items) {
        const itemTotal = item.quantity * item.unit_price;
        await query(
          `INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, total)
           VALUES ($1, $2, $3, $4, $5)`,
          [req.params.id, item.description, item.quantity, item.unit_price, itemTotal]
        );
      }
    }

    const result = await query(
      `UPDATE invoices SET
        client_id = COALESCE($1, client_id),
        issue_date = COALESCE($2, issue_date),
        due_date = $3,
        currency = COALESCE($4, currency),
        tax_percent = COALESCE($5, tax_percent),
        notes = $6,
        status = COALESCE($7, status),
        subtotal = COALESCE($8, subtotal),
        tax_amount = COALESCE($9, tax_amount),
        total = COALESCE($10, total),
        paid_at = CASE WHEN $7 = 'paid' AND paid_at IS NULL THEN NOW() ELSE paid_at END,
        updated_at = NOW()
       WHERE id = $11 RETURNING *`,
      [client_id || null, issue_date || null, due_date ?? null, currency || null, tax_percent != null ? parseFloat(tax_percent) : null, notes ?? null, status || null, subtotal ?? null, taxAmount ?? null, total ?? null, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Invoice not found' });

    const fullInvoice = await query(
      `SELECT i.*, c.name as client_name FROM invoices i JOIN clients c ON c.id = i.client_id WHERE i.id = $1`,
      [req.params.id]
    );
    const itemsResult = await query('SELECT * FROM invoice_items WHERE invoice_id = $1', [req.params.id]);
    return res.json({ ...fullInvoice.rows[0], items: itemsResult.rows });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to update invoice' });
  }
});

// DELETE /api/invoices/:id (admin only)
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    await query('DELETE FROM invoice_items WHERE invoice_id = $1', [req.params.id]);
    await query('DELETE FROM invoices WHERE id = $1', [req.params.id]);
    return res.json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to delete invoice' });
  }
});

// GET /api/invoices/:id/pdf — download PDF (admin only)
router.get('/:id/pdf', requireAdmin, async (req: AuthRequest, res) => {
  try {
    const invoiceResult = await query(
      `SELECT i.*, c.name as client_name, c.address as client_address, c.phone as client_phone, c.email as client_email, c.tax_id as client_tax_id
       FROM invoices i JOIN clients c ON c.id = i.client_id WHERE i.id = $1`,
      [req.params.id]
    );
    if (!invoiceResult.rows[0]) return res.status(404).json({ error: 'Invoice not found' });

    const itemsResult = await query(
      'SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY created_at ASC',
      [req.params.id]
    );

    const invoice = { ...invoiceResult.rows[0], items: itemsResult.rows };

    // Get company settings
    const settingsResult = await query("SELECT key, value FROM settings WHERE key LIKE 'company_%'");
    const settings: Record<string, string> = {};
    for (const row of settingsResult.rows) {
      settings[row.key] = row.value;
    }

    const { generateInvoicePDF } = await import('../services/invoiceService.js');
    const pdfBuffer = await generateInvoicePDF(invoice, settings);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${invoice.invoice_number}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error('PDF generation error:', err);
    return res.status(500).json({ error: 'Failed to generate PDF' });
  }
});

export default router;
