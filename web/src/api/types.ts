/** API response types (Phases 0-3). Server shapes are authoritative —
 * `server/src/routes/*` — these mirror them. */

export interface RoleGrant {
  role: string;
  costCentreId: string | null;
  /** DOA tier of an approver grant (5 = supervisors/first-line managers,
   * 4 = senior managers/VPs, 3 = executive). */
  tier?: number | null;
}
export type RoleLike = string | RoleGrant;

export interface Me {
  id: string;
  email: string;
  displayName: string;
  jobTitle?: string | null;
  /** Home department (a cost-centre row; display only — never authority). */
  department?: { id: string; code: string; name: string; department: string } | null;
  roles: RoleLike[];
  bannerAcknowledged: boolean;
}

const ROLE_LABELS: Record<string, string> = {
  sysadmin: "System Admin",
  requester: "Requester",
  approver: "Approver",
  accounting: "Accounts",
  auditor: "Auditor",
  budget_owner: "Budget Owner",
  budget_approver: "Budget Approver",
  doa_admin: "DOA Admin",
  doa_approver: "DOA Approver",
  supplier_approver: "Supplier Approver",
};

/** Human label for one role grant: "Approver (Tier 4)", "Accounts", … */
export function roleLabel(entry: RoleLike): string {
  const grant = typeof entry === "string" ? { role: entry, costCentreId: null } : entry;
  const base = ROLE_LABELS[grant.role] ?? grant.role.replaceAll("_", " ");
  if (grant.role === "approver" && grant.tier != null) return `${base} (Tier ${grant.tier})`;
  return base;
}

/** Distinct role labels for the top-bar summary. */
export function roleNames(roles: RoleLike[] | null | undefined): string[] {
  if (!roles) {
    return [];
  }
  return [...new Set(roles.map(roleLabel))];
}

export function hasRole(me: Me | null, role: string, costCentreId?: string): boolean {
  if (!me) return false;
  return me.roles.some((r) => {
    const grant = typeof r === "string" ? { role: r, costCentreId: null } : r;
    if (grant.role !== role) return false;
    if (costCentreId === undefined) return true;
    return grant.costCentreId === null || grant.costCentreId === costCentreId;
  });
}

// ── Reference data ───────────────────────────────────────────────────────────
export interface CostCentre {
  id: string;
  code: string;
  name: string;
  department: string;
}
export interface Category {
  id: string;
  code: string;
  name: string;
}
export interface Supplier {
  id: string;
  name: string;
}
export interface ReferenceData {
  costCentres: CostCentre[];
  categories: Category[];
  suppliers: Supplier[];
}

// ── Requisitions ─────────────────────────────────────────────────────────────
export type RequisitionStatus = "draft" | "submitted" | "approved" | "denied" | "closed" | "cancelled";

export interface RequisitionDocument {
  id: string;
  filename: string;
  scan_status: "pending" | "clean" | "infected" | "error";
}

export interface RequisitionRow {
  id: string;
  reference: string;
  status: RequisitionStatus;
  amount: string;
  currency: string;
  description: string;
  created_at: string;
  submitted_at: string | null;
  approved_at: string | null;
  approval_reference: string | null;
  needed_by: string | null;
  cost_centre_code: string;
  department?: string;
  category_code: string;
  requester_name: string;
  supplier_name: string | null;
  /** List-page enrichment (quotation/invoice columns). Absent on detail. */
  requires_quotes?: number | null;
  quote_files?: RequisitionDocument[];
  invoice_files?: RequisitionDocument[];
  live_invoice_count?: number;
  posted_invoice_count?: number;
}

/** The client's status language for the list page: Draft (with quotation) →
 * Pending approval → Approved (invoice pending) → Completed. */
export function requisitionDisplayStatus(r: RequisitionRow): {
  badge: string;
  pendingDocument: "quotation" | "invoice" | null;
} {
  switch (r.status) {
    case "draft":
      // Only nag when the band actually requires quotes: requires_quotes on a
      // draft is the LIVE active-rule value (the snapshot freezes at submit),
      // and a zero-quote band must not demand a document nobody needs.
      return {
        badge: "draft",
        pendingDocument:
          (r.requires_quotes ?? 0) > 0 && !(r.quote_files ?? []).some((f) => f.scan_status === "clean")
            ? "quotation"
            : null,
      };
    case "submitted":
      return { badge: "pending_approval", pendingDocument: null };
    case "approved":
      // live_invoice_count excludes rejected invoices (and infected uploads
      // never create one), so a rejected invoice correctly re-surfaces the
      // "invoice pending" cue — attachment presence does not.
      return { badge: "approved", pendingDocument: (r.live_invoice_count ?? 0) === 0 ? "invoice" : null };
    case "closed":
      return { badge: "completed", pendingDocument: null };
    default:
      return { badge: r.status, pendingDocument: null };
  }
}

