// Approval routing (plan §5.2–§5.3) and delegation. Sequential by default:
// step N is decidable only when every earlier step is approved. Any denial
// ends the chain with a mandatory reason. Nothing is ever auto-approved.
// Segregation of duties (A.5.3) is enforced here in code:
//   - requester ≠ approver: 403 + audit entry (the §8.1 acceptance test)
//   - nobody approves against a DOA version they uploaded or activated
// Variance re-approval steps (plan §5.4) are decided through the same
// endpoints and resolve the linked invoice instead of the requisition.
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import type { Config } from '../config.js';
import { withUserContext, type Db } from '../db/pool.js';
import { AuditAction, raiseAlert, writeAudit } from '../audit/audit.js';
import { hasRole, hasRoleAnywhere, requireAuth } from '../plugins/rbac.js';
import { categoryAvailable, currentPeriod } from '../budgets/position.js';
import { NotificationTemplate, queueNotification } from '../notify/notifier.js';
import { eventBus } from '../events/bus.js';

interface StepRow {
  id: string;
  requisition_id: string;
  step_no: number;
  assigned_user_id: string | null;
  decision: string;
  purpose: string;
  req_status: string;
  req_reference: string;
  requester_id: string;
  cost_centre_id: string;
  category_id: string;
  amount: string;
  currency: string;
  doa_version_id: string | null;
  doa_uploaded_by: string | null;
  doa_approved_by: string | null;
  invoice_id: string | null;
  invoice_amount: string | null;
}

const STEP_QUERY = `
  SELECT st.id, st.requisition_id, st.step_no, st.assigned_user_id, st.decision, st.purpose,
         r.status AS req_status, r.reference AS req_reference, r.requester_id,
         r.cost_centre_id, r.category_id, r.amount, r.currency, r.doa_version_id,
         dv.uploaded_by AS doa_uploaded_by, dv.approved_by AS doa_approved_by,
         i.id AS invoice_id, i.amount AS invoice_amount
  FROM approval_steps st
  JOIN requisitions r ON r.id = st.requisition_id
  LEFT JOIN doa_matrix_versions dv ON dv.id = r.doa_version_id
  LEFT JOIN invoices i ON i.reapproval_step_id = st.id
  WHERE st.id = $1
  FOR UPDATE OF st, r`;

/** What approving this step would newly take out of the budget.
 *  - DOA step: the requisition amount (nothing is committed pre-approval).
 *  - Variance re-approval: only the excess beyond what the approval already
 *    committed. The live position carries the approved amount in `committed`
 *    already, so charging the requisition amount again double-counted the
 *    same money — and showed the approver a number unrelated to the invoice
 *    they were deciding (review finding).
 */
async function stepBudgetImpact(
  client: Pick<pg.PoolClient, 'query'>,
  step: { purpose: string; amount: string; requisition_id: string; invoice_amount?: string | null },
): Promise<number> {
  if (step.purpose !== 'variance_reapproval') return Number(step.amount);
  const posted = await client.query<{ total: string }>(
    `SELECT coalesce(sum(amount), 0)::text AS total FROM invoices
     WHERE requisition_id = $1 AND status = 'posted'`,
    [step.requisition_id],
  );
  const remainingCommitment = Math.max(0, Number(step.amount) - Number(posted.rows[0]!.total));
  return Math.max(0, Number(step.invoice_amount ?? 0) - remainingCommitment);
}

