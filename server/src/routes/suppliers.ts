// Approved-supplier workflow (client change list, 2026-08-08): a supplier is
// REQUESTED (by an approver — in practice Tier 5 supervisors/managers — or
// recorded by the sysadmin) and APPROVED by the org-wide supplier_approver
// role (in practice Tier 4: Snr Manager Rentals / AVP Finance), two-person
// rule enforced in code AND by the supplier_two_person_rule DB CHECK.
// Only 'active' suppliers appear in /api/reference and are usable on
// requisitions. Rejection carries a mandatory reason; nothing is deleted
// (A.5.33 — status flags only).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import { withUserContext, type Db } from '../db/pool.js';
import { AuditAction, writeAudit } from '../audit/audit.js';
import { hasRole, hasRoleAnywhere, requireAuth, requireRoles } from '../plugins/rbac.js';
import { NotificationTemplate, queueNotification } from '../notify/notifier.js';

/** Opaque per-supplier reference for notifications: A.5.14 forbids supplier
 * NAMES in mail subjects, exactly as it forbids amounts. */
export function supplierRef(supplierId: string): string {
  return `SUP-${supplierId.slice(0, 8).toUpperCase()}`;
}

/** Tell every active supplier_approver (except the requester) a request is
 * waiting. Shared with the admin single-add and bulk-upload endpoints. */
export async function notifySupplierApprovers(db: Db, requesterId: string, supplierId: string): Promise<void> {
  const approvers = await db.query<{ user_id: string }>(
    `SELECT DISTINCT ra.user_id FROM roles_assignments ra
     JOIN users u ON u.id = ra.user_id AND u.status = 'active'
     WHERE ra.role = 'supplier_approver' AND ra.revoked_at IS NULL AND ra.user_id <> $1`,
    [requesterId],
  );
  for (const a of approvers.rows) {
    await queueNotification(db, {
      recipientUserId: a.user_id,
      template: NotificationTemplate.SupplierApprovalRequested,
      reference: supplierRef(supplierId),
      deepLink: '/admin',
    });
  }
}

/** One digest per approver for a bulk upload — N rows must not read as a
 * single request (review finding), and N per-supplier messages would mean up
 * to 500 outbox rows per approver per workbook. */
export async function notifySupplierApproversBulk(db: Db, requesterId: string, count: number): Promise<void> {
  const approvers = await db.query<{ user_id: string }>(
    `SELECT DISTINCT ra.user_id FROM roles_assignments ra
     JOIN users u ON u.id = ra.user_id AND u.status = 'active'
     WHERE ra.role = 'supplier_approver' AND ra.revoked_at IS NULL AND ra.user_id <> $1`,
    [requesterId],
  );
  for (const a of approvers.rows) {
    await queueNotification(db, {
      recipientUserId: a.user_id,
      template: NotificationTemplate.SupplierBulkApprovalRequested,
      reference: `${count} supplier request${count === 1 ? '' : 's'}`,
      deepLink: '/admin',
    });
  }
}

const SUPPLIER_STATUSES = ['pending_approval', 'active', 'rejected', 'inactive'] as const;

