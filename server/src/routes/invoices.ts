// Invoice submission (plan §5.4). The requester uploads the supplier invoice
// against an APPROVED requisition — never a denied or pending one. Variance
// beyond the configurable tolerance requires re-approval by the final
// approver before Accounting may post (the re-approval is a real
// approval_steps row decided through the normal approve/deny endpoints).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import { withUserContext, type Db } from '../db/pool.js';
import { AuditAction, writeAudit } from '../audit/audit.js';
import { requireAuth } from '../plugins/rbac.js';
import { detectFileKind } from '../files/magic.js';
import { scanBuffer } from '../files/scanner.js';
import { saveAttachmentFile, sha256Hex } from '../files/storage.js';
import { readSetting } from '../settings.js';
import { NotificationTemplate, queueNotification } from '../notify/notifier.js';

const fieldValue = (file: { fields: Record<string, unknown> }, name: string): string | undefined => {
  const f = file.fields[name] as { value?: unknown } | undefined;
  return typeof f?.value === 'string' ? f.value : undefined;
};

export default async function invoiceRoutes(app: FastifyInstance, opts: { db: Db; config: Config }) {
  const { db, config } = opts;

  app.post(
    '/api/requisitions/:id/invoice',
    { preHandler: requireAuth(), config: { rateLimit: { max: 30, timeWindow: '1 hour' } } },
    async (req, reply) => {
      const user = req.currentUser!;
      const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
      if (!params.success) return reply.code(404).send({ error: 'not_found' });

      const file = await req.file();
      if (!file) return reply.code(400).send({ error: 'file_required' });
      const meta = z
        .object({
          invoiceNo: z.string().min(1).max(100),
          invoiceDate: z.coerce.date(),
          amount: z.coerce.number().positive().multipleOf(0.01),
          currency: z.string().length(3).transform((c) => c.toUpperCase()),
        })
        .safeParse({
          invoiceNo: fieldValue(file, 'invoiceNo'),
          invoiceDate: fieldValue(file, 'invoiceDate'),
          amount: fieldValue(file, 'amount'),
          currency: fieldValue(file, 'currency'),
        });
      if (!meta.success) {
        return reply.code(400).send({ error: 'invalid_request', message: meta.error.issues[0]?.message });
      }
      const buffer = await file.toBuffer();
      if (file.file.truncated) return reply.code(413).send({ error: 'file_too_large' });

      const base = await readSetting(db, 'base_currency');
      if (meta.data.currency !== base) return reply.code(400).send({ error: 'currency_not_supported' });
      const maxBytes = await readSetting(db, 'attachment_max_bytes');
      if (buffer.length === 0 || buffer.length > maxBytes) {
        return reply.code(413).send({ error: 'file_too_large', maxBytes });
      }
      const detected = detectFileKind(buffer);
      if (!detected) {
        return reply.code(415).send({ error: 'file_type_not_allowed', allowed: ['pdf', 'jpg', 'png', 'xlsx'] });
      }

      const tolerance = await readSetting(db, 'invoice_variance_tolerance');
      const verdict = await scanBuffer(config, buffer);

      const outcome = await withUserContext(db, user.id, async (client) => {
        const found = await client.query<{
          id: string;
          reference: string;
          requester_id: string;
          status: string;
          amount: string;
        }>('SELECT id, reference, requester_id, status, amount FROM requisitions WHERE id = $1 FOR UPDATE', [
          params.data.id,
        ]);
        const requisition = found.rows[0];
        if (!requisition || requisition.requester_id !== user.id) return { code: 404 as const, error: 'not_found' };
        // Plan §5.4: cannot upload against a denied or pending requisition
        if (requisition.status !== 'approved') {
          return { code: 409 as const, error: 'requisition_not_approved' };
        }

        const sha = sha256Hex(buffer);
        const { storageKey } = await saveAttachmentFile(config, buffer, {
          quarantined: verdict.status === 'infected',
        });
        const attachment = await client.query<{ id: string }>(
          `INSERT INTO attachments (requisition_id, type, filename, content_type, size_bytes, sha256,
                                    storage_key, scan_status, uploaded_by, classification)
           VALUES ($1, 'invoice', $2, $3, $4, $5, $6, $7, $8, 'confidential')
           RETURNING id`,
          [
            requisition.id,
            file.filename,
            detected.contentType,
            buffer.length,
            sha,
            storageKey,
            verdict.status === 'infected' ? 'infected' : 'clean',
            user.id,
          ],
        );
        if (verdict.status === 'infected') {
          await writeAudit(client, {
            actorUserId: user.id,
            action: AuditAction.AttachmentQuarantined,
            entityType: 'attachment',
            entityId: attachment.rows[0]!.id,
            after: { filename: file.filename, signature: verdict.signature, requisitionId: requisition.id },
            ipAddress: req.ip,
            userAgent: req.headers['user-agent'] ?? null,
          });
          await queueNotification(client, {
            recipientUserId: user.id,
            template: NotificationTemplate.AttachmentQuarantined,
            reference: requisition.reference,
            deepLink: `/requisitions/${requisition.id}`,
          });
          return { code: 422 as const, error: 'file_failed_virus_scan' };
        }

        // Variance is CUMULATIVE against the approved amount (plan §5.4):
        // comparing each invoice in isolation would let N invoices, each
        // within tolerance, post N× the approved spend (adversarial-review
        // finding). Rejected invoices don't count toward the total.
        const approvedAmount = Number(requisition.amount);
        const priorTotal = Number(
          (
            await client.query<{ total: string }>(
              `SELECT coalesce(sum(amount), 0)::text AS total FROM invoices
               WHERE requisition_id = $1 AND status <> 'rejected'`,
              [requisition.id],
            )
          ).rows[0]!.total,
        );
        const cumulative = priorTotal + meta.data.amount;
        const variance = (cumulative - approvedAmount) / approvedAmount;
        // Over tolerance on the RUNNING TOTAL → the final approver must decide
        // again before Accounting can post (plan §5.4). The DB trigger (0010)
        // enforces the same rule and refuses any posting route that skips it.
        const needsReapproval = variance > tolerance;

        let reapprovalStepId: string | null = null;
        if (needsReapproval) {
          // Final approver = the last approved DOA step
          const finalApprover = await client.query<{ assigned_user_id: string }>(
            `SELECT assigned_user_id FROM approval_steps
             WHERE requisition_id = $1 AND purpose = 'doa' AND decision = 'approved'
             ORDER BY step_no DESC LIMIT 1`,
            [requisition.id],
          );
          if (finalApprover.rows.length === 0) return { code: 409 as const, error: 'no_final_approver_on_record' };
          const nextStepNo = await client.query<{ n: number }>(
            'SELECT coalesce(max(step_no), 0) + 1 AS n FROM approval_steps WHERE requisition_id = $1',
            [requisition.id],
          );
          const step = await client.query<{ id: string }>(
            `INSERT INTO approval_steps (requisition_id, step_no, assigned_role, assigned_user_id, purpose)
             VALUES ($1, $2, 'Variance re-approval', $3, 'variance_reapproval')
             RETURNING id`,
            [requisition.id, nextStepNo.rows[0]!.n, finalApprover.rows[0]!.assigned_user_id],
          );
          reapprovalStepId = step.rows[0]!.id;
          await queueNotification(client, {
            recipientUserId: finalApprover.rows[0]!.assigned_user_id,
            template: NotificationTemplate.VarianceReapprovalRequested,
            reference: requisition.reference,
            deepLink: `/approvals`,
          });
        }

        let invoice;
        try {
          invoice = await client.query<{ id: string }>(
            `INSERT INTO invoices (requisition_id, attachment_id, invoice_no, invoice_date, amount, currency,
                                   status, variance_vs_approved, submitted_by, reapproval_step_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             RETURNING id`,
            [
              requisition.id,
              attachment.rows[0]!.id,
              meta.data.invoiceNo,
              meta.data.invoiceDate,
              meta.data.amount,
              meta.data.currency,
              needsReapproval ? 'pending_reapproval' : 'submitted',
              variance.toFixed(4),
              user.id,
              reapprovalStepId,
            ],
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          // Same supplier invoice recorded twice = paid twice (0002 UNIQUE)
          if (message.includes('invoices_requisition_id_invoice_no_key')) {
            return { code: 409 as const, error: 'duplicate_invoice_no' };
          }
          throw err;
        }
        await writeAudit(client, {
          actorUserId: user.id,
          action: AuditAction.InvoiceSubmitted,
          entityType: 'invoice',
          entityId: invoice.rows[0]!.id,
          after: {
            requisitionId: requisition.id,
            reference: requisition.reference,
            invoiceNo: meta.data.invoiceNo,
            amount: meta.data.amount,
            variance: variance.toFixed(4),
            needsReapproval,
          },
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'] ?? null,
        });
        return {
          code: 201 as const,
          invoiceId: invoice.rows[0]!.id,
          variance: variance.toFixed(4),
          needsReapproval,
        };
      });

      if (outcome.code !== 201) {
        return reply
          .code(outcome.code)
          .send({ error: outcome.error, ...('message' in outcome ? { message: outcome.message } : {}) });
      }
      return reply.code(201).send({
        ok: true,
        invoiceId: outcome.invoiceId,
        variance: outcome.variance,
        needsReapproval: outcome.needsReapproval,
      });
    },
  );
}