export interface ApprovalStepRow {
  id: string;
  step_no: number;
  assigned_role: string | null;
  decision: "pending" | "approved" | "denied";
  decision_reason: string | null;
  decided_at: string | null;
  purpose: "doa" | "variance_reapproval" | "finance_review";
  budget_remaining_at_decision: string | null;
  assigned_name: string | null;
  assigned_job_title: string | null;
  delegate_of_name: string | null;
}

export interface AttachmentRow {
  id: string;
  type: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  scan_status: "pending" | "clean" | "infected" | "error";
  classification: string;
  uploaded_at: string;
  uploaded_by_name: string;
}

export interface InvoiceRow {
  id: string;
  invoice_no: string;
  invoice_date: string;
  amount: string;
  currency: string;
  status: "submitted" | "pending_reapproval" | "posted" | "rejected";
  variance_vs_approved: string | null;
  cdk_reference: string | null;
  posted_at: string | null;
  created_at: string;
  attachment_id: string;
  rejection_reason: string | null;
  rejected_at: string | null;
}

export interface RequisitionDetail {
  requisition: RequisitionRow & {
    justification: string;
    classification: string;
    cost_centre_id: string;
    category_id: string;
    requester_id: string;
    workflow_flags: unknown[];
  };
  steps: ApprovalStepRow[];
  attachments: AttachmentRow[];
  invoices: InvoiceRow[];
}

export interface PreviewResponse {
  route: { stepNo: number; label: string; approverName: string; approverJobTitle: string | null }[] | null;
  routeError?: { code: string; message: string };
  flags?: string[];
  requiresQuotes: number | null;
  budget: { period: string; available: string; afterThisRequest: string };
}

// ── Approvals ────────────────────────────────────────────────────────────────
export interface QueueItem {
  step_id: string;
  step_no: number;
  purpose: "doa" | "variance_reapproval" | "finance_review";
  via_delegation: boolean;
  requisition_id: string;
  reference: string;
  description: string;
  amount: string;
  currency: string;
  submitted_at: string | null;
  needed_by: string | null;
  cost_centre_code: string;
  department: string;
  category_code: string;
  category_name: string;
  requester_name: string;
  supplier_name: string | null;
  invoice_id: string | null;
  invoice_no: string | null;
  invoice_amount: string | null;
  variance_vs_approved: string | null;
}

export interface StepDetail {
  step: {
    id: string;
    step_no: number;
    purpose: string;
    decision: string;
    requisition_id: string;
    reference: string;
    description: string;
    justification: string;
    amount: string;
    currency: string;
    requisition_status: string;
    needed_by: string | null;
    cost_centre_code: string;
    category_code: string;
    category_name: string;
    requester_name: string;
    supplier_name: string | null;
    workflow_flags: unknown[];
    /** Present when purpose = variance_reapproval: the invoice being decided. */
    invoice_no: string | null;
    invoice_amount: string | null;
    invoice_status: string | null;
    variance_vs_approved: string | null;
  };
  budget: {
    period: string;
    available: string;
    afterApproval: string;
    /** What this decision would newly take from the budget (variance steps:
     * the excess beyond the already-committed approval, not the full amount). */
    incrementalImpact: string;
  };
}

export interface DelegationRow {
  id: string;
  delegator_id: string;
  delegate_id: string;
  cost_centre_id: string | null;
  starts_at: string;
  ends_at: string;
  reason: string;
  created_at: string;
  revoked_at: string | null;
  delegator_name: string;
  delegate_name: string;
  cost_centre_code: string | null;
}

// ── Budgets (§5.9) ───────────────────────────────────────────────────────────
export interface CategoryPosition {
  categoryId: string;
  categoryCode: string;
  categoryName: string;
  currency: string;
  budget: string;
  committed: string;
  actual: string;
  available: string;
}
export interface BudgetPosition {
  costCentreId: string;
  period: string;
  budgetVersionId: string | null;
  categories: CategoryPosition[];
  totals: { budget: string; committed: string; actual: string; available: string };
}

export type BudgetVersionStatus = "draft" | "pending_approval" | "active" | "rejected" | "superseded";

export interface BudgetVersionRow {
  id: string;
  cost_centre_id: string;
  cost_centre_code: string;
  period: string;
  version_no: number;
  status: BudgetVersionStatus;
  reason: string;
  created_at: string;
  submitted_at: string | null;
  approved_at: string | null;
  rejected_at: string | null;
  rejection_reason: string | null;
  proposed_by_name: string;
  approved_by_name: string | null;
  rejected_by_name: string | null;
  line_count: number;
  total_amount: string;
}

