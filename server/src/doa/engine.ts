// DOA rule engine (plan §5.1, §5.2, §3).
// Resolves the rule for (category × cost centre × amount) from the ACTIVE DOA
// version, builds the sequential approver chain, and enforces segregation of
// duties in code (A.5.3): a requester is never assigned their own requisition
// — the engine skips to the next level and flags it.
//
// Approver descriptors in doa_rules.approval_sequence (ordered array):
//   { "type": "job_title", "value": "Finance Manager" }
//   { "type": "user",      "value": "someone@massymotors.com" }
//   { "type": "role",      "value": "approver" }        (any approver of the cost centre)
// Every descriptor resolves to users holding the 'approver' role for the
// requisition's cost centre — a job title alone never grants authority
// (A.5.15: authority flows from role grants only).
import { z } from 'zod';
import type pg from 'pg';

const descriptorSchema = z.object({
  type: z.enum(['job_title', 'user', 'role']),
  value: z.string().min(1),
  label: z.string().optional(),
});
export type ApproverDescriptor = z.infer<typeof descriptorSchema>;

export interface DoaRule {
  id: string;
  versionId: string;
  versionNo: number;
  categoryId: string;
  costCentreId: string | null;
  minAmount: string;
  maxAmount: string | null;
  currency: string;
  approvalSequence: ApproverDescriptor[];
  requiresQuotes: number;
  notes: string | null;
  uploadedBy: string;
  approvedBy: string | null;
}

export interface ResolvedStep {
  stepNo: number;
  descriptor: ApproverDescriptor;
  userId: string;
  displayName: string;
  jobTitle: string | null;
  /** Other users the descriptor also matched (recorded for the snapshot). */
  otherCandidateIds: string[];
}

export type WorkflowFlag =
  | { type: 'self_approval_skip'; descriptor: ApproverDescriptor; userId: string }
  | { type: 'duplicate_approver_collapsed'; descriptor: ApproverDescriptor; userId: string }
  | { type: 'multiple_candidates'; descriptor: ApproverDescriptor; chosenUserId: string; candidateIds: string[] };

export class DoaError extends Error {
  constructor(
    public readonly code:
      | 'no_active_doa_version'
      | 'no_matching_rule'
      | 'unresolvable_approver'
      | 'unroutable_after_skips',
    message: string,
  ) {
    super(message);
  }
}

type Queryable = Pick<pg.PoolClient, 'query'>;

/** The rule that applies right now. A cost-centre-specific rule beats an
 * all-cost-centres (NULL) rule for the same category and band. */
export async function resolveRule(
  client: Queryable,
  params: { categoryId: string; costCentreId: string; amount: number; currency: string },
): Promise<DoaRule> {
  const version = await client.query<{ id: string; version_no: number; uploaded_by: string; approved_by: string | null }>(
    `SELECT id, version_no, uploaded_by, approved_by FROM doa_matrix_versions WHERE status = 'active'`,
  );
  if (version.rows.length === 0) {
    throw new DoaError('no_active_doa_version', 'No active DOA version exists — requisitions cannot be routed');
  }
  const v = version.rows[0]!;

  const { rows } = await client.query<{
    id: string;
    category_id: string;
    cost_centre_id: string | null;
    min_amount: string;
    max_amount: string | null;
    currency: string;
    approval_sequence: unknown;
    requires_quotes: number;
    notes: string | null;
  }>(
    `SELECT id, category_id, cost_centre_id, min_amount, max_amount, currency,
            approval_sequence, requires_quotes, notes
     FROM doa_rules
     WHERE version_id = $1
       AND category_id = $2
       AND (cost_centre_id = $3 OR cost_centre_id IS NULL)
       AND min_amount <= $4
       AND (max_amount IS NULL OR max_amount > $4)
       AND currency = $5
     ORDER BY cost_centre_id NULLS LAST
     LIMIT 1`,
    [v.id, params.categoryId, params.costCentreId, params.amount, params.currency],
  );
  const rule = rows[0];
  if (!rule) {
    throw new DoaError(
      'no_matching_rule',
      'The active DOA has no rule for this category, cost centre and amount — contact the DOA administrator',
    );
  }
  const sequence = z.array(descriptorSchema).min(1).parse(rule.approval_sequence);
  return {
    id: rule.id,
    versionId: v.id,
    versionNo: v.version_no,
    categoryId: rule.category_id,
    costCentreId: rule.cost_centre_id,
    minAmount: rule.min_amount,
    maxAmount: rule.max_amount,
    currency: rule.currency,
    approvalSequence: sequence,
    requiresQuotes: rule.requires_quotes,
    notes: rule.notes,
    uploadedBy: v.uploaded_by,
    approvedBy: v.approved_by,
  };
}

interface Candidate {
  id: string;
  display_name: string;
  job_title: string | null;
  granted_at: Date;
}

