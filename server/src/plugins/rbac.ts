// RBAC enforcement (A.5.15): default-deny, scoped per cost centre, enforced on
// the server on every request. Routes must opt IN to access via these guards;
// a route with no guard still requires authentication unless explicitly public.
// Denials are audited (A.8.16 feeds on these).
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

/** Does the user hold `role`, either org-wide (NULL cost centre) or for the given cost centre? */
export function hasRole(user: CurrentUser, role: Role, costCentreId?: string): boolean {
  return user.roles.some(
    (g) =>
      g.role === role &&
      (g.costCentreId === null || costCentreId === undefined || g.costCentreId === costCentreId),
  );
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
 * Resource-level scope check. Returns true when the user may see records of
 * the given cost centre. Callers respond 404 — not 403 — when this fails for
 * a fetched-by-id resource, so existence is never leaked (A.5.15 acceptance).
 */
export function canAccessCostCentre(user: CurrentUser, costCentreId: string): boolean {
  return user.roles.some(
    (g) =>
      g.costCentreId === costCentreId ||
      (g.costCentreId === null && (g.role === 'accounting' || g.role === 'auditor')),
  );
}