export interface BudgetVersionDetail {
  version: BudgetVersionRow & { proposed_by: string };
  lines: { category_id: string; category_code: string; category_name: string; amount: string; currency: string }[];
  diff: { categoryCode: string; before: string | null; after: string | null; change: string }[];
}

// ── Accounting ───────────────────────────────────────────────────────────────
export interface AccountingQueueItem {
  invoice_id: string;
  invoice_no: string;
  invoice_date: string;
  invoice_amount: string;
  currency: string;
  invoice_status: string;
  variance_vs_approved: string | null;
  created_at: string;
  attachment_id: string;
  requisition_id: string;
  reference: string;
  approval_reference: string | null;
  approved_amount: string;
  description: string;
  cost_centre_code: string;
  category_code: string;
  gl_account_code: string | null;
  supplier_name: string | null;
  cdk_vendor_ref: string | null;
  requester_name: string;
  approval_trail: { stepNo: number; decision: string; decidedAt: string | null; approverName: string | null; purpose: string }[] | null;
}

// ── Logbook ──────────────────────────────────────────────────────────────────
export interface LogbookEntry extends RequisitionRow {
  closed_at: string | null;
  approval_trail:
    | { stepNo: number; approverName: string | null; decision: string; decidedAt: string | null; delegateOf: string | null; purpose: string }[]
    | null;
  invoices: { invoiceNo: string; status: string; amount: string; cdkReference: string | null; postedAt: string | null }[] | null;
}

// ── Dashboard ────────────────────────────────────────────────────────────────
export interface DashboardData {
  pendingMyApproval: number;
  myOpenRequisitions: number;
  deniedThisMonth: number;
  pendingBudgetApprovals: number;
  pendingDoaActivations: number;
  budgetPositions: {
    costCentreId: string;
    costCentreCode: string;
    costCentreName: string;
    period: string;
    totals: { budget: string; committed: string; actual: string; available: string };
    hasActiveBudget: boolean;
  }[];
}

// ── DOA admin ────────────────────────────────────────────────────────────────
export interface DoaVersionRow {
  id: string;
  version_no: number;
  status: "draft" | "active" | "superseded";
  effective_from: string | null;
  uploaded_at: string;
  approved_at: string | null;
  uploaded_by_name: string;
  approved_by_name: string | null;
  rule_count: number;
}

export interface DoaRuleRow {
  id: string;
  category_code: string;
  cost_centre_code: string | null;
  min_amount: string;
  max_amount: string | null;
  currency: string;
  approval_sequence: { type: string; value: string; label?: string }[];
  requires_quotes: number;
  notes: string | null;
}

/** GET /api/doa/versions/:id — the §6.1 activation-review payload. */
export interface DoaVersionDetail {
  version: {
    id: string;
    version_no: number;
    status: "draft" | "active" | "superseded";
    uploaded_at: string;
    approved_at: string | null;
    uploaded_by_name: string;
    approved_by_name: string | null;
    validation_warnings: string[];
  };
  rules: DoaRuleRow[];
}

export interface DoaDiffEntry {
  categoryCode: string;
  costCentreCode: string | null;
  band: string;
  change: "added" | "removed" | "changed";
  detail?: string;
}

/** GET /api/doa/versions/:id/diff — changes vs the active version. */
export interface DoaDiffResponse {
  activeVersionNo: number | null;
  entries: DoaDiffEntry[];
}

export interface AppSettingRow {
  key: string;
  value: unknown;
  description: string;
  updated_at: string;
}

// ── Suppliers (approved-supplier workflow) ───────────────────────────────────
export type SupplierStatus = "pending_approval" | "active" | "rejected" | "inactive";

export interface SupplierRow {
  id: string;
  name: string;
  cdk_vendor_ref: string | null;
  tax_id: string | null;
  status: SupplierStatus;
  created_at: string;
  requested_at: string | null;
  requested_reason: string | null;
  requested_by: string | null;
  requested_by_name: string | null;
  approved_at: string | null;
  approved_by_name: string | null;
  rejected_at: string | null;
  rejected_by_name: string | null;
  rejection_reason: string | null;
}

// ── Admin users ──────────────────────────────────────────────────────────────
export interface AdminUserRole {
  assignmentId: string;
  role: string;
  costCentreId: string | null;
  costCentreCode: string | null;
  tier: number | null;
  grantedAt: string;
  grantedReason: string;
}

export interface AdminUser {
  id: string;
  email: string;
  display_name: string;
  job_title: string | null;
  status: "active" | "disabled";
  last_login_at: string | null;
  home_cost_centre_id: string | null;
  home_department: string | null;
  pending_first_login: boolean;
  roles: AdminUserRole[];
}
