// Admin surface (§5.8 subset for Phase 0): user & role administration and the
// quarterly access review export (A.5.18). The sysadmin role administers
// access but can never approve, edit budgets, or read financial detail
// (A.5.3, A.8.2 — enforced here AND by the SoD trigger in migration 0004).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import ExcelJS from 'exceljs';
import type { Config } from '../config.js';
import { withUserContext, type Db } from '../db/pool.js';
import { AuditAction, raiseAlert, verifyAuditChain, writeAudit } from '../audit/audit.js';
import { buildLabelledWorkbook } from '../exports/excel.js';
import { requireRoles } from '../plugins/rbac.js';
import { NotificationTemplate, queueNotification } from '../notify/notifier.js';
import { readSetting, SETTING_KEYS, SettingValidationError, writeSetting, type SettingKey } from '../settings.js';
import { detectFileKind } from '../files/magic.js';
import { scanBuffer } from '../files/scanner.js';
import { saveAttachmentFile, sha256Hex } from '../files/storage.js';
import { notifySupplierApprovers, notifySupplierApproversBulk } from './suppliers.js';

/**
 * §5.2/A.5.18: when a user is disabled or loses an approver grant, their
 * pending approval steps become undecidable dead-ends — in nobody's queue,
 * decidable by nobody. Re-route them the moment the orphan is created, via
 * the SECURITY DEFINER function (0012) that re-resolves each step's FROZEN
 * doa_rule_snapshot descriptor (A.8.2: the sysadmin never reads the
 * requisition itself). Steps with no eligible replacement raise an alert
 * instead of failing the admin action.
 */
async function reassignOrphanedSteps(
  db: Db,
  actorId: string,
  affectedUserId: string,
  costCentreId: string | null,
  reqMeta: { ip: string; userAgent: string | null },
): Promise<void> {
  await withUserContext(db, actorId, async (client) => {
    const result = await client.query<{
      step_id: string;
      requisition_id: string;
      reference: string;
      step_purpose: string;
      new_assignee: string | null;
      new_assignee_name: string | null;
    }>('SELECT * FROM app_reassign_orphaned_steps($1, $2)', [affectedUserId, costCentreId]);

    for (const row of result.rows) {
      if (row.new_assignee) {
        await queueNotification(client, {
          recipientUserId: row.new_assignee,
          template: NotificationTemplate.ApprovalRequested,
          reference: row.reference,
          deepLink: '/approvals',
        });
        await writeAudit(client, {
          actorUserId: actorId,
          action: AuditAction.ApprovalStepReassigned,
          entityType: 'approval_step',
          entityId: row.step_id,
          before: { assignedUserId: affectedUserId },
          after: {
            assignedUserId: row.new_assignee,
            reference: row.reference,
            purpose: row.step_purpose,
            cause: costCentreId === null ? 'user_disabled_or_org_revoke' : 'approver_role_revoked',
          },
          ipAddress: reqMeta.ip,
          userAgent: reqMeta.userAgent,
        });
      } else {
        await raiseAlert(client, 'approval_step_unassignable', 'warning', {
          stepId: row.step_id,
          requisitionId: row.requisition_id,
          reference: row.reference,
          formerAssignee: affectedUserId,
        });
        await writeAudit(client, {
          actorUserId: actorId,
          action: AuditAction.ApprovalStepUnassignable,
          entityType: 'approval_step',
          entityId: row.step_id,
          after: { reference: row.reference, formerAssignee: affectedUserId },
          ipAddress: reqMeta.ip,
          userAgent: reqMeta.userAgent,
        });
      }
    }
  });
}

const ROLE_VALUES = [
  'requester',
  'approver',
  'accounting',
  'budget_owner',
  'budget_approver',
  'doa_admin',
  'doa_approver',
  'supplier_approver',
  'auditor',
  'sysadmin',
] as const;

const ORG_WIDE_ROLES = [
  'sysadmin',
  'auditor',
  'accounting',
  'doa_admin',
  'budget_approver',
  'doa_approver',
  'supplier_approver',
] as const;