/** Users a descriptor resolves to: ACTIVE users holding the 'approver' role
 * for the cost centre, filtered by the descriptor, ordered deterministically
 * (earliest approver grant first — ASSUMPTIONS §2.17). */
async function resolveDescriptor(
  client: Queryable,
  descriptor: ApproverDescriptor,
  costCentreId: string,
): Promise<Candidate[]> {
  const base = `
    SELECT u.id, u.display_name, u.job_title, min(ra.granted_at) AS granted_at
    FROM users u
    JOIN roles_assignments ra ON ra.user_id = u.id
      AND ra.role = 'approver'
      AND ra.revoked_at IS NULL
      AND (ra.cost_centre_id = $1 OR ra.cost_centre_id IS NULL)
    WHERE u.status = 'active'`;
  const order = ` GROUP BY u.id, u.display_name, u.job_title ORDER BY min(ra.granted_at), u.id`;
  if (descriptor.type === 'job_title') {
    const { rows } = await client.query<Candidate>(base + ` AND lower(u.job_title) = lower($2)` + order, [
      costCentreId,
      descriptor.value,
    ]);
    return rows;
  }
  if (descriptor.type === 'user') {
    const { rows } = await client.query<Candidate>(base + ` AND lower(u.email) = lower($2)` + order, [
      costCentreId,
      descriptor.value,
    ]);
    return rows;
  }
  const { rows } = await client.query<Candidate>(base + order, [costCentreId]);
  return rows;
}

export interface ResolvedChain {
  steps: ResolvedStep[];
  flags: WorkflowFlag[];
}

/**
 * Build the sequential chain for a requisition. Self-approval is skipped and
 * flagged (A.5.3); a person appearing twice approves once (first occurrence).
 * Throws when a descriptor matches nobody, or when the skips empty the chain.
 */
export async function resolveChain(
  client: Queryable,
  rule: DoaRule,
  costCentreId: string,
  requesterId: string,
): Promise<ResolvedChain> {
  const steps: ResolvedStep[] = [];
  const flags: WorkflowFlag[] = [];
  const assigned = new Set<string>();

  for (const descriptor of rule.approvalSequence) {
    const candidates = await resolveDescriptor(client, descriptor, costCentreId);
    if (candidates.length === 0) {
      throw new DoaError(
        'unresolvable_approver',
        `No active approver matches "${descriptor.label ?? descriptor.value}" for this cost centre — the DOA matrix or role grants need attention`,
      );
    }

    // A.5.3: the requester can never be their own approver — skip to the next
    // candidate for this level; if none remains, skip the level and flag it.
    const eligible = candidates.filter((c) => c.id !== requesterId);
    if (eligible.length === 0) {
      flags.push({ type: 'self_approval_skip', descriptor, userId: requesterId });
      continue;
    }
    if (eligible.length < candidates.length) {
      flags.push({ type: 'self_approval_skip', descriptor, userId: requesterId });
    }

    const chosen = eligible[0]!;
    if (assigned.has(chosen.id)) {
      flags.push({ type: 'duplicate_approver_collapsed', descriptor, userId: chosen.id });
      continue;
    }
    if (eligible.length > 1) {
      flags.push({
        type: 'multiple_candidates',
        descriptor,
        chosenUserId: chosen.id,
        candidateIds: eligible.map((c) => c.id),
      });
    }

    assigned.add(chosen.id);
    steps.push({
      stepNo: steps.length + 1,
      descriptor,
      userId: chosen.id,
      displayName: chosen.display_name,
      jobTitle: chosen.job_title,
      otherCandidateIds: eligible.slice(1).map((c) => c.id),
    });
  }

  if (steps.length === 0) {
    throw new DoaError(
      'unroutable_after_skips',
      'After removing the requester from the chain no approver remains — the DOA matrix cannot route this requisition',
    );
  }
  return { steps, flags };
}

/** The frozen snapshot written to requisitions.doa_rule_snapshot at submit
 * time (plan §4 design rule 1): the rule AND how it resolved. */
export function buildSnapshot(rule: DoaRule, chain: ResolvedChain): Record<string, unknown> {
  return {
    rule: {
      id: rule.id,
      versionId: rule.versionId,
      versionNo: rule.versionNo,
      categoryId: rule.categoryId,
      costCentreId: rule.costCentreId,
      minAmount: rule.minAmount,
      maxAmount: rule.maxAmount,
      currency: rule.currency,
      approvalSequence: rule.approvalSequence,
      requiresQuotes: rule.requiresQuotes,
      notes: rule.notes,
    },
    resolvedSteps: chain.steps.map((s) => ({
      stepNo: s.stepNo,
      descriptor: s.descriptor,
      userId: s.userId,
      otherCandidateIds: s.otherCandidateIds,
    })),
    flags: chain.flags,
    resolvedAt: new Date().toISOString(),
  };
}