export default async function approvalRoutes(app: FastifyInstance, opts: { db: Db; config: Config }) {
  const { db } = opts;

  // ── My queue: pending steps assigned to me or delegable to me ──────────────
  app.get('/api/approvals/queue', { preHandler: requireAuth() }, async (req) => {
    const user = req.currentUser!;
    const rows = await withUserContext(db, user.id, async (client) => {
      const result = await client.query(
        `SELECT st.id AS step_id, st.step_no, st.purpose, st.assigned_user_id,
                (st.assigned_user_id <> $1 AND st.purpose <> 'finance_review') AS via_delegation,
                r.id AS requisition_id, r.reference, r.description, r.amount, r.currency,
                r.submitted_at, r.needed_by, r.status AS requisition_status,
                cc.code AS cost_centre_code, cc.department AS department,
                cat.code AS category_code, cat.name AS category_name,
                u.display_name AS requester_name, s.name AS supplier_name,
                i.id AS invoice_id, i.invoice_no, i.amount AS invoice_amount,
                i.variance_vs_approved
         FROM approval_steps st
         JOIN requisitions r ON r.id = st.requisition_id
         JOIN cost_centres cc ON cc.id = r.cost_centre_id
         JOIN categories cat ON cat.id = r.category_id
         JOIN users u ON u.id = r.requester_id
         LEFT JOIN suppliers s ON s.id = r.supplier_id
         LEFT JOIN invoices i ON i.reapproval_step_id = st.id
         WHERE st.decision = 'pending'
           AND (
             -- Steps addressed to me, or delegable to me. The approver role
             -- must still be held: a revoked grant empties the queue on the
             -- next request (A.5.18, adversarial-review finding).
             ((st.assigned_user_id = $1
               OR app_user_is_delegate_for(st.assigned_user_id, r.cost_centre_id))
              AND (
                (st.purpose = 'doa' AND r.status = 'submitted'
                 AND app_user_has_role('approver', r.cost_centre_id)
                 AND NOT EXISTS (SELECT 1 FROM approval_steps prev
                                 WHERE prev.requisition_id = st.requisition_id
                                   AND prev.purpose = 'doa'
                                   AND prev.step_no < st.step_no
                                   AND prev.decision <> 'approved'))
                -- The invoice must still be WAITING on this decision: Accounting
                -- rejecting it resolves the matter, and the step must not linger
                -- as a ghost work item (review finding).
                OR (st.purpose = 'variance_reapproval' AND r.status IN ('approved', 'closed')
                    AND app_user_has_role('approver', r.cost_centre_id)
                    AND i.status = 'pending_reapproval')
              ))
             -- finance_review steps belong to the org-wide accounting ROLE,
             -- not a person (client change list: Accounts is the final
             -- hurdle). Any active accounting holder sees and may decide
             -- them: accounting can never hold 'approver' (SoD), so
             -- delegation cannot cover an absence — a person-addressed final
             -- hurdle would freeze every requisition while its one assignee
             -- is away (adversarial-review finding).
             OR (st.purpose = 'finance_review' AND r.status = 'submitted'
                 AND app_user_has_role('accounting')
                 AND NOT EXISTS (SELECT 1 FROM approval_steps prev
                                 WHERE prev.requisition_id = st.requisition_id
                                   AND prev.purpose = 'doa'
                                   AND prev.decision <> 'approved'))
           )
         ORDER BY r.submitted_at NULLS LAST, st.step_no`,
        [user.id],
      );
      return result.rows;
    });
    return { queue: rows };
  });

  // ── Step detail with the budget impact the approver must see (plan §5.2) ───
  app.get('/api/approvals/steps/:id', { preHandler: requireAuth() }, async (req, reply) => {
    const user = req.currentUser!;
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: 'not_found' });

    const detail = await withUserContext(db, user.id, async (client) => {
      const step = await client.query(
        `SELECT st.id, st.step_no, st.purpose, st.decision, st.assigned_user_id,
                r.id AS requisition_id, r.reference, r.description, r.justification,
                r.amount, r.currency, r.status AS requisition_status, r.needed_by,
                r.cost_centre_id, r.category_id, r.doa_rule_snapshot, r.workflow_flags,
                cc.code AS cost_centre_code, cat.code AS category_code, cat.name AS category_name,
                u.display_name AS requester_name, s.name AS supplier_name,
                i.invoice_no, i.amount AS invoice_amount, i.variance_vs_approved,
                i.status AS invoice_status
         FROM approval_steps st
         JOIN requisitions r ON r.id = st.requisition_id
         JOIN cost_centres cc ON cc.id = r.cost_centre_id
         JOIN categories cat ON cat.id = r.category_id
         JOIN users u ON u.id = r.requester_id
         LEFT JOIN suppliers s ON s.id = r.supplier_id
         LEFT JOIN invoices i ON i.reapproval_step_id = st.id
         WHERE st.id = $1`,
        [params.data.id],
      );
      const row = step.rows[0] as
        | {
            assigned_user_id: string;
            cost_centre_id: string;
            category_id: string;
            amount: string;
            purpose: string;
            requisition_id: string;
            invoice_amount: string | null;
            [k: string]: unknown;
          }
        | undefined;
      if (!row) return null;
      const period = await currentPeriod(client);
      const budget = await categoryAvailable(client, row.cost_centre_id, row.category_id, period);
      const impact = await stepBudgetImpact(client, row);
      return {
        step: row,
        budget: {
          period,
          available: budget.available.toFixed(2),
          afterApproval: (budget.available - impact).toFixed(2),
          // For variance steps: the spend beyond the already-committed
          // approval this decision would newly authorise.
          incrementalImpact: impact.toFixed(2),
        },
      };
    });
    if (!detail) return reply.code(404).send({ error: 'not_found' });
    return detail;
  });

  const decide = (kind: 'approve' | 'deny') =>
    async function handler(req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) {
      const user = req.currentUser!;
      const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
      if (!params.success) return reply.code(404).send({ error: 'not_found' });
      const body = z
        .object({ reason: z.string().min(3).max(2000).optional() })
        .safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: 'invalid_request' });
      // Plan §5.2: a reason is MANDATORY on denial
      if (kind === 'deny' && !body.data.reason) {
        return reply.code(400).send({ error: 'denial_reason_required' });
      }

      const outcome = await withUserContext(db, user.id, async (client) => {
        const found = await client.query<StepRow>(STEP_QUERY, [params.data.id]);
        const step = found.rows[0];
        if (!step) return { code: 404 as const, error: 'not_found' };
        if (step.decision !== 'pending') return { code: 409 as const, error: 'already_decided' };

        // ── A.5.3: requester ≠ approver — checked FIRST so a self-approval
        //    attempt is always reported (and alerted on) as exactly that ─────
        if (step.requester_id === user.id) {
          await writeAudit(client, {
            actorUserId: user.id,
            action: AuditAction.SelfApprovalBlocked,
            entityType: 'approval_step',
            entityId: step.id,
            after: { requisitionId: step.requisition_id, reference: step.req_reference },
            ipAddress: req.ip,
            userAgent: req.headers['user-agent'] ?? null,
          });
          await raiseAlert(client, 'self_approval_attempt', 'warning', {
            actorUserId: user.id,
            requisitionId: step.requisition_id,
          });
          return { code: 403 as const, error: 'self_approval_forbidden' };
        }

        // ── Authority is re-proved on every decision (A.5.15, A.5.18) ───────
        // Being the assignee is not enough: the required role must still be
        // held right now. A revoked grant must lose decision power within one
        // request, including on steps assigned before the revocation
        // (adversarial-review finding). finance_review steps are decided by
        // the org-wide accounting role, everything else by the approver role
        // for the requisition's cost centre.
        const requiredRoleHeld =
          step.purpose === 'finance_review'
            ? hasRole(user, 'accounting')
            : hasRole(user, 'approver', step.cost_centre_id);
        if (!requiredRoleHeld) {
          const reason =
            step.purpose === 'finance_review' ? 'accounting_role_not_held' : 'approver_role_not_held';
          await writeAudit(client, {
            actorUserId: user.id,
            action: AuditAction.AccessDenied,
            entityType: 'approval_step',
            entityId: step.id,
            after: { reason, costCentreId: step.cost_centre_id },
            ipAddress: req.ip,
            userAgent: req.headers['user-agent'] ?? null,
          });
          return { code: 403 as const, error: reason };
        }

        // ── Who may decide: the assignee, or their live delegate ────────────
        // finance_review steps are role-addressed instead: ANY current
        // accounting holder may decide (the role gate above), because
        // accounting can never hold 'approver' (SoD) and so can never
        // delegate — a person-addressed final hurdle would freeze every
        // requisition while its one assignee is away (adversarial-review
        // finding). The decision UPDATE below stamps the actual decider
        // into assigned_user_id, so the record shows who decided.
        let delegateOf: string | null = null;
        if (step.assigned_user_id !== user.id && step.purpose !== 'finance_review') {
          const delegation = await client.query<{ id: string }>(
            `SELECT id FROM delegations
             WHERE delegator_id = $1 AND delegate_id = $2 AND revoked_at IS NULL
               AND now() >= starts_at AND now() < ends_at
               AND (cost_centre_id IS NULL OR cost_centre_id = $3)`,
            [step.assigned_user_id, user.id, step.cost_centre_id],
          );
          if (delegation.rows.length === 0) return { code: 404 as const, error: 'not_found' };
          delegateOf = step.assigned_user_id;
        }

        // ── §3: nobody approves against a DOA version they edited/activated ─
        // Applies to EVERY step purpose: a variance re-approval authorises
        // extra spend under the same version's authority (adversarial-review
        // finding). The role model also forbids the combination outright
        // (SoD trigger, migration 0010) — this is defence in depth.
        if (step.doa_uploaded_by === user.id || step.doa_approved_by === user.id) {
          await writeAudit(client, {
            actorUserId: user.id,
            action: AuditAction.DoaConflictBlocked,
            entityType: 'approval_step',
            entityId: step.id,
            after: { requisitionId: step.requisition_id, doaVersionId: step.doa_version_id },
            ipAddress: req.ip,
            userAgent: req.headers['user-agent'] ?? null,
          });
          return { code: 403 as const, error: 'doa_version_conflict' };
        }

        // ── Sequential gating ───────────────────────────────────────────────
        if (step.purpose === 'doa') {
          if (step.req_status !== 'submitted') return { code: 409 as const, error: 'requisition_not_open' };
          const blockers = await client.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM approval_steps
             WHERE requisition_id = $1 AND purpose = 'doa' AND step_no < $2 AND decision <> 'approved'`,
            [step.requisition_id, step.step_no],
          );
          if (Number(blockers.rows[0]!.n) > 0) return { code: 409 as const, error: 'previous_step_pending' };
        } else if (step.purpose === 'finance_review') {
          // Accounts reviews last: every DOA step must already be approved.
          if (step.req_status !== 'submitted') return { code: 409 as const, error: 'requisition_not_open' };
          const blockers = await client.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM approval_steps
             WHERE requisition_id = $1 AND purpose = 'doa' AND decision <> 'approved'`,
            [step.requisition_id],
          );
          if (Number(blockers.rows[0]!.n) > 0) return { code: 409 as const, error: 'previous_step_pending' };
        } else {
          // A variance re-approval only has meaning while the requisition's
          // approval is live: a cancelled requisition has no spend authority
          // to extend (adversarial-review finding).
          if (!['approved', 'closed'].includes(step.req_status)) {
            return { code: 409 as const, error: 'requisition_not_open' };
          }
        }

        // Budget impact recorded on the step (plan §4: the projected remaining
        // balance the approver accepted). For variance steps this is the
        // incremental excess, not the full requisition amount (see
        // stepBudgetImpact).
        const period = await currentPeriod(client);
        const budget = await categoryAvailable(client, step.cost_centre_id, step.category_id, period);
        const projectedRemaining = budget.available - (await stepBudgetImpact(client, step));

        await client.query(
          `UPDATE approval_steps
           SET decision = $2, decision_reason = $3, decided_at = now(),
               assigned_user_id = $4, delegate_of_user_id = $5,
               budget_remaining_at_decision = $6, ip_address = $7, user_agent = $8
           WHERE id = $1`,
          [
            step.id,
            kind === 'approve' ? 'approved' : 'denied',
            body.data.reason ?? null,
            user.id,
            delegateOf,
            projectedRemaining.toFixed(2),
            req.ip,
            req.headers['user-agent'] ?? null,
          ],
        );
        await writeAudit(client, {
          actorUserId: user.id,
          action: AuditAction.ApprovalStepDecided,
          entityType: 'approval_step',
          entityId: step.id,
          after: {
            requisitionId: step.requisition_id,
            reference: step.req_reference,
            stepNo: step.step_no,
            purpose: step.purpose,
            decision: kind === 'approve' ? 'approved' : 'denied',
            delegateOf,
            budgetRemainingAtDecision: projectedRemaining.toFixed(2),
          },
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'] ?? null,
        });

        // ── Variance re-approval resolves the linked invoice (plan §5.4) ────
        if (step.purpose === 'variance_reapproval') {
          // Only an invoice still awaiting this decision may be moved: an
          // invoice Accounting already rejected must never be resurrected by
          // a later approval (adversarial-review finding — that rejection is
          // Accounting's own SoD-separated call).
          const invoice = await client.query<{ id: string; invoice_no: string; submitted_by: string | null }>(
            kind === 'approve'
              ? `UPDATE invoices SET status = 'submitted'
                 WHERE reapproval_step_id = $1 AND status = 'pending_reapproval'
                 RETURNING id, invoice_no, submitted_by`
              : `UPDATE invoices
                 SET status = 'rejected', rejected_by = $2, rejected_at = now(), rejection_reason = $3
                 WHERE reapproval_step_id = $1 AND status = 'pending_reapproval'
                 RETURNING id, invoice_no, submitted_by`,
            kind === 'approve' ? [step.id] : [step.id, user.id, body.data.reason],
          );
          // The decision resolves someone else's work item — tell them
          // (review finding: this used to happen in complete silence).
          const resolved = invoice.rows[0];
          if (resolved?.submitted_by) {
            await queueNotification(client, {
              recipientUserId: resolved.submitted_by,
              template:
                kind === 'approve'
                  ? NotificationTemplate.InvoiceReapprovalApproved
                  : NotificationTemplate.InvoiceReapprovalRejected,
              reference: step.req_reference,
              deepLink: `/requisitions/${step.requisition_id}`,
            });
          }
          if (resolved && kind === 'approve') {
            // Accounting was waiting on this to post — tell them it is ready.
            const accountants = await client.query<{ user_id: string }>(
              `SELECT DISTINCT ra.user_id FROM roles_assignments ra
               JOIN users u ON u.id = ra.user_id AND u.status = 'active'
               WHERE ra.role = 'accounting' AND ra.revoked_at IS NULL`,
            );
            for (const a of accountants.rows) {
              await queueNotification(client, {
                recipientUserId: a.user_id,
                template: NotificationTemplate.InvoiceReapprovalApproved,
                reference: step.req_reference,
                deepLink: '/accounting',
              });
            }
          }
          await writeAudit(client, {
            actorUserId: user.id,
            action: AuditAction.InvoiceReapprovalDecided,
            entityType: 'invoice',
            entityId: invoice.rows[0]?.id ?? null,
            after: { decision: kind, requisitionId: step.requisition_id },
            ipAddress: req.ip,
            userAgent: req.headers['user-agent'] ?? null,
          });
          return { code: 200 as const, final: false, costCentreId: null };
        }

        if (kind === 'deny') {
          const denied = await client.query(
            `UPDATE requisitions SET status = 'denied', closed_at = now(), updated_at = now() WHERE id = $1`,
            [step.requisition_id],
          );
          // A zero-row UPDATE here means RLS filtered the row: committing
          // would record a denial that never persisted (audit, notification
          // and API response all diverging from the database — adversarial-
          // review finding). Throw → the transaction rolls back whole.
          if (denied.rowCount !== 1) {
            throw new Error(
              `requisition ${step.requisition_id} denial updated ${denied.rowCount ?? 0} rows — RLS misconfiguration`,
            );
          }
          await queueNotification(client, {
            recipientUserId: step.requester_id,
            template: NotificationTemplate.RequisitionDenied,
            reference: step.req_reference,
            deepLink: `/requisitions/${step.requisition_id}`,
          });
          await writeAudit(client, {
            actorUserId: user.id,
            action: AuditAction.RequisitionDenied,
            entityType: 'requisition',
            entityId: step.requisition_id,
            after: { reference: step.req_reference, deniedAtStep: step.step_no, reason: body.data.reason },
            ipAddress: req.ip,
            userAgent: req.headers['user-agent'] ?? null,
          });
          return { code: 200 as const, final: true, costCentreId: null };
        }

        // ── Approve: open the next step, or finalise ────────────────────────
        // The chain runs DOA steps first, then the accounting finance_review
        // step (when configured); only after ALL of them is the requisition
        // finalised.
        const next = await client.query<{ id: string; assigned_user_id: string; purpose: string }>(
          `SELECT id, assigned_user_id, purpose FROM approval_steps
           WHERE requisition_id = $1 AND purpose IN ('doa', 'finance_review')
             AND decision = 'pending' AND step_no > $2
           ORDER BY step_no LIMIT 1`,
          [step.requisition_id, step.step_no],
        );
        if (next.rows.length > 0) {
          const opened = next.rows[0]!;
          if (opened.purpose === 'finance_review') {
            // Role-addressed (see the queue): every active accounting holder
            // is told the final review is open, not just the nominal assignee.
            const accountants = await client.query<{ user_id: string }>(
              `SELECT DISTINCT ra.user_id FROM roles_assignments ra
               JOIN users u ON u.id = ra.user_id AND u.status = 'active'
               WHERE ra.role = 'accounting' AND ra.revoked_at IS NULL`,
            );
            for (const a of accountants.rows) {
              await queueNotification(client, {
                recipientUserId: a.user_id,
                template: NotificationTemplate.ApprovalRequested,
                reference: step.req_reference,
                deepLink: `/approvals`,
              });
            }
          } else {
            await queueNotification(client, {
              recipientUserId: opened.assigned_user_id,
              template: NotificationTemplate.ApprovalRequested,
              reference: step.req_reference,
              deepLink: `/approvals`,
            });
          }
          return { code: 200 as const, final: false, costCentreId: null };
        }

        // Final approval: issue the Approval Reference (plan §5.3) and commit
        // the amount against the budget (plan §4 design rule 2).
        const approvalReference = `${step.req_reference}-APR`;
        const finalised = await client.query(
          `UPDATE requisitions
           SET status = 'approved', approved_at = now(), approval_reference = $2, updated_at = now()
           WHERE id = $1`,
          [step.requisition_id, approvalReference],
        );
        // Same guard as the deny path: an RLS-filtered zero-row UPDATE must
        // roll the whole decision back, never commit a phantom approval.
        if (finalised.rowCount !== 1) {
          throw new Error(
            `requisition ${step.requisition_id} finalisation updated ${finalised.rowCount ?? 0} rows — RLS misconfiguration`,
          );
        }
        await queueNotification(client, {
          recipientUserId: step.requester_id,
          template: NotificationTemplate.RequisitionApproved,
          reference: step.req_reference,
          deepLink: `/requisitions/${step.requisition_id}`,
        });
        await writeAudit(client, {
          actorUserId: user.id,
          action: AuditAction.RequisitionApproved,
          entityType: 'requisition',
          entityId: step.requisition_id,
          after: {
            reference: step.req_reference,
            approvalReference,
            amount: step.amount,
            budgetRemainingAtDecision: projectedRemaining.toFixed(2),
          },
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'] ?? null,
        });
        return { code: 200 as const, final: true, approvalReference, costCentreId: step.cost_centre_id };
      });

      if (outcome.code !== 200) return reply.code(outcome.code).send({ error: outcome.error });
      // After commit: push the new position to every open budget screen (§5.9)
      if (outcome.costCentreId) {
        eventBus.emitBudgetChanged({ costCentreId: outcome.costCentreId, cause: 'requisition_approved' });
      }
      return reply.send({
        ok: true,
        final: outcome.final,
        ...('approvalReference' in outcome && outcome.approvalReference
          ? { approvalReference: outcome.approvalReference }
          : {}),
      });
    };

  app.post('/api/approvals/steps/:id/approve', { preHandler: requireAuth() }, decide('approve'));
  app.post('/api/approvals/steps/:id/deny', { preHandler: requireAuth() }, decide('deny'));

  // ── Delegation (plan §5.2) ────────────────────────────────────────────────
  app.get('/api/delegations', { preHandler: requireAuth() }, async (req) => {
    const user = req.currentUser!;
    const rows = await withUserContext(db, user.id, async (client) => {
      const result = await client.query(
        `SELECT d.id, d.delegator_id, d.delegate_id, d.cost_centre_id, d.starts_at, d.ends_at,
                d.reason, d.created_at, d.revoked_at,
                dr.display_name AS delegator_name, de.display_name AS delegate_name,
                cc.code AS cost_centre_code
         FROM delegations d
         JOIN users dr ON dr.id = d.delegator_id
         JOIN users de ON de.id = d.delegate_id
         LEFT JOIN cost_centres cc ON cc.id = d.cost_centre_id
         WHERE d.delegator_id = $1 OR d.delegate_id = $1
         ORDER BY d.created_at DESC`,
        [user.id],
      );
      return result.rows;
    });
    return { delegations: rows };
  });

  app.post('/api/delegations', { preHandler: requireAuth() }, async (req, reply) => {
    const user = req.currentUser!;
    const body = z
      .object({
        delegateEmail: z.string().email(),
        costCentreId: z.string().uuid().nullish(),
        startsAt: z.coerce.date(),
        endsAt: z.coerce.date(),
        reason: z.string().min(3).max(1000),
      })
      .refine((b) => b.endsAt > b.startsAt, { message: 'endsAt must be after startsAt' })
      .safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_request', message: body.error.issues[0]?.message });
    }
    // The delegator must hold the approver role in the delegation's scope
    if (body.data.costCentreId) {
      if (!hasRole(user, 'approver', body.data.costCentreId)) return reply.code(403).send({ error: 'forbidden' });
    } else if (!hasRoleAnywhere(user, 'approver')) {
      return reply.code(403).send({ error: 'forbidden' });
    }

    const delegate = await db.query<{ id: string; status: string }>(
      'SELECT id, status FROM users WHERE lower(email) = lower($1)',
      [body.data.delegateEmail],
    );
    const target = delegate.rows[0];
    if (!target || target.status !== 'active') return reply.code(400).send({ error: 'delegate_not_found' });
    if (target.id === user.id) return reply.code(400).send({ error: 'cannot_delegate_to_self' });
    // The delegate must themselves hold the approver role in scope (A.5.15:
    // delegation redirects work, it never mints authority).
    const delegateRoles = await db.query<{ cost_centre_id: string | null }>(
      `SELECT cost_centre_id FROM roles_assignments
       WHERE user_id = $1 AND role = 'approver' AND revoked_at IS NULL`,
      [target.id],
    );
    const delegateQualifies = body.data.costCentreId
      ? delegateRoles.rows.some((r) => r.cost_centre_id === null || r.cost_centre_id === body.data.costCentreId)
      : delegateRoles.rows.length > 0;
    if (!delegateQualifies) return reply.code(400).send({ error: 'delegate_lacks_approver_role' });

    const created = await withUserContext(db, user.id, async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO delegations (delegator_id, delegate_id, cost_centre_id, starts_at, ends_at, reason)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [user.id, target.id, body.data.costCentreId ?? null, body.data.startsAt, body.data.endsAt, body.data.reason],
      );
      await writeAudit(client, {
        actorUserId: user.id,
        action: AuditAction.DelegationCreated,
        entityType: 'delegation',
        entityId: inserted.rows[0]!.id,
        after: {
          delegateId: target.id,
          costCentreId: body.data.costCentreId ?? null,
          startsAt: body.data.startsAt.toISOString(),
          endsAt: body.data.endsAt.toISOString(),
          reason: body.data.reason,
        },
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
      });
      return inserted.rows[0]!.id;
    });
    return reply.code(201).send({ ok: true, delegationId: created });
  });

  app.post('/api/delegations/:id/revoke', { preHandler: requireAuth() }, async (req, reply) => {
    const user = req.currentUser!;
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: 'not_found' });

    const outcome = await withUserContext(db, user.id, async (client) => {
      const found = await client.query<{ id: string; delegator_id: string; revoked_at: Date | null }>(
        'SELECT id, delegator_id, revoked_at FROM delegations WHERE id = $1 FOR UPDATE',
        [params.data.id],
      );
      const row = found.rows[0];
      if (!row) return { code: 404 as const };
      if (row.delegator_id !== user.id && !hasRole(user, 'sysadmin')) return { code: 404 as const };
      if (row.revoked_at) return { code: 409 as const };
      await client.query('UPDATE delegations SET revoked_at = now(), revoked_by = $2 WHERE id = $1', [
        row.id,
        user.id,
      ]);
      await writeAudit(client, {
        actorUserId: user.id,
        action: AuditAction.DelegationRevoked,
        entityType: 'delegation',
        entityId: row.id,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
      });
      return { code: 200 as const };
    });
    if (outcome.code !== 200) {
      return reply.code(outcome.code).send({ error: outcome.code === 409 ? 'already_revoked' : 'not_found' });
    }
    return { ok: true };
  });
}
