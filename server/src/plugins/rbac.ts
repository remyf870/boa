// RBAC enforcement (A.5.15): default-deny, scoped per cost centre, enforced on
// the server on every request. Authentication itself is enforced globally in
// plugins/auth-context.ts (every /api path outside a short public allowlist
// requires a session); the guards here add role and cost-centre authorisation
// on top and audit every denial (A.8.16 feeds on these).
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/pool.js';
import type { CurrentUser } from '../auth/sessions.js';
import { AuditAction, writeAudit } from '../audit/audit.js';

export type Role =
  | 'requester'
  | 'approver'
  | 'accounting'
  | 'budget_owner'
  | 'doa_admin'
  | 'auditor'
  | 'sysadmin';

/**
 * Does the user hold `role`? With a cost centre: an org-wide (NULL) grant or a
 * grant for that cost centre qualifies. WITHOUT a cost centre this is an
 * org-wide check: only a NULL-scoped grant qualifies — a scoped grant never
 * satisfies an org-wide requirement (adversarial-review finding; the DB CHECK
 * `org_wide_roles_have_no_cost_centre` guarantees admin/auditor/accounting/
 * doa_admin grants are always org-wide).
 */
export function hasRole(user: CurrentUser, role: Role, costCentreId?: string): boolean {
  return user.roles.some(
    (g) =>
      g.role === role &&
      (costCentreId === undefined
        ? g.costCentreId === null
        : g.costCentreId === null || g.costCentreId === costCentreId),
  );
}

/** Loose variant: holds `role` in any scope. Use only where scope truly does not matter. */
export function hasRoleAnywhere(user: CurrentUser, role: Role): boolean {
  return user.roles.some((g) => g.role === role);
}

export function hasAnyRole(user: CurrentUser, roles: Role[], costCentreId?: string): boolean {
  return roles.some((r) => hasRole(user, r, costCentreId));
}

/** preHandler: request must carry a valid session. */
export function requireAuth() {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.currentUser) {
      return reply.code(401).send({
        error: 'unauthenticated',
        ...(req.sessionFailure ? { reason: req.sessionFailure } : {}),
      });
    }
  };
}

/**
 * preHandler: request must carry a session holding one of `roles`.
 * Cost-centre-scoped checks happen in the route (the resource must be loaded
 * first); this guard covers role-gated route families like /api/admin.
 */
export function requireRoles(db: Db, ...roles: Role[]) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.currentUser) {
      return reply.code(401).send({ error: 'unauthenticated' });
    }
    if (!hasAnyRole(req.currentUser, roles)) {
      await writeAudit(db, {
        actorUserId: req.currentUser.id,
        action: AuditAction.AccessDenied,
        entityType: 'route',
        entityId: `${req.method} ${req.routeOptions.url ?? req.url}`,
        after: { requiredAnyOf: roles, held: req.currentUser.roles },
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
      });
      return reply.code(403).send({ error: 'forbidden' });
    }
  };
}

/**
 * Resource-level READ scope for financial records. Role-filtered (§3):
 * approvers of that cost centre and org-wide accounting/auditor qualify.
 * Requesters see their own records via requester_id checks, NOT via this —
 * §3 grants requesters "own history", not their whole cost centre. sysadmin
 * and doa_admin are deliberately absent (A.8.2). Mirrors the SQL function
 * app_user_can_read_cost_centre (migration 0006). Callers respond 404 — not
 * 403 — when this fails for a fetched-by-id resource, so existence is never
 * leaked (A.5.15 acceptance).
 */
export function canAccessCostCentre(user: CurrentUser, costCentreId: string): boolean {
  return user.roles.some(
    (g) =>
      (g.role === 'approver' && g.costCentreId === costCentreId) ||
      ((g.role === 'accounting' || g.role === 'auditor') && g.costCentreId === null),
  );
}
