// Requisition lifecycle (plan §5.1–§5.3): draft → submit → (approval chain)
// → approved/denied → closed, plus cancellation as a status (A.5.33).
// Cost-centre scoping is enforced here AND by RLS (A.5.15 / A.8.3): fetching
// another cost centre's requisition returns 404 — never data, never existence.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import { withUserContext, type Db } from '../db/pool.js';
import { AuditAction, writeAudit } from '../audit/audit.js';
import { canAccessCostCentre, hasRole, requireAuth } from '../plugins/rbac.js';
import { buildSnapshot, DoaError, resolveChain, resolveRule } from '../doa/engine.js';
import { budgetPosition, categoryAvailable, currentPeriod } from '../budgets/position.js';
import { readSetting } from '../settings.js';
import { NotificationTemplate, queueNotification } from '../notify/notifier.js';
import { buildApprovalCertificate } from '../certificates/certificate.js';

const draftBody = z.object({
  costCentreId: z.string().uuid(),
  categoryId: z.string().uuid(),
  supplierId: z.string().uuid().nullish(),
  description: z.string().min(3).max(2000),
  justification: z.string().min(3).max(4000),
  amount: z.coerce.number().positive().multipleOf(0.01).max(999_999_999_999.99),
  currency: z.string().length(3).transform((c) => c.toUpperCase()),
  neededBy: z.coerce.date().nullish(),
});

/** MM-<PREFIX>-<YYYY>-<seq>: prefix = first segment of the cost centre code
 * (LEA-FLT → LEA). Alignment with any existing Massy PO series is
 * TODO(client) — ASSUMPTIONS §2.6. */
function referencePrefix(costCentreCode: string): string {
  return costCentreCode.split('-')[0]!.toUpperCase();
}

