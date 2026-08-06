// Accounting surface (plan §5.5): the posting queue, mark-as-posted with the
// CDK reference, and the CDK-shaped batch export (plan §6.3/§6.5 — no live
// CDK integration in MVP). accounting role only; SoD keeps accounting from
// ever approving (A.5.3).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import { withUserContext, type Db } from '../db/pool.js';
import { AuditAction, writeAudit } from '../audit/audit.js';
import { requireRoles } from '../plugins/rbac.js';
import { buildLabelledWorkbook } from '../exports/excel.js';
import { eventBus } from '../events/bus.js';

export default async function accountingRoutes(app: FastifyInstance, opts: { db: Db; config: Config }) {
  const { db } = opts;

  // ── Queue: invoices awaiting posting, approval trail attached ──────────────
  app.get('/api/accounting/queue', { preHandler: requireRoles(db, 'accounting') }, async (req) => {
    const user = req.currentUser!;
    const rows = await withUserContext(db, user.id, async (client) => {
      const result = await client.query(
        `SELECT i.id AS invoice_id, i.invoice_no, i.invoice_date, i.amount AS invoice_amount,
                i.currency, i.status AS invoice_status, i.variance_vs_approved, i.created_at,
                i.attachment_id,
                r.id AS requisition_id, r.reference, r.approval_reference, r.amount AS approved_amount,
                r.description, cc.code AS cost_centre_code, cat.code AS category_code,
                cat.gl_account_code, s.name AS supplier_name, s.cdk_vendor_ref,
                u.display_name AS requester_name,
                (SELECT json_agg(json_build_object(
                   'stepNo', st.step_no, 'decision', st.decision, 'decidedAt', st.decided_at,
                   'approverName', au.display_name, 'purpose', st.purpose
                 ) ORDER BY st.step_no)
                 FROM approval_steps st LEFT JOIN users au ON au.id = st.assigned_user_id
                 WHERE st.requisition_id = r.id) AS approval_trail
         FROM invoices i
         JOIN requisitions r ON r.id = i.requisition_id
         JOIN cost_centres cc ON cc.id = r.cost_centre_id
         JOIN categories cat ON cat.id = r.category_id
         JOIN users u ON u.id = r.requester_id
         LEFT JOIN suppliers s ON s.id = r.supplier_id
         WHERE i.status IN ('submitted', 'pending_reapproval')
           -- Never queue spend whose approval has been withdrawn
           AND r.status IN ('approved', 'closed')
         ORDER BY i.created_at`,
      );
      return result.rows;
    });
    return { queue: rows };
  });

  // ── Mark as posted (plan §5.5): CDK reference + who + when ────────────────
  app.post(
    '/api/accounting/invoices/:id/post',
    { preHandler: requireRoles(db, 'accounting') },
    async (req, reply) => {
      const user = req.currentUser!;
      const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
      const body = z.object({ cdkReference: z.string().min(1).max(100) }).safeParse(req.body);
      if (!params.success) return reply.code(404).send({ error: 'not_found' });
      if (!body.success) return reply.code(400).send({ error: 'cdk_reference_required' });

      const outcome = await withUserContext(db, user.id, async (client) => {
        const found = await client.query<{
          id: string;
          status: string;
          amount: string;
          requisition_id: string;
          req_status: string;
          req_amount: string;
          cost_centre_id: string;
          reference: string;
        }>(
          `SELECT i.id, i.status, i.amount, i.requisition_id,
                  r.status AS req_status, r.amount AS req_amount, r.cost_centre_id, r.reference
           FROM invoices i JOIN requisitions r ON r.id = i.requisition_id
           WHERE i.id = $1 FOR UPDATE OF i, r`,
          [params.data.id],
        );
        const invoice = found.rows[0];
        if (!invoice) return { code: 404 as const, error: 'not_found' };
        if (invoice.status === 'pending_reapproval') {
          // Variance re-approval must complete before posting (plan §5.4)
          return { code: 409 as const, error: 'pending_variance_reapproval' };
        }
        if (invoice.status !== 'submitted') return { code: 409 as const, error: 'not_postable' };
        // Spend is only ever recorded against a live approval: a requisition
        // cancelled after approval has withdrawn its authority, and posting
        // against it would book actual spend while its commitment is released
        // (adversarial-review finding). The DB trigger (0010) enforces this too.
        if (!['approved', 'closed'].includes(invoice.req_status)) {
          return { code: 409 as const, error: 'requisition_not_approved' };
        }

        await client.query(
          `UPDATE invoices SET status = 'posted', posted_by = $2, posted_at = now(), cdk_reference = $3
           WHERE id = $1`,
          [invoice.id, user.id, body.data.cdkReference],
        );

        // The requisition closes when its posted total covers the approved
        // amount (commitment fully actualised — plan §1 core loop).
        const posted = await client.query<{ total: string }>(
          `SELECT coalesce(sum(amount), 0)::text AS total FROM invoices
           WHERE requisition_id = $1 AND status = 'posted'`,
          [invoice.requisition_id],
        );
        let closed = false;
        if (invoice.req_status === 'approved' && Number(posted.rows[0]!.total) >= Number(invoice.req_amount)) {
          await client.query(
            `UPDATE requisitions SET status = 'closed', closed_at = now(), updated_at = now() WHERE id = $1`,
            [invoice.requisition_id],
          );
          closed = true;
        }
        await writeAudit(client, {
          actorUserId: user.id,
          action: AuditAction.InvoicePosted,
          entityType: 'invoice',
          entityId: invoice.id,
          after: {
            requisitionReference: invoice.reference,
            cdkReference: body.data.cdkReference,
            amount: invoice.amount,
            requisitionClosed: closed,
          },
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'] ?? null,
        });
        return { code: 200 as const, costCentreId: invoice.cost_centre_id, closed };
      });

      if (outcome.code !== 200) return reply.code(outcome.code).send({ error: outcome.error });
      // Committed → actual moved: update every open budget screen (plan §5.9)
      eventBus.emitBudgetChanged({ costCentreId: outcome.costCentreId, cause: 'invoice_posted' });
      return { ok: true, requisitionClosed: outcome.closed };
    },
  );

  // ── Reject an unpostable invoice (bad scan, wrong document) ────────────────
  app.post(
    '/api/accounting/invoices/:id/reject',
    { preHandler: requireRoles(db, 'accounting') },
    async (req, reply) => {
      const user = req.currentUser!;
      const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
      const body = z.object({ reason: z.string().min(3).max(1000) }).safeParse(req.body);
      if (!params.success) return reply.code(404).send({ error: 'not_found' });
      if (!body.success) return reply.code(400).send({ error: 'reason_required' });

      const outcome = await withUserContext(db, user.id, async (client) => {
        const found = await client.query<{ id: string; status: string }>(
          'SELECT id, status FROM invoices WHERE id = $1 FOR UPDATE',
          [params.data.id],
        );
        const invoice = found.rows[0];
        if (!invoice) return { code: 404 as const };
        if (!['submitted', 'pending_reapproval'].includes(invoice.status)) return { code: 409 as const };
        await client.query(`UPDATE invoices SET status = 'rejected' WHERE id = $1`, [invoice.id]);
        await writeAudit(client, {
          actorUserId: user.id,
          action: 'invoice.rejected',
          entityType: 'invoice',
          entityId: invoice.id,
          after: { reason: body.data.reason },
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'] ?? null,
        });
        return { code: 200 as const };
      });
      if (outcome.code !== 200) {
        return reply.code(outcome.code).send({ error: outcome.code === 409 ? 'not_rejectable' : 'not_found' });
      }
      return { ok: true };
    },
  );

  // ── CDK batch export (plan §6.3): labelled, audited, rate-limited ──────────
  app.get(
    '/api/accounting/batch-export.xlsx',
    {
      preHandler: requireRoles(db, 'accounting'),
      config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
    },
    async (req, reply) => {
      const user = req.currentUser!;
      const rows = await withUserContext(db, user.id, async (client) => {
        const result = await client.query<Record<string, unknown>>(
          `SELECT r.approval_reference, i.invoice_no, i.invoice_date, i.amount, i.currency,
                  s.cdk_vendor_ref, s.name AS supplier_name, cat.gl_account_code, cat.cdk_account_ref,
                  cc.code AS cost_centre_code, r.reference AS requisition_reference,
                  r.description
           FROM invoices i
           JOIN requisitions r ON r.id = i.requisition_id
           JOIN cost_centres cc ON cc.id = r.cost_centre_id
           JOIN categories cat ON cat.id = r.category_id
           LEFT JOIN suppliers s ON s.id = r.supplier_id
           WHERE i.status = 'submitted'
           ORDER BY i.created_at`,
        );
        return result.rows;
      });

      const buffer = await buildLabelledWorkbook({
        title: 'CDK posting batch',
        classification: 'Confidential',
        exportedBy: `${user.displayName} <${user.email}>`,
        filterDescription: 'Invoices awaiting posting (status: submitted)',
        columns: [
          { header: 'CDK Vendor Ref', key: 'cdk_vendor_ref', width: 16 },
          { header: 'Supplier', key: 'supplier_name', width: 30 },
          { header: 'Invoice No', key: 'invoice_no', width: 18 },
          { header: 'Invoice Date', key: 'invoice_date', width: 14 },
          { header: 'Amount', key: 'amount', width: 14 },
          { header: 'Currency', key: 'currency', width: 10 },
          { header: 'GL Account', key: 'gl_account_code', width: 12 },
          { header: 'CDK Account Ref', key: 'cdk_account_ref', width: 16 },
          { header: 'Cost Centre', key: 'cost_centre_code', width: 12 },
          { header: 'Approval Reference', key: 'approval_reference', width: 24 },
          { header: 'Requisition', key: 'requisition_reference', width: 20 },
          { header: 'Description', key: 'description', width: 40 },
        ],
        rows: rows.map((r) => ({
          ...r,
          invoice_date:
            r.invoice_date instanceof Date ? r.invoice_date.toISOString().slice(0, 10) : r.invoice_date,
        })),
      });
      await writeAudit(db, {
        actorUserId: user.id,
        action: AuditAction.Export,
        entityType: 'export',
        entityId: 'accounting-batch',
        after: { rowCount: rows.length, filter: 'invoices awaiting posting', format: 'xlsx' },
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
      });
      return reply
        .header('content-disposition', 'attachment; filename="cdk-posting-batch.xlsx"')
        .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .send(buffer);
    },
  );
}