export default async function supplierRoutes(app: FastifyInstance, opts: { db: Db; config: Config }) {
  const { db } = opts;

  // ── List with workflow state. The approved list itself is not secret (it is
  //    the published procurement policy, like DOA rules), but the management
  //    view is for the roles that act on it. ─────────────────────────────────
  app.get('/api/suppliers', { preHandler: requireAuth() }, async (req, reply) => {
    const user = req.currentUser!;
    const query = z
      .object({ status: z.enum(SUPPLIER_STATUSES).optional() })
      .safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_request' });
    const allowed =
      hasRoleAnywhere(user, 'approver') ||
      hasRole(user, 'supplier_approver') ||
      hasRole(user, 'accounting') ||
      hasRole(user, 'auditor') ||
      hasRole(user, 'sysadmin');
    if (!allowed) return reply.code(403).send({ error: 'forbidden' });

    const { rows } = await db.query(
      `SELECT s.id, s.name, s.cdk_vendor_ref, s.tax_id, s.status, s.created_at,
              s.requested_at, s.requested_reason, s.approved_at, s.rejected_at, s.rejection_reason,
              s.requested_by,
              rb.display_name AS requested_by_name,
              ab.display_name AS approved_by_name,
              xb.display_name AS rejected_by_name
       FROM suppliers s
       LEFT JOIN users rb ON rb.id = s.requested_by
       LEFT JOIN users ab ON ab.id = s.approved_by
       LEFT JOIN users xb ON xb.id = s.rejected_by
       WHERE ($1::text IS NULL OR s.status = $1)
       ORDER BY (s.status = 'pending_approval') DESC, s.name`,
      [query.data.status ?? null],
    );
    return { suppliers: rows };
  });

  // ── Request a new supplier (Tier 5+ approvers; sysadmin uses /api/admin) ───
  app.post('/api/suppliers/request', { preHandler: requireAuth() }, async (req, reply) => {
    const user = req.currentUser!;
    if (!hasRoleAnywhere(user, 'approver') && !hasRole(user, 'supplier_approver')) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    // A.5.34: deliberately no bank/payment fields — they belong in CDK
    const body = z
      .object({
        name: z.string().min(1).max(200),
        cdkVendorRef: z.string().max(30).nullish(),
        taxId: z.string().max(30).nullish(),
        reason: z.string().min(3).max(1000),
      })
      .safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_request', message: body.error.issues[0]?.message });
    }

    let created: { error: 'supplier_already_exists'; status: string } | { id: string };
    try {
      created = await withUserContext(db, user.id, async (client) => {
        const dup = await client.query<{ id: string; status: string }>(
          `SELECT id, status FROM suppliers WHERE lower(name) = lower($1) AND status IN ('pending_approval', 'active')`,
          [body.data.name],
        );
        if (dup.rows[0]) return { error: 'supplier_already_exists' as const, status: dup.rows[0].status };
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO suppliers (name, cdk_vendor_ref, tax_id, status, requested_by, requested_at, requested_reason)
           VALUES ($1, $2, $3, 'pending_approval', $4, now(), $5) RETURNING id`,
          [body.data.name, body.data.cdkVendorRef ?? null, body.data.taxId ?? null, user.id, body.data.reason],
        );
        await writeAudit(client, {
          actorUserId: user.id,
          action: 'supplier.requested',
          entityType: 'supplier',
          entityId: rows[0]!.id,
          after: { name: body.data.name, reason: body.data.reason, status: 'pending_approval' },
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'] ?? null,
        });
        return { id: rows[0]!.id };
      });
    } catch (err) {
      // suppliers_live_name_uq closes the race two concurrent requests can
      // win past the friendly duplicate check (rows are undeletable, so a
      // duplicate would be permanent) — same 409 either way.
      if (err instanceof Error && err.message.includes('suppliers_live_name_uq')) {
        return reply.code(409).send({ error: 'supplier_already_exists' });
      }
      throw err;
    }
    if ('error' in created) return reply.code(409).send({ error: created.error });
    await notifySupplierApprovers(db, user.id, created.id);
    return reply.code(201).send({ ok: true, id: created.id, status: 'pending_approval' });
  });

  // ── Approve / reject (supplier_approver, never the requester) ──────────────
  const decide = (kind: 'approve' | 'reject') =>
    async function handler(req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) {
      const user = req.currentUser!;
      const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
      if (!params.success) return reply.code(404).send({ error: 'not_found' });
      const body = z.object({ reason: z.string().min(3).max(1000).optional() }).safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: 'invalid_request' });
      if (kind === 'reject' && !body.data.reason) {
        return reply.code(400).send({ error: 'rejection_reason_required' });
      }

      const outcome = await withUserContext(db, user.id, async (client) => {
        const found = await client.query<{ id: string; name: string; status: string; requested_by: string | null }>(
          'SELECT id, name, status, requested_by FROM suppliers WHERE id = $1 FOR UPDATE',
          [params.data.id],
        );
        const row = found.rows[0];
        if (!row) return { code: 404 as const, error: 'not_found' };
        if (row.status !== 'pending_approval') return { code: 409 as const, error: 'not_pending_approval' };
        // Two-person rule (also a DB CHECK): the requester never approves
        // their own supplier — same principle as A.5.3 self-approval.
        if (row.requested_by === user.id) {
          await writeAudit(client, {
            actorUserId: user.id,
            action: AuditAction.AccessDenied,
            entityType: 'supplier',
            entityId: row.id,
            after: { reason: 'supplier_self_approval_attempt' },
            ipAddress: req.ip,
            userAgent: req.headers['user-agent'] ?? null,
          });
          return { code: 403 as const, error: 'supplier_self_approval_forbidden' };
        }

        await client.query(
          kind === 'approve'
            ? `UPDATE suppliers SET status = 'active', approved_by = $2, approved_at = now() WHERE id = $1`
            : `UPDATE suppliers
               SET status = 'rejected', rejected_by = $2, rejected_at = now(), rejection_reason = $3
               WHERE id = $1`,
          kind === 'approve' ? [row.id, user.id] : [row.id, user.id, body.data.reason],
        );
        await writeAudit(client, {
          actorUserId: user.id,
          action: kind === 'approve' ? 'supplier.approved' : 'supplier.rejected',
          entityType: 'supplier',
          entityId: row.id,
          before: { status: 'pending_approval' },
          after: {
            status: kind === 'approve' ? 'active' : 'rejected',
            ...(body.data.reason ? { reason: body.data.reason } : {}),
          },
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'] ?? null,
        });
        if (row.requested_by) {
          await queueNotification(client, {
            recipientUserId: row.requested_by,
            template:
              kind === 'approve' ? NotificationTemplate.SupplierApproved : NotificationTemplate.SupplierRejected,
            reference: supplierRef(row.id),
            deepLink: '/admin',
          });
        }
        return { code: 200 as const };
      });
      if (outcome.code !== 200) return reply.code(outcome.code).send({ error: outcome.error });
      return reply.send({ ok: true });
    };

  app.post(
    '/api/suppliers/:id/approve',
    { preHandler: requireRoles(db, 'supplier_approver') },
    decide('approve'),
  );
  app.post(
    '/api/suppliers/:id/reject',
    { preHandler: requireRoles(db, 'supplier_approver') },
    decide('reject'),
  );
}