export default async function adminRoutes(app: FastifyInstance, opts: { db: Db; config: Config }) {
  const { db, config } = opts;

  // ── Users & roles (sysadmin) ───────────────────────────────────────────────
  app.get('/api/admin/users', { preHandler: requireRoles(db, 'sysadmin', 'auditor') }, async () => {
    const { rows } = await db.query(
      `SELECT u.id, u.email, u.display_name, u.job_title, u.status, u.last_login_at, u.created_at,
              u.home_cost_centre_id,
              hc.department AS home_department,
              (u.entra_object_id LIKE 'pending-%') AS pending_first_login,
              coalesce(json_agg(json_build_object(
                'assignmentId', ra.id,
                'role', ra.role,
                'costCentreId', ra.cost_centre_id,
                'costCentreCode', cc.code,
                'tier', ra.tier,
                'grantedAt', ra.granted_at,
                'grantedReason', ra.granted_reason
              ) ORDER BY ra.granted_at) FILTER (WHERE ra.id IS NOT NULL), '[]') AS roles
       FROM users u
       LEFT JOIN cost_centres hc ON hc.id = u.home_cost_centre_id
       LEFT JOIN roles_assignments ra ON ra.user_id = u.id AND ra.revoked_at IS NULL
       LEFT JOIN cost_centres cc ON cc.id = ra.cost_centre_id
       GROUP BY u.id, hc.department
       ORDER BY u.display_name`,
    );
    return { users: rows };
  });

  // ── Pre-provision a user (client change list, "System Admin UI") ───────────
  // The row exists with a placeholder identity and NO roles (default-deny,
  // A.5.15); the admin then grants roles through the normal endpoint. On the
  // person's first real sign-in, provisioning claims the row by email match
  // (auth/provision.ts), so access works from day one without a prior login.
  app.post('/api/admin/users', { preHandler: requireRoles(db, 'sysadmin') }, async (req, reply) => {
    const actor = req.currentUser!;
    const body = z
      .object({
        email: z.string().email().max(320),
        displayName: z.string().min(1).max(200),
        jobTitle: z.string().max(200).nullish(),
        homeCostCentreId: z.string().uuid().nullish(),
      })
      .safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_request', message: body.error.issues[0]?.message });
    }
    // The row will be CLAIMED by whoever first signs in with this email
    // (auth/provision.ts) — a typo'd or external domain would hand the
    // pre-granted roles to the wrong identity (adversarial-review finding).
    // The allowlist is data (app_settings, §0.3); empty = any domain.
    const allowedDomains = await readSetting(db, 'allowed_email_domains');
    if (allowedDomains.length > 0) {
      const domain = body.data.email.split('@').pop()?.toLowerCase() ?? '';
      if (!allowedDomains.some((d) => d.toLowerCase() === domain)) {
        return reply.code(400).send({
          error: 'email_domain_not_allowed',
          message: `Pre-provisioned users must use an allowed email domain (${allowedDomains.join(', ')})`,
        });
      }
    }
    if (body.data.homeCostCentreId) {
      const cc = await db.query<{ active: boolean }>('SELECT active FROM cost_centres WHERE id = $1', [
        body.data.homeCostCentreId,
      ]);
      if (!cc.rows[0]?.active) return reply.code(400).send({ error: 'department_not_found' });
    }
    try {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO users (entra_object_id, email, display_name, job_title, home_cost_centre_id)
         VALUES ('pending-' || gen_random_uuid(), $1, $2, $3, $4)
         RETURNING id`,
        [body.data.email, body.data.displayName, body.data.jobTitle ?? null, body.data.homeCostCentreId ?? null],
      );
      await writeAudit(db, {
        actorUserId: actor.id,
        action: 'user.pre_provisioned',
        entityType: 'user',
        entityId: rows[0]!.id,
        after: { ...body.data },
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
      });
      return reply.code(201).send({ ok: true, id: rows[0]!.id });
    } catch (err) {
      if (err instanceof Error && err.message.includes('users_email_lower_uq')) {
        return reply.code(409).send({ error: 'email_already_exists' });
      }
      throw err;
    }
  });

  // Home department is display/attribution only — never authority (A.5.15).
  app.post('/api/admin/users/:id/department', { preHandler: requireRoles(db, 'sysadmin') }, async (req, reply) => {
    const actor = req.currentUser!;
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const body = z.object({ homeCostCentreId: z.string().uuid().nullable() }).safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: 'invalid_request' });
    if (body.data.homeCostCentreId) {
      const cc = await db.query<{ active: boolean }>('SELECT active FROM cost_centres WHERE id = $1', [
        body.data.homeCostCentreId,
      ]);
      if (!cc.rows[0]?.active) return reply.code(400).send({ error: 'department_not_found' });
    }
    const result = await db.query(
      'UPDATE users SET home_cost_centre_id = $2, updated_at = now() WHERE id = $1',
      [params.data.id, body.data.homeCostCentreId],
    );
    if ((result.rowCount ?? 0) === 0) return reply.code(404).send({ error: 'not_found' });
    await writeAudit(db, {
      actorUserId: actor.id,
      action: 'user.department_changed',
      entityType: 'user',
      entityId: params.data.id,
      after: { homeCostCentreId: body.data.homeCostCentreId },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
    });
    return { ok: true };
  });

  app.post('/api/admin/users/:id/status', { preHandler: requireRoles(db, 'sysadmin') }, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const body = z
      .object({ status: z.enum(['active', 'disabled']), reason: z.string().min(3).max(1000) })
      .safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: 'invalid_request' });
    const actor = req.currentUser!;

    if (params.data.id === actor.id) {
      return reply.code(403).send({ error: 'cannot_change_own_status' });
    }
    const { rows } = await db.query<{ id: string; status: string }>('SELECT id, status FROM users WHERE id = $1', [
      params.data.id,
    ]);
    const target = rows[0];
    if (!target) return reply.code(404).send({ error: 'not_found' });

    await db.query('UPDATE users SET status = $2, updated_at = now() WHERE id = $1', [target.id, body.data.status]);
    if (body.data.status === 'disabled') {
      // A.5.18: revocation is immediate — kill every live session
      await db.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [target.id]);
      // ...and re-route any pending approval steps they leave behind (§5.2)
      await reassignOrphanedSteps(db, actor.id, target.id, null, {
        ip: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
      });
    }
    await writeAudit(db, {
      actorUserId: actor.id,
      action: AuditAction.UserStatusChanged,
      entityType: 'user',
      entityId: target.id,
      before: { status: target.status },
      after: { status: body.data.status, reason: body.data.reason },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
    });
    return reply.send({ ok: true });
  });

  app.post('/api/admin/users/:id/roles', { preHandler: requireRoles(db, 'sysadmin') }, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const body = z
      .object({
        role: z.enum(ROLE_VALUES),
        costCentreId: z.string().uuid().nullish(),
        // DOA tier for approver grants (client tiered model): 5 = supervisors,
        // 4 = senior managers/VPs, 3 = executive.
        tier: z.union([z.literal(3), z.literal(4), z.literal(5)]).nullish(),
        reason: z.string().min(3).max(1000), // A.5.18: the "why" is mandatory
      })
      .superRefine((b, ctx) => {
        // Org-wide roles are org-wide, full stop (mirrors the DB CHECK
        // org_wide_roles_have_no_cost_centre): a "scoped sysadmin/auditor"
        // would satisfy org-wide role checks with over-broad effect.
        if ((ORG_WIDE_ROLES as readonly string[]).includes(b.role) && b.costCentreId) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${b.role} is an organisation-wide role and cannot be scoped to a department`,
            path: ['costCentreId'],
          });
        }
        if (['requester', 'approver', 'budget_owner'].includes(b.role) && !b.costCentreId) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${b.role} must be scoped to a department`,
            path: ['costCentreId'],
          });
        }
        if (b.tier != null && b.role !== 'approver') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'a DOA tier applies only to approver grants',
            path: ['tier'],
          });
        }
      })
      .safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: 'invalid_request' });
    const actor = req.currentUser!;

    // A.8.2: an admin must never escalate their own privileges
    if (params.data.id === actor.id) {
      await writeAudit(db, {
        actorUserId: actor.id,
        action: AuditAction.RoleGrantRefused,
        entityType: 'roles_assignment',
        after: { reason: 'self_grant_attempt', role: body.data.role },
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
      });
      await raiseAlert(db, 'privilege_escalation_attempt', 'critical', {
        actorUserId: actor.id,
        role: body.data.role,
      });
      return reply.code(403).send({ error: 'self_grant_forbidden' });
    }

    try {
      const inserted = await db.query<{ id: string }>(
        `INSERT INTO roles_assignments (user_id, role, cost_centre_id, tier, granted_by, granted_reason)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [
          params.data.id,
          body.data.role,
          body.data.costCentreId ?? null,
          body.data.tier ?? null,
          actor.id,
          body.data.reason,
        ],
      );
      await writeAudit(db, {
        actorUserId: actor.id,
        action: AuditAction.RoleGranted,
        entityType: 'roles_assignment',
        entityId: inserted.rows[0]!.id,
        after: {
          userId: params.data.id,
          role: body.data.role,
          costCentreId: body.data.costCentreId ?? null,
          tier: body.data.tier ?? null,
          reason: body.data.reason,
        },
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
      });
      return reply.send({ ok: true, assignmentId: inserted.rows[0]!.id });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // SoD trigger (A.5.3) or duplicate live grant
      if (message.includes('segregation of duties')) {
        await writeAudit(db, {
          actorUserId: actor.id,
          action: AuditAction.RoleGrantRefused,
          entityType: 'roles_assignment',
          after: { userId: params.data.id, role: body.data.role, reason: 'sod_conflict' },
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'] ?? null,
        });
        return reply.code(409).send({ error: 'segregation_of_duties_conflict' });
      }
      if (message.includes('roles_assignments_live_uq')) {
        return reply.code(409).send({ error: 'role_already_granted' });
      }
      throw err;
    }
  });

  app.post('/api/admin/roles/:assignmentId/revoke', { preHandler: requireRoles(db, 'sysadmin') }, async (req, reply) => {
    const params = z.object({ assignmentId: z.string().uuid() }).safeParse(req.params);
    const body = z.object({ reason: z.string().min(3).max(1000) }).safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: 'invalid_request' });
    const actor = req.currentUser!;

    const { rows } = await db.query<{ id: string; user_id: string; role: string; cost_centre_id: string | null }>(
      'SELECT id, user_id, role, cost_centre_id FROM roles_assignments WHERE id = $1 AND revoked_at IS NULL',
      [params.data.assignmentId],
    );
    const grant = rows[0];
    if (!grant) return reply.code(404).send({ error: 'not_found' });

    await db.query(
      'UPDATE roles_assignments SET revoked_at = now(), revoked_by = $2, revoked_reason = $3 WHERE id = $1',
      [grant.id, actor.id, body.data.reason],
    );
    if (grant.role === 'approver' || grant.role === 'accounting') {
      // Pending steps that relied on this grant are now undecidable — unless
      // another live grant still covers them, in which case the function
      // finds no orphans to move (it re-checks eligibility per step).
      // Accounting revocations orphan finance_review steps the same way
      // approver revocations orphan DOA steps; app_reassign_orphaned_steps
      // handles both purposes.
      const stillCovered = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM roles_assignments
         WHERE user_id = $1 AND role = $3 AND revoked_at IS NULL
           AND ($2::uuid IS NULL OR cost_centre_id IS NULL OR cost_centre_id = $2)`,
        [grant.user_id, grant.cost_centre_id, grant.role],
      );
      if (Number(stillCovered.rows[0]!.n) === 0) {
        await reassignOrphanedSteps(db, actor.id, grant.user_id, grant.cost_centre_id, {
          ip: req.ip,
          userAgent: req.headers['user-agent'] ?? null,
        });
      }
    }
    await writeAudit(db, {
      actorUserId: actor.id,
      action: AuditAction.RoleRevoked,
      entityType: 'roles_assignment',
      entityId: grant.id,
      before: { userId: grant.user_id, role: grant.role, costCentreId: grant.cost_centre_id },
      after: { reason: body.data.reason },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
    });
    return reply.send({ ok: true });
  });

  // ── Quarterly access review export (A.5.18) — labelled (A.5.13), logged and
  //    rate-limited (A.8.12) ──────────────────────────────────────────────────
  app.get(
    '/api/admin/access-review.xlsx',
    {
      preHandler: requireRoles(db, 'sysadmin', 'auditor'),
      config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
    },
    async (req, reply) => {
      const actor = req.currentUser!;
      const { rows } = await db.query<{
        email: string;
        display_name: string;
        job_title: string | null;
        status: string;
        last_login_at: Date | null;
        role: string | null;
        cost_centre: string | null;
        granted_by_email: string | null;
        granted_at: Date | null;
        granted_reason: string | null;
      }>(
        `SELECT u.email, u.display_name, u.job_title, u.status, u.last_login_at,
                ra.role::text AS role, coalesce(cc.code, 'ALL') AS cost_centre,
                gb.email AS granted_by_email, ra.granted_at, ra.granted_reason
         FROM users u
         LEFT JOIN roles_assignments ra ON ra.user_id = u.id AND ra.revoked_at IS NULL
         LEFT JOIN cost_centres cc ON cc.id = ra.cost_centre_id
         LEFT JOIN users gb ON gb.id = ra.granted_by
         ORDER BY u.display_name, ra.role`,
      );
      const buffer = await buildLabelledWorkbook({
        title: 'Access review',
        classification: 'Internal',
        exportedBy: `${actor.displayName} <${actor.email}>`,
        filterDescription: 'All users, live role grants only',
        columns: [
          { header: 'User', key: 'display_name', width: 28 },
          { header: 'Email', key: 'email', width: 32 },
          { header: 'Job title', key: 'job_title', width: 24 },
          { header: 'Status', key: 'status', width: 10 },
          { header: 'Role', key: 'role', width: 16 },
          { header: 'Cost centre', key: 'cost_centre', width: 14 },
          { header: 'Granted by', key: 'granted_by_email', width: 32 },
          { header: 'Granted at (UTC)', key: 'granted_at', width: 22 },
          { header: 'Reason', key: 'granted_reason', width: 40 },
          { header: 'Last login (UTC)', key: 'last_login_at', width: 22 },
        ],
        rows: rows.map((r) => ({
          ...r,
          granted_at: r.granted_at?.toISOString() ?? '',
          last_login_at: r.last_login_at?.toISOString() ?? 'never',
        })),
      });
      // A.8.12: every export is a data leakage event — log who, what, how many
      await writeAudit(db, {
        actorUserId: actor.id,
        action: AuditAction.Export,
        entityType: 'export',
        entityId: 'access-review',
        after: { rowCount: rows.length, filter: 'all users, live grants', format: 'xlsx' },
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
      });
      return reply
        .header('content-disposition', 'attachment; filename="access-review.xlsx"')
        .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .send(buffer);
    },
  );

  // ── Audit log access (auditor only, §3) and chain verification (A.8.15) ────
  app.get('/api/admin/audit-log', { preHandler: requireRoles(db, 'auditor') }, async (req, reply) => {
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(500).default(100),
        before: z.coerce.number().int().positive().optional(),
        action: z.string().max(100).optional(),
      })
      .safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_request' });
    const { limit, before, action } = query.data;
    // withUserContext so the audit_log RLS policy (auditor-only SELECT, A.8.3)
    // holds even when the connection runs as the restricted massy_app role.
    const rows = await withUserContext(db, req.currentUser!.id, async (client) => {
      const result = await client.query(
        `SELECT seq, occurred_at, actor_user_id, action, entity_type, entity_id,
                before, after, ip_address, user_agent, prev_hash, row_hash
         FROM audit_log
         WHERE ($1::bigint IS NULL OR seq < $1)
           AND ($2::text IS NULL OR action = $2)
         ORDER BY seq DESC
         LIMIT $3`,
        [before ?? null, action ?? null, limit],
      );
      return result.rows;
    });
    return { entries: rows };
  });

  // Auditor only: chain verification reads every audit row, and audit payloads
  // can contain financial detail the sysadmin must not see (A.8.2). Ops runs
  // the equivalent verify-audit-chain script as the maintenance role.
  app.post('/api/admin/audit-verify', { preHandler: requireRoles(db, 'auditor') }, async (req) => {
    const actor = req.currentUser!;
    const result = await withUserContext(db, actor.id, (client) => verifyAuditChain(client));
    if (result.ok) {
      await writeAudit(db, {
        actorUserId: actor.id,
        action: AuditAction.ChainVerified,
        entityType: 'audit_log',
        after: { totalRows: result.totalRows },
      });
    } else {
      await writeAudit(db, {
        actorUserId: actor.id,
        action: AuditAction.ChainFailed,
        entityType: 'audit_log',
        after: { defects: result.defects.slice(0, 20) },
      });
      await raiseAlert(db, 'audit_chain_verification_failed', 'critical', {
        defects: result.defects.slice(0, 20),
        totalRows: result.totalRows,
      });
    }
    return result;
  });

  // ── Audit trail export for a date range (A.5.28 packaged evidence) ─────────
  app.get(
    '/api/admin/audit-export.xlsx',
    { preHandler: requireRoles(db, 'auditor'), config: { rateLimit: { max: 10, timeWindow: '1 hour' } } },
    async (req, reply) => {
      const actor = req.currentUser!;
      const query = z
        .object({ from: z.coerce.date(), to: z.coerce.date() })
        .refine((q) => q.to > q.from, { message: 'to must be after from' })
        .safeParse(req.query);
      if (!query.success) return reply.code(400).send({ error: 'invalid_request' });

      const rows = await withUserContext(db, actor.id, async (client) => {
        const result = await client.query<Record<string, unknown>>(
          `SELECT seq, occurred_at, actor_user_id, action, entity_type, entity_id,
                  before, after, ip_address, user_agent, prev_hash, row_hash
           FROM audit_log
           WHERE occurred_at >= $1 AND occurred_at < $2
           ORDER BY seq
           LIMIT 50000`,
          [query.data.from, query.data.to],
        );
        return result.rows;
      });
      const filterDescription = `occurred_at in [${query.data.from.toISOString()}, ${query.data.to.toISOString()})`;
      const buffer = await buildLabelledWorkbook({
        title: 'Audit trail',
        classification: 'Confidential',
        exportedBy: `${actor.displayName} <${actor.email}>`,
        filterDescription,
        columns: [
          { header: 'Seq', key: 'seq', width: 10 },
          { header: 'Occurred (UTC)', key: 'occurred_at', width: 24 },
          { header: 'Actor', key: 'actor_user_id', width: 38 },
          { header: 'Action', key: 'action', width: 28 },
          { header: 'Entity type', key: 'entity_type', width: 18 },
          { header: 'Entity id', key: 'entity_id', width: 38 },
          { header: 'Before', key: 'before', width: 40 },
          { header: 'After', key: 'after', width: 40 },
          { header: 'IP', key: 'ip_address', width: 16 },
          { header: 'Prev hash', key: 'prev_hash', width: 20 },
          { header: 'Row hash', key: 'row_hash', width: 20 },
        ],
        rows: rows.map((r) => ({
          ...r,
          occurred_at: r.occurred_at instanceof Date ? r.occurred_at.toISOString() : r.occurred_at,
          before: r.before === null ? '' : JSON.stringify(r.before),
          after: r.after === null ? '' : JSON.stringify(r.after),
        })),
      });
      await writeAudit(db, {
        actorUserId: actor.id,
        action: AuditAction.Export,
        entityType: 'export',
        entityId: 'audit-trail',
        after: { rowCount: rows.length, filter: filterDescription, format: 'xlsx' },
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
      });
      return reply
        .header('content-disposition', 'attachment; filename="audit-trail.xlsx"')
        .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .send(buffer);
    },
  );

  // ── App settings (plan §0.3: configurable = data in the DB) ────────────────
  app.get('/api/admin/settings', { preHandler: requireRoles(db, 'sysadmin', 'auditor') }, async () => {
    const { rows } = await db.query(
      'SELECT key, value, description, updated_by, updated_at FROM app_settings ORDER BY key',
    );
    return { settings: rows };
  });

  app.put('/api/admin/settings/:key', { preHandler: requireRoles(db, 'sysadmin') }, async (req, reply) => {
    const actor = req.currentUser!;
    const params = z
      .object({ key: z.enum(SETTING_KEYS as [SettingKey, ...SettingKey[]]) })
      .safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: 'not_found' });
    const body = z.object({ value: z.unknown() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request' });

    try {
      const change = await withUserContext(db, actor.id, async (client) => {
        const result = await writeSetting(client, params.data.key, body.data.value, actor.id);
        await writeAudit(client, {
          actorUserId: actor.id,
          action: AuditAction.SettingChanged,
          entityType: 'app_setting',
          entityId: params.data.key,
          before: { value: result.before },
          after: { value: result.after },
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'] ?? null,
        });
        return result;
      });
      return { ok: true, key: params.data.key, value: change.after };
    } catch (err) {
      if (err instanceof SettingValidationError) {
        return reply.code(400).send({ error: 'invalid_setting_value', message: err.message });
      }
      throw err;
    }
  });

  // ── Master data maintenance (plan §5.8): categories, cost centres, suppliers ─
  app.post('/api/admin/categories', { preHandler: requireRoles(db, 'sysadmin') }, async (req, reply) => {
    const actor = req.currentUser!;
    const body = z
      .object({
        code: z.string().min(1).max(30).transform((s) => s.toUpperCase()),
        name: z.string().min(1).max(200),
        glAccountCode: z.string().max(30).nullish(),
        cdkAccountRef: z.string().max(30).nullish(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request' });
    try {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO categories (code, name, gl_account_code, cdk_account_ref)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [body.data.code, body.data.name, body.data.glAccountCode ?? null, body.data.cdkAccountRef ?? null],
      );
      await writeAudit(db, {
        actorUserId: actor.id,
        action: 'category.created',
        entityType: 'category',
        entityId: rows[0]!.id,
        after: body.data,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
      });
      return reply.code(201).send({ ok: true, id: rows[0]!.id });
    } catch (err) {
      if (err instanceof Error && err.message.includes('categories_code_key')) {
        return reply.code(409).send({ error: 'code_already_exists' });
      }
      throw err;
    }
  });

  app.post('/api/admin/cost-centres', { preHandler: requireRoles(db, 'sysadmin') }, async (req, reply) => {
    const actor = req.currentUser!;
    const body = z
      .object({
        code: z.string().min(1).max(30).transform((s) => s.toUpperCase()),
        name: z.string().min(1).max(200),
        department: z.string().min(1).max(100),
        parentId: z.string().uuid().nullish(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request' });
    try {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO cost_centres (code, name, department, parent_id)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [body.data.code, body.data.name, body.data.department, body.data.parentId ?? null],
      );
      await writeAudit(db, {
        actorUserId: actor.id,
        action: 'cost_centre.created',
        entityType: 'cost_centre',
        entityId: rows[0]!.id,
        after: body.data,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
      });
      return reply.code(201).send({ ok: true, id: rows[0]!.id });
    } catch (err) {
      if (err instanceof Error && err.message.includes('cost_centres_code_key')) {
        return reply.code(409).send({ error: 'code_already_exists' });
      }
      throw err;
    }
  });

  // A supplier the sysadmin records still needs approval by a
  // supplier_approver before it can be used on requisitions (client change
  // list: the approved-supplier list is a two-person control). SoD binds one
  // user ROW — the sysadmin's own row can never hold supplier_approver; the
  // residual risk of one human controlling a second pre-provisioned identity
  // is alerted on at claim time (auth/provision.ts) and reviewed via the
  // claimedPreProvisioned audit trail.
  app.post('/api/admin/suppliers', { preHandler: requireRoles(db, 'sysadmin') }, async (req, reply) => {
    const actor = req.currentUser!;
    // A.5.34: deliberately no bank/payment fields — they belong in CDK
    const body = z
      .object({
        name: z.string().min(1).max(200),
        cdkVendorRef: z.string().max(30).nullish(),
        taxId: z.string().max(30).nullish(),
        reason: z.string().max(1000).nullish(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request' });
    const dup = await db.query<{ id: string }>(
      `SELECT id FROM suppliers WHERE lower(name) = lower($1) AND status IN ('pending_approval', 'active')`,
      [body.data.name],
    );
    if (dup.rows[0]) return reply.code(409).send({ error: 'supplier_already_exists' });
    let created: { id: string };
    try {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO suppliers (name, cdk_vendor_ref, tax_id, status, requested_by, requested_at, requested_reason)
         VALUES ($1, $2, $3, 'pending_approval', $4, now(), $5) RETURNING id`,
        [body.data.name, body.data.cdkVendorRef ?? null, body.data.taxId ?? null, actor.id, body.data.reason ?? null],
      );
      created = rows[0]!;
    } catch (err) {
      // suppliers_live_name_uq closes the read-then-insert race the friendly
      // check above cannot (rows are undeletable, so a duplicate would be
      // permanent) — same 409 either way.
      if (err instanceof Error && err.message.includes('suppliers_live_name_uq')) {
        return reply.code(409).send({ error: 'supplier_already_exists' });
      }
      throw err;
    }
    await writeAudit(db, {
      actorUserId: actor.id,
      action: 'supplier.requested',
      entityType: 'supplier',
      entityId: created.id,
      after: { ...body.data, status: 'pending_approval' },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
    });
    await notifySupplierApprovers(db, actor.id, created.id);
    return reply.code(201).send({ ok: true, id: created.id, status: 'pending_approval' });
  });

  // ── Approved-supplier list bulk upload (client change list, "System Admin
  //    UI"). Columns: Supplier Name | CDK Vendor Ref | Tax ID. Every row
  //    lands as pending_approval; a supplier_approver activates them in-app
  //    (the two-person rule applies to the list exactly as to single adds). ──
  app.post(
    '/api/admin/suppliers/upload',
    { preHandler: requireRoles(db, 'sysadmin'), config: { rateLimit: { max: 10, timeWindow: '1 hour' } } },
    async (req, reply) => {
      const actor = req.currentUser!;
      const file = await req.file();
      if (!file) return reply.code(400).send({ error: 'file_required' });
      const buffer = await file.toBuffer();
      if (file.file.truncated) return reply.code(413).send({ error: 'file_too_large' });
      const maxBytes = await readSetting(db, 'attachment_max_bytes');
      if (buffer.length === 0 || buffer.length > maxBytes) {
        return reply.code(413).send({ error: 'file_too_large', maxBytes });
      }
      const detected = detectFileKind(buffer);
      if (!detected || detected.kind !== 'xlsx') return reply.code(415).send({ error: 'not_an_xlsx_file' });
      const verdict = await scanBuffer(config, buffer);
      if (verdict.status === 'infected') {
        await writeAudit(db, {
          actorUserId: actor.id,
          action: AuditAction.AttachmentQuarantined,
          entityType: 'attachment',
          after: { filename: file.filename, signature: verdict.signature, context: 'supplier_upload' },
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'] ?? null,
        });
        return reply.code(422).send({ error: 'file_failed_virus_scan' });
      }

      const wb = new ExcelJS.Workbook();
      try {
        await wb.xlsx.load(buffer as unknown as ArrayBuffer);
      } catch {
        return reply.code(422).send({ error: 'validation_failed', issues: ['File is not a readable .xlsx workbook'] });
      }
      const ws = wb.worksheets[0];
      const issues: string[] = [];
      const parsed: { rowNo: number; name: string; cdkVendorRef: string | null; taxId: string | null }[] = [];
      let headerRowNo = 0;
      ws?.eachRow((row, rowNo) => {
        const c1 = String(row.getCell(1).value ?? '').trim();
        if (headerRowNo === 0 && c1.toLowerCase().startsWith('supplier')) {
          headerRowNo = rowNo;
          return;
        }
        if (headerRowNo === 0 || rowNo <= headerRowNo || !c1) return;
        if (c1.length > 200) issues.push(`Row ${rowNo}: supplier name exceeds 200 characters`);
        parsed.push({
          rowNo,
          name: c1,
          cdkVendorRef: String(row.getCell(2).value ?? '').trim() || null,
          taxId: String(row.getCell(3).value ?? '').trim() || null,
        });
      });
      if (headerRowNo === 0) issues.push('Header row not found — first column header must be "Supplier Name"');
      if (parsed.length === 0) issues.push('The workbook contains no suppliers');
      if (parsed.length > 500) issues.push('The workbook exceeds the 500-supplier limit — split the list');
      const seenNames = new Set<string>();
      for (const p of parsed) {
        const key = p.name.toLowerCase();
        if (seenNames.has(key)) issues.push(`Row ${p.rowNo}: supplier "${p.name}" appears twice`);
        seenNames.add(key);
      }
      if (issues.length > 0) return reply.code(422).send({ error: 'validation_failed', issues });

      const outcome = await withUserContext(db, actor.id, async (client) => {
        const stored = await saveAttachmentFile(config, buffer, { quarantined: false });
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO attachments (type, filename, content_type, size_bytes, sha256, storage_key,
                                    scan_status, uploaded_by, classification)
           VALUES ('supplier_import', $1, $2, $3, $4, $5, 'clean', $6, 'internal')
           RETURNING id`,
          [file.filename, detected.contentType, buffer.length, sha256Hex(buffer), stored.storageKey, actor.id],
        );
        const sourceFileId = inserted.rows[0]!.id;
        const created: string[] = [];
        const skipped: string[] = [];
        for (const p of parsed) {
          // ON CONFLICT on the suppliers_live_name_uq partial index makes the
          // duplicate check race-free inside this transaction (a plain failed
          // INSERT would abort the whole batch; a pre-check would race
          // concurrent single adds).
          const row = await client.query<{ id: string }>(
            `INSERT INTO suppliers (name, cdk_vendor_ref, tax_id, status, requested_by, requested_at,
                                    requested_reason, source_file_id)
             VALUES ($1, $2, $3, 'pending_approval', $4, now(), $5, $6)
             ON CONFLICT ((lower(name))) WHERE status IN ('pending_approval', 'active') DO NOTHING
             RETURNING id`,
            [p.name, p.cdkVendorRef, p.taxId, actor.id, `Bulk upload: ${file.filename}`, sourceFileId],
          );
          if (row.rows[0]) created.push(row.rows[0].id);
          else skipped.push(p.name);
        }
        await writeAudit(client, {
          actorUserId: actor.id,
          action: 'supplier.bulk_uploaded',
          entityType: 'attachment',
          entityId: sourceFileId,
          after: { filename: file.filename, createdCount: created.length, skippedExisting: skipped },
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'] ?? null,
        });
        return { created, skipped };
      });
      if (outcome.created.length > 0) {
        await notifySupplierApproversBulk(db, actor.id, outcome.created.length);
      }
      return reply.code(201).send({
        ok: true,
        createdCount: outcome.created.length,
        skippedExisting: outcome.skipped,
      });
    },
  );

  // Deactivation is a flag, never a delete (A.5.33)
  app.post(
    '/api/admin/:entity(categories|cost-centres|suppliers)/:id/active',
    { preHandler: requireRoles(db, 'sysadmin') },
    async (req, reply) => {
      const actor = req.currentUser!;
      const params = z
        .object({ entity: z.enum(['categories', 'cost-centres', 'suppliers']), id: z.string().uuid() })
        .safeParse(req.params);
      const body = z.object({ active: z.boolean() }).safeParse(req.body);
      if (!params.success || !body.success) return reply.code(400).send({ error: 'invalid_request' });

      const table =
        params.data.entity === 'categories'
          ? 'categories'
          : params.data.entity === 'cost-centres'
            ? 'cost_centres'
            : 'suppliers';
      // A supplier flag toggle must never mint an approval: only an already
      // active/inactive supplier can be toggled — pending_approval/rejected
      // rows go through the supplier_approver workflow (two-person rule).
      const result =
        table === 'suppliers'
          ? await db.query(
              `UPDATE suppliers SET status = $2 WHERE id = $1 AND status IN ('active', 'inactive')`,
              [params.data.id, body.data.active ? 'active' : 'inactive'],
            )
          : await db.query(`UPDATE ${table} SET active = $2 WHERE id = $1`, [params.data.id, body.data.active]);
      if ((result.rowCount ?? 0) === 0) return reply.code(404).send({ error: 'not_found' });
      await writeAudit(db, {
        actorUserId: actor.id,
        action: `${table}.active_changed`,
        entityType: table,
        entityId: params.data.id,
        after: { active: body.data.active },
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
      });
      return { ok: true };
    },
  );
}
