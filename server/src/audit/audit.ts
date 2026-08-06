// Audit write path (A.8.15). Every security- or record-relevant event goes
// through here. Hashing/chaining happens in the database trigger (0003) so
// there is exactly one implementation; this module only appends.
import type pg from 'pg';

/** Canonical action names. Add here — never inline strings — so the log stays queryable. */
export const AuditAction = {
  LoginSuccess: 'auth.login.success',
  LoginFailed: 'auth.login.failed',
  Logout: 'auth.logout',
  BreakGlassLogin: 'auth.break_glass.login',
  BreakGlassFailed: 'auth.break_glass.failed',
  SessionExpired: 'auth.session.expired',
  UserProvisioned: 'user.provisioned',
  UserStatusChanged: 'user.status_changed',
  BannerAcknowledged: 'user.banner_acknowledged',
  RoleGranted: 'role.granted',
  RoleRevoked: 'role.revoked',
  RoleGrantRefused: 'role.grant_refused',
  AccessDenied: 'access.denied',
  Export: 'data.export',
  ChainVerified: 'audit.chain.verified',
  ChainFailed: 'audit.chain.verification_failed',
  // Phase 1 — requisition lifecycle & DOA
  RequisitionCreated: 'requisition.created',
  RequisitionUpdated: 'requisition.updated',
  RequisitionSubmitted: 'requisition.submitted',
  RequisitionCancelled: 'requisition.cancelled',
  RequisitionApproved: 'requisition.approved', // final approval — reference issued
  RequisitionDenied: 'requisition.denied',
  ApprovalStepDecided: 'approval.step_decided',
  ApprovalStepReassigned: 'approval.step_reassigned',
  ApprovalStepUnassignable: 'approval.step_unassignable',
  SelfApprovalBlocked: 'approval.self_approval_blocked',
  DoaConflictBlocked: 'approval.doa_conflict_blocked',
  DelegationCreated: 'delegation.created',
  DelegationRevoked: 'delegation.revoked',
  DoaVersionUploaded: 'doa.version_uploaded',
  DoaVersionActivated: 'doa.version_activated',
  DoaActivationRefused: 'doa.activation_refused',
  SettingChanged: 'setting.changed',
  SlaReminderSent: 'approval.sla_reminder',
  SlaEscalated: 'approval.sla_escalated',
  // Phase 2 — budgets, files, invoices
  BudgetVersionCreated: 'budget.version_created',
  BudgetVersionSubmitted: 'budget.version_submitted',
  BudgetVersionApproved: 'budget.version_approved',
  BudgetVersionRejected: 'budget.version_rejected',
  BudgetApprovalRefused: 'budget.approval_refused',
  AttachmentUploaded: 'attachment.uploaded',
  AttachmentQuarantined: 'attachment.quarantined',
  AttachmentDownloaded: 'attachment.downloaded',
  InvoiceSubmitted: 'invoice.submitted',
  InvoiceReapprovalDecided: 'invoice.reapproval_decided',
  // Phase 3 — accounting
  InvoicePosted: 'invoice.posted',
} as const;
export type AuditActionName = (typeof AuditAction)[keyof typeof AuditAction];

export interface AuditEntry {
  actorUserId?: string | null | undefined;
  action: AuditActionName | string;
  entityType: string;
  entityId?: string | null | undefined;
  before?: unknown;
  after?: unknown;
  ipAddress?: string | null | undefined;
  userAgent?: string | null | undefined;
}

type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

export async function writeAudit(db: Queryable, entry: AuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, before, after, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      entry.actorUserId ?? null,
      entry.action,
      entry.entityType,
      entry.entityId ?? null,
      entry.before === undefined ? null : JSON.stringify(entry.before),
      entry.after === undefined ? null : JSON.stringify(entry.after),
      entry.ipAddress ?? null,
      entry.userAgent ?? null,
    ],
  );
}

export interface ChainVerification {
  ok: boolean;
  totalRows: number;
  /** Anchor for external attestation (forward to SIEM): tip of the verified chain. */
  maxSeq: string | null;
  tipHash: string | null;
  defects: { seq: string; problem: string }[];
}

/**
 * Full-chain verification (A.8.15 / A.5.28). Zero defects = intact. Uses the
 * SECURITY DEFINER functions from migration 0003, so the result covers the
 * whole table regardless of the caller's RLS visibility.
 */
export async function verifyAuditChain(db: Queryable): Promise<ChainVerification> {
  const anchor = await db.query<{ total_rows: string; max_seq: string | null; tip_hash: string | null }>(
    'SELECT total_rows::text, max_seq::text, tip_hash FROM audit_chain_anchor()',
  );
  const defects = await db.query<{ seq: string; problem: string }>(
    'SELECT seq::text, problem FROM audit_chain_defects()',
  );
  return {
    ok: defects.rows.length === 0,
    totalRows: Number(anchor.rows[0]?.total_rows ?? 0),
    maxSeq: anchor.rows[0]?.max_seq ?? null,
    tipHash: anchor.rows[0]?.tip_hash ?? null,
    defects: defects.rows,
  };
}

export async function raiseAlert(
  db: Queryable,
  rule: string,
  severity: 'info' | 'warning' | 'critical',
  details: Record<string, unknown>,
): Promise<void> {
  await db.query('INSERT INTO alerts (rule, severity, details) VALUES ($1, $2, $3)', [
    rule,
    severity,
    JSON.stringify(details),
  ]);
}