export default async function requisitionRoutes(app: FastifyInstance, opts: { db: Db; config: Config }) {
  const { db } = opts;

  // ── List (own + scoped) ────────────────────────────────────────────────────
  app.get('/api/requisitions', { preHandler: requireAuth() }, async (req, reply) => {
    const user = req.currentUser!;
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(200).default(50),
        status: z.enum(['draft', 'submitted', 'approved', 'denied', 'closed', 'cancelled']).optional(),
        costCentreId: z.string().uuid().optional(),
        mine: z.coerce.boolean().default(false),
      })
      .safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_request' });

    const rows = await withUserContext(db, user.id, async (client) => {
      const result = await client.query(
        `SELECT r.id, r.reference, r.status, r.amount, r.currency, r.description,
                r.classification, r.created_at, r.submitted_at, r.approved_at,
                r.approval_reference, r.needed_by,
                cc.code AS cost_centre_code, cat.code AS category_code,
                u.display_name AS requester_name, s.name AS supplier_name
         FROM requisitions r
         JOIN cost_centres cc ON cc.id = r.cost_centre_id
         JOIN categories cat ON cat.id = r.category_id
         JOIN users u ON u.id = r.requester_id
         LEFT JOIN suppliers s ON s.id = r.supplier_id
         WHERE ($1::requisition_status IS NULL OR r.status = $1)
           AND ($4::uuid IS NULL OR r.cost_centre_id = $4)
           AND (r.requester_id = $2 OR ($5 = false AND app_user_can_read_cost_centre(r.cost_centre_id)))
         ORDER BY r.created_at DESC
         LIMIT $3`,
        [query.data.status ?? null, user.id, query.data.limit, query.data.costCentreId ?? null, query.data.mine],
      );
      return result.rows;
    });
    return { requisitions: rows };
  });

  // ── Detail: requisition + approval trail + attachments + invoices ──────────
  app.get('/api/requisitions/:id', { preHandler: requireAuth() }, async (req, reply) => {
    const user = req.currentUser!;
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: 'not_found' });

    const detail = await withUserContext(db, user.id, async (client) => {
      const result = await client.query<{
        id: string;
        requester_id: string;
        cost_centre_id: string;
        [k: string]: unknown;
      }>(
        `SELECT r.*, cc.code AS cost_centre_code, cc.name AS cost_centre_name,
                cat.code AS category_code, cat.name AS category_name,
                u.display_name AS requester_name, s.name AS supplier_name
         FROM requisitions r
         JOIN cost_centres cc ON cc.id = r.cost_centre_id
         JOIN categories cat ON cat.id = r.category_id
         JOIN users u ON u.id = r.requester_id
         LEFT JOIN suppliers s ON s.id = r.supplier_id
         WHERE r.id = $1`,
        [params.data.id],
      );
      const row = result.rows[0];
      if (!row) return null;
      const [steps, attachments, invoices] = await Promise.all([
        client.query(
          `SELECT st.id, st.step_no, st.assigned_role, st.decision, st.decision_reason,
                  st.decided_at, st.purpose, st.budget_remaining_at_decision,
                  au.display_name AS assigned_name, au.job_title AS assigned_job_title,
                  du.display_name AS delegate_of_name
           FROM approval_steps st
           LEFT JOIN users au ON au.id = st.assigned_user_id
           LEFT JOIN users du ON du.id = st.delegate_of_user_id
           WHERE st.requisition_id = $1
           ORDER BY st.step_no`,
          [row.id],
        ),
        client.query(
          `SELECT a.id, a.type, a.filename, a.content_type, a.size_bytes, a.scan_status,
                  a.classification, a.uploaded_at, u.display_name AS uploaded_by_name
           FROM attachments a
           JOIN users u ON u.id = a.uploaded_by
           WHERE a.requisition_id = $1
           ORDER BY a.uploaded_at`,
          [row.id],
        ),
        client.query(
          `SELECT i.id, i.invoice_no, i.invoice_date, i.amount, i.currency, i.status,
                  i.variance_vs_approved, i.cdk_reference, i.posted_at, i.created_at,
                  i.attachment_id, i.rejection_reason, i.rejected_at
           FROM invoices i
           WHERE i.requisition_id = $1
           ORDER BY i.created_at`,
          [row.id],
        ),
      ]);
      return { row, steps: steps.rows, attachments: attachments.rows, invoices: invoices.rows };
    });

    // Not found and not-yours are the same answer (A.5.15): 404, never data.
    if (
      !detail ||
      (detail.row.requester_id !== user.id && !canAccessCostCentre(user, detail.row.cost_centre_id))
    ) {
      if (detail) {
        await writeAudit(db, {
          actorUserId: user.id,
          action: AuditAction.AccessDenied,
          entityType: 'requisition',
          entityId: params.data.id,
          after: { reason: 'cost_centre_scope' },
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'] ?? null,
        });
      }
      return reply.code(404).send({ error: 'not_found' });
    }
    return {
      requisition: detail.row,
      steps: detail.steps,
      attachments: detail.attachments,
      invoices: detail.invoices,
    };
  });

  // ── Live preview for the form (plan §5.1): who will approve + budget after ─
  app.post('/api/requisitions/preview', { preHandler: requireAuth() }, async (req, reply) => {
    const user = req.currentUser!;
    const body = z
      .object({
        costCentreId: z.string().uuid(),
        categoryId: z.string().uuid(),
        amount: z.coerce.number().positive(),
        currency: z.string().length(3).transform((c) => c.toUpperCase()),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request' });
    if (!hasRole(user, 'requester', body.data.costCentreId)) {
      return reply.code(403).send({ error: 'forbidden' });
    }

    return withUserContext(db, user.id, async (client) => {
      const period = await currentPeriod(client);
      const budget = await categoryAvailable(client, body.data.costCentreId, body.data.categoryId, period);
      try {
        const rule = await resolveRule(client, { ...body.data });
        const chain = await resolveChain(client, rule, body.data.costCentreId, user.id);
        return {
          route: chain.steps.map((s) => ({
            stepNo: s.stepNo,
            label: s.descriptor.label ?? s.descriptor.value,
            approverName: s.displayName,
            approverJobTitle: s.jobTitle,
          })),
          flags: chain.flags.map((f) => f.type),
          requiresQuotes: rule.requiresQuotes,
          budget: {
            period,
            available: budget.available.toFixed(2),
            afterThisRequest: (budget.available - body.data.amount).toFixed(2),
          },
        };
      } catch (err) {
        if (err instanceof DoaError) {
          return {
            route: null,
            routeError: { code: err.code, message: err.message },
            requiresQuotes: null,
            budget: {
              period,
              available: budget.available.toFixed(2),
              afterThisRequest: (budget.available - body.data.amount).toFixed(2),
            },
          };
        }
        throw err;
      }
    });
  });

  // ── Create draft ───────────────────────────────────────────────────────────
  app.post('/api/requisitions', { preHandler: requireAuth() }, async (req, reply) => {
    const user = req.currentUser!;
    const body = draftBody.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_request', message: body.error.issues[0]?.message });
    }
    if (!hasRole(user, 'requester', body.data.costCentreId)) {
      return reply.code(403).send({ error: 'forbidden' });
    }

    const base = await readSetting(db, 'base_currency');
    if (body.data.currency !== base) {
      return reply
        .code(400)
        .send({ error: 'currency_not_supported', message: `Only ${base} is supported (ASSUMPTIONS §2.1)` });
    }

    const created = await withUserContext(db, user.id, async (client) => {
      const cc = await client.query<{ code: string; active: boolean }>(
        'SELECT code, active FROM cost_centres WHERE id = $1',
        [body.data.costCentreId],
      );
      if (!cc.rows[0]?.active) return { error: 'cost_centre_not_found' as const };
      const cat = await client.query<{ active: boolean }>('SELECT active FROM categories WHERE id = $1', [
        body.data.categoryId,
      ]);
      if (!cat.rows[0]?.active) return { error: 'category_not_found' as const };

      const ref = await client.query<{ r: string }>('SELECT next_reference($1, $2) AS r', [
        referencePrefix(cc.rows[0].code),
        new Date().getUTCFullYear(),
      ]);
      const inserted = await client.query<{ id: string; reference: string }>(
        `INSERT INTO requisitions (reference, requester_id, cost_centre_id, category_id, supplier_id,
                                   description, justification, amount, currency, needed_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id, reference`,
        [
          ref.rows[0]!.r,
          user.id,
          body.data.costCentreId,
          body.data.categoryId,
          body.data.supplierId ?? null,
          body.data.description,
          body.data.justification,
          body.data.amount,
          body.data.currency,
          body.data.neededBy ?? null,
        ],
      );
      await writeAudit(client, {
        actorUserId: user.id,
        action: AuditAction.RequisitionCreated,
        entityType: 'requisition',
        entityId: inserted.rows[0]!.id,
        after: { reference: inserted.rows[0]!.reference, amount: body.data.amount, status: 'draft' },
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
      });
      return { requisition: inserted.rows[0]! };
    });
    if ('error' in created) return reply.code(400).send({ error: created.error });
    return reply.code(201).send(created);
  });

  // ── Edit own draft ─────────────────────────────────────────────────────────
  app.patch('/api/requisitions/:id', { preHandler: requireAuth() }, async (req, reply) => {
    const user = req.currentUser!;
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: 'not_found' });
    const body = draftBody.partial().safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_request', message: body.error.issues[0]?.message });
    }
    if (body.data.currency) {
      const base = await readSetting(db, 'base_currency');
      if (body.data.currency !== base) return reply.code(400).send({ error: 'currency_not_supported' });
    }
    if (body.data.costCentreId && !hasRole(user, 'requester', body.data.costCentreId)) {
      return reply.code(403).send({ error: 'forbidden' });
    }

    const result = await withUserContext(db, user.id, async (client) => {
      const existing = await client.query<{ id: string; requester_id: string; status: string; [k: string]: unknown }>(
        'SELECT * FROM requisitions WHERE id = $1 FOR UPDATE',
        [params.data.id],
      );
      const row = existing.rows[0];
      if (!row || row.requester_id !== user.id) return { code: 404 as const };
      if (row.status !== 'draft') return { code: 409 as const, error: 'only_drafts_are_editable' };

      const d = body.data;
      const updated = await client.query(
        `UPDATE requisitions SET
           cost_centre_id = coalesce($2, cost_centre_id),
           category_id    = coalesce($3, category_id),
           supplier_id    = CASE WHEN $9 THEN $4::uuid ELSE supplier_id END,
           description    = coalesce($5, description),
           justification  = coalesce($6, justification),
           amount         = coalesce($7, amount),
           needed_by      = CASE WHEN $10 THEN $8::date ELSE needed_by END,
           updated_at     = now()
         WHERE id = $1 RETURNING id, reference, status`,
        [
          row.id,
          d.costCentreId ?? null,
          d.categoryId ?? null,
          d.supplierId ?? null,
          d.description ?? null,
          d.justification ?? null,
          d.amount ?? null,
          d.neededBy ?? null,
          d.supplierId !== undefined,
          d.neededBy !== undefined,
        ],
      );
      await writeAudit(client, {
        actorUserId: user.id,
        action: AuditAction.RequisitionUpdated,
        entityType: 'requisition',
        entityId: row.id,
        before: { amount: row.amount, description: row.description },
        after: { ...d },
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
      });
      return { code: 200 as const, requisition: updated.rows[0] };
    });
    if (result.code !== 200) return reply.code(result.code).send({ error: 'error' in result ? result.error : 'not_found' });
    return { requisition: result.requisition };
  });

  // ── Submit (plan §5.1): freeze the rule, build the chain, gate on quotes ───
  app.post('/api/requisitions/:id/submit', { preHandler: requireAuth() }, async (req, reply) => {
    const user = req.currentUser!;
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: 'not_found' });

    const outcome = await withUserContext(db, user.id, async (client) => {
      const existing = await client.query<{
        id: string;
        reference: string;
        requester_id: string;
        cost_centre_id: string;
        category_id: string;
        amount: string;
        currency: string;
        status: string;
      }>('SELECT * FROM requisitions WHERE id = $1 FOR UPDATE', [params.data.id]);
      const row = existing.rows[0];
      if (!row || row.requester_id !== user.id) return { code: 404 as const, error: 'not_found' };
      if (row.status !== 'draft') return { code: 409 as const, error: 'only_drafts_can_be_submitted' };

      let rule, chain;
      try {
        rule = await resolveRule(client, {
          categoryId: row.category_id,
          costCentreId: row.cost_centre_id,
          amount: Number(row.amount),
          currency: row.currency,
        });
        chain = await resolveChain(client, rule, row.cost_centre_id, user.id);
      } catch (err) {
        if (err instanceof DoaError) return { code: 422 as const, error: err.code, message: err.message };
        throw err;
      }

      // Quote gate (plan §5.1): only clean-scanned quotes count (A.8.7 — a
      // file that has not passed the scanner does not exist yet).
      if (rule.requiresQuotes > 0) {
        const quotes = await client.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM attachments
           WHERE requisition_id = $1 AND type = 'quote' AND scan_status = 'clean'`,
          [row.id],
        );
        const have = Number(quotes.rows[0]!.n);
        if (have < rule.requiresQuotes) {
          return {
            code: 422 as const,
            error: 'quotes_required',
            message: `This amount requires ${rule.requiresQuotes} quote attachment(s); ${have} clean-scanned quote(s) present`,
          };
        }
      }

      const snapshot = buildSnapshot(rule, chain);
      await client.query(
        `UPDATE requisitions
         SET status = 'submitted', submitted_at = now(), doa_version_id = $2,
             doa_rule_snapshot = $3, workflow_flags = $4, updated_at = now()
         WHERE id = $1`,
        [row.id, rule.versionId, JSON.stringify(snapshot), JSON.stringify(chain.flags)],
      );
      for (const step of chain.steps) {
        await client.query(
          `INSERT INTO approval_steps (requisition_id, step_no, assigned_role, assigned_user_id)
           VALUES ($1, $2, $3, $4)`,
          [row.id, step.stepNo, step.descriptor.label ?? step.descriptor.value, step.userId],
        );
      }
      await queueNotification(client, {
        recipientUserId: chain.steps[0]!.userId,
        template: NotificationTemplate.ApprovalRequested,
        reference: row.reference,
        deepLink: `/approvals`,
      });
      await writeAudit(client, {
        actorUserId: user.id,
        action: AuditAction.RequisitionSubmitted,
        entityType: 'requisition',
        entityId: row.id,
        after: {
          reference: row.reference,
          doaVersionNo: rule.versionNo,
          steps: chain.steps.map((s) => ({ stepNo: s.stepNo, userId: s.userId })),
          flags: chain.flags,
        },
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
      });
      return {
        code: 200 as const,
        route: chain.steps.map((s) => ({ stepNo: s.stepNo, approverName: s.displayName })),
        flags: chain.flags,
      };
    });

    if (outcome.code !== 200) {
      return reply
        .code(outcome.code)
        .send({ error: outcome.error, ...('message' in outcome ? { message: outcome.message } : {}) });
    }
    return { ok: true, route: outcome.route, flags: outcome.flags };
  });

  // ── Cancel (a status, never a delete — A.5.33) ─────────────────────────────
  app.post('/api/requisitions/:id/cancel', { preHandler: requireAuth() }, async (req, reply) => {
    const user = req.currentUser!;
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const body = z.object({ reason: z.string().min(3).max(1000) }).safeParse(req.body);
    if (!params.success) return reply.code(404).send({ error: 'not_found' });
    if (!body.success) return reply.code(400).send({ error: 'reason_required' });

    const outcome = await withUserContext(db, user.id, async (client) => {
      const existing = await client.query<{
        id: string;
        reference: string;
        requester_id: string;
        cost_centre_id: string;
        status: string;
      }>('SELECT id, reference, requester_id, cost_centre_id, status FROM requisitions WHERE id = $1 FOR UPDATE', [
        params.data.id,
      ]);
      const row = existing.rows[0];
      if (!row || row.requester_id !== user.id) return { code: 404 as const };
      if (!['draft', 'submitted', 'approved'].includes(row.status)) {
        return { code: 409 as const, error: 'not_cancellable' };
      }
      // Cancelling withdraws the spend authority, so it must not strand an
      // invoice that Accounting could still post (adversarial-review finding).
      // Reject or post the invoice first.
      const liveInvoices = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM invoices
         WHERE requisition_id = $1 AND status IN ('submitted', 'pending_reapproval')`,
        [row.id],
      );
      if (Number(liveInvoices.rows[0]!.n) > 0) {
        return {
          code: 409 as const,
          error: 'open_invoices_exist',
          message:
            'An invoice on this requisition is still awaiting posting — ask Accounting to post or reject it before cancelling',
        };
      }
      await client.query(
        `UPDATE requisitions SET status = 'cancelled', closed_at = now(), updated_at = now() WHERE id = $1`,
        [row.id],
      );
      await writeAudit(client, {
        actorUserId: user.id,
        action: AuditAction.RequisitionCancelled,
        entityType: 'requisition',
        entityId: row.id,
        before: { status: row.status },
        after: { status: 'cancelled', reason: body.data.reason },
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
      });
      return { code: 200 as const, wasApproved: row.status === 'approved', costCentreId: row.cost_centre_id };
    });
    if (outcome.code !== 200) {
      return reply.code(outcome.code).send({
        error: 'error' in outcome ? outcome.error : 'not_found',
        ...('message' in outcome ? { message: outcome.message } : {}),
      });
    }
    if (outcome.wasApproved) {
      // Commitment released — update every open budget screen (plan §5.9)
      const { eventBus } = await import('../events/bus.js');
      eventBus.emitBudgetChanged({ costCentreId: outcome.costCentreId, cause: 'requisition_released' });
    }
    return { ok: true };
  });

  // ── Approval certificate PDF (plan §5.3, labelled per A.5.13) ──────────────
  app.get(
    '/api/requisitions/:id/certificate.pdf',
    { preHandler: requireAuth(), config: { rateLimit: { max: 30, timeWindow: '1 hour' } } },
    async (req, reply) => {
      const user = req.currentUser!;
      const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
      if (!params.success) return reply.code(404).send({ error: 'not_found' });

      const data = await withUserContext(db, user.id, async (client) => {
        const result = await client.query<{
          id: string;
          reference: string;
          approval_reference: string | null;
          requester_id: string;
          cost_centre_id: string;
          status: string;
          description: string;
          amount: string;
          currency: string;
          approved_at: Date | null;
          cost_centre_code: string;
          category_name: string;
          supplier_name: string | null;
          requester_name: string;
        }>(
          `SELECT r.id, r.reference, r.approval_reference, r.requester_id, r.cost_centre_id,
                  r.status, r.description, r.amount, r.currency, r.approved_at,
                  cc.code AS cost_centre_code, cat.name AS category_name,
                  s.name AS supplier_name, u.display_name AS requester_name
           FROM requisitions r
           JOIN cost_centres cc ON cc.id = r.cost_centre_id
           JOIN categories cat ON cat.id = r.category_id
           JOIN users u ON u.id = r.requester_id
           LEFT JOIN suppliers s ON s.id = r.supplier_id
           WHERE r.id = $1`,
          [params.data.id],
        );
        const row = result.rows[0];
        if (!row) return null;
        const steps = await client.query<{ step_no: number; assigned_role: string | null; decided_at: Date | null; display_name: string | null; job_title: string | null }>(
          `SELECT st.step_no, st.assigned_role, st.decided_at, u.display_name, u.job_title
           FROM approval_steps st LEFT JOIN users u ON u.id = st.assigned_user_id
           WHERE st.requisition_id = $1 AND st.decision = 'approved' AND st.purpose = 'doa'
           ORDER BY st.step_no`,
          [row.id],
        );
        return { row, steps: steps.rows };
      });

      if (!data || (data.row.requester_id !== user.id && !canAccessCostCentre(user, data.row.cost_centre_id))) {
        return reply.code(404).send({ error: 'not_found' });
      }
      if (!data.row.approval_reference || !['approved', 'closed'].includes(data.row.status)) {
        return reply.code(409).send({ error: 'not_approved' });
      }

      const pdf = await buildApprovalCertificate({
        reference: data.row.reference,
        approvalReference: data.row.approval_reference,
        approvedAt: data.row.approved_at!,
        costCentreCode: data.row.cost_centre_code,
        categoryName: data.row.category_name,
        supplierName: data.row.supplier_name,
        description: data.row.description,
        amount: data.row.amount,
        currency: data.row.currency,
        requesterName: data.row.requester_name,
        approvers: data.steps.map((s) => ({
          stepNo: s.step_no,
          role: s.assigned_role,
          name: s.display_name,
          jobTitle: s.job_title,
          decidedAt: s.decided_at,
        })),
        exportedBy: `${user.displayName} <${user.email}>`,
      });

      // A.8.12: every export is a data leakage event
      await writeAudit(db, {
        actorUserId: user.id,
        action: AuditAction.Export,
        entityType: 'export',
        entityId: `approval-certificate:${data.row.reference}`,
        after: { format: 'pdf', rowCount: 1 },
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
      });
      return reply
        .header('content-disposition', `attachment; filename="${data.row.approval_reference}.pdf"`)
        .type('application/pdf')
        .send(pdf);
    },
  );

  // ── Budget position for a cost centre (plan §5.9 live tracker read) ────────
  app.get('/api/budget-position', { preHandler: requireAuth() }, async (req, reply) => {
    const user = req.currentUser!;
    const query = z
      .object({ costCentreId: z.string().uuid(), period: z.string().regex(/^FY\d{4}-Q[1-4]$/).optional() })
      .safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_request' });

    const allowed =
      canAccessCostCentre(user, query.data.costCentreId) ||
      hasRole(user, 'requester', query.data.costCentreId) ||
      hasRole(user, 'budget_owner', query.data.costCentreId) ||
      hasRole(user, 'budget_approver');
    if (!allowed) return reply.code(404).send({ error: 'not_found' });

    return withUserContext(db, user.id, async (client) => {
      const period = query.data.period ?? (await currentPeriod(client));
      return budgetPosition(client, query.data.costCentreId, period);
    });
  });

  // Reference data the shell needs (cost centres, categories, suppliers).
  app.get('/api/reference', { preHandler: requireAuth() }, async () => {
    const [costCentres, categories, suppliers] = await Promise.all([
      db.query('SELECT id, code, name, department FROM cost_centres WHERE active ORDER BY code'),
      db.query('SELECT id, code, name FROM categories WHERE active ORDER BY code'),
      db.query(`SELECT id, name FROM suppliers WHERE status = 'active' ORDER BY name`),
    ]);
    return { costCentres: costCentres.rows, categories: categories.rows, suppliers: suppliers.rows };
  });
}
