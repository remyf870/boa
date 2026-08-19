// Notification outbox writer (plan §5.2, A.5.14). Every message is a subject,
// a deep link and a requisition/budget REFERENCE — never amounts, supplier
// names, decision reasons or attachments. The mailer job
// (scripts/send-notifications.ts) delivers whatever lands here; writing to the
// outbox inside the same transaction as the business change means a crash can
// never lose the notification or send one for a rolled-back change.
import type pg from 'pg';

type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

export const NotificationTemplate = {
  ApprovalRequested: 'approval_requested',
  ApprovalReminder: 'approval_reminder',
  ApprovalEscalation: 'approval_escalation',
  RequisitionApproved: 'requisition_approved',
  RequisitionDenied: 'requisition_denied',
  VarianceReapprovalRequested: 'variance_reapproval_requested',
  BudgetSubmitted: 'budget_submitted',
  BudgetApproved: 'budget_approved',
  BudgetRejected: 'budget_rejected',
  DoaSubmitted: 'doa_submitted',
  DoaActivated: 'doa_activated',
  InvoiceRejected: 'invoice_rejected',
  InvoiceReapprovalApproved: 'invoice_reapproval_approved',
  InvoiceReapprovalRejected: 'invoice_reapproval_rejected',
  AttachmentQuarantined: 'attachment_quarantined',
  SupplierApprovalRequested: 'supplier_approval_requested',
  SupplierBulkApprovalRequested: 'supplier_bulk_approval_requested',
  SupplierApproved: 'supplier_approved',
  SupplierRejected: 'supplier_rejected',
} as const;
export type NotificationTemplateName = (typeof NotificationTemplate)[keyof typeof NotificationTemplate];

/** Subject lines — reference only, no financial data (A.5.14). */
const SUBJECTS: Record<NotificationTemplateName, (ref: string) => string> = {
  approval_requested: (ref) => `Requisition ${ref} awaits your approval`,
  approval_reminder: (ref) => `Reminder: requisition ${ref} is still awaiting your approval`,
  approval_escalation: (ref) => `Escalation: requisition ${ref} has exceeded the approval SLA`,
  requisition_approved: (ref) => `Requisition ${ref} is approved — you may now contact the supplier`,
  requisition_denied: (ref) => `Requisition ${ref} was denied — open the app for the reason`,
  variance_reapproval_requested: (ref) => `Invoice variance on ${ref} requires your re-approval`,
  budget_submitted: (ref) => `Budget proposal ${ref} awaits your approval`,
  budget_approved: (ref) => `Budget proposal ${ref} was approved and is now active`,
  budget_rejected: (ref) => `Budget proposal ${ref} was not approved — open the app for the reason`,
  doa_submitted: (ref) => `DOA matrix ${ref} awaits your activation review`,
  doa_activated: (ref) => `DOA matrix ${ref} is now active — requisitions route on it`,
  invoice_rejected: (ref) => `An invoice on ${ref} was rejected — open the app for the reason`,
  invoice_reapproval_approved: (ref) => `The invoice variance on ${ref} was approved — the invoice can be posted`,
  invoice_reapproval_rejected: (ref) => `The invoice variance on ${ref} was declined — the invoice will not be posted`,
  attachment_quarantined: (ref) => `An upload on ${ref} failed the malware scan and was quarantined`,
  // Supplier subjects carry an opaque request reference, never the supplier's
  // name (A.5.14 — same rule as amounts).
  supplier_approval_requested: (ref) => `Supplier request ${ref} awaits your approval`,
  // Bulk uploads digest to ONE message whose reference is a count ("12
  // supplier requests"), so a 40-row workbook does not read as a single
  // request (review finding) — and per A.5.14 a count is as safe as a ref.
  supplier_bulk_approval_requested: (ref) => `${ref} await your approval`,
  supplier_approved: (ref) => `Supplier request ${ref} was approved — the supplier is now available`,
  supplier_rejected: (ref) => `Supplier request ${ref} was not approved — open the app for the reason`,
};

export interface NotificationRequest {
  recipientUserId: string;
  template: NotificationTemplateName;
  /** Human-readable reference (e.g. MM-LEA-2026-0001 or "LEA FY2026-Q3 v2"). */
  reference: string;
  /** App-relative deep link, e.g. /requisitions/<id>. */
  deepLink: string;
}

export async function queueNotification(db: Queryable, req: NotificationRequest): Promise<void> {
  await db.query(
    `INSERT INTO notification_outbox (recipient_user_id, template, subject, deep_link, context)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      req.recipientUserId,
      req.template,
      SUBJECTS[req.template](req.reference),
      req.deepLink,
      JSON.stringify({ reference: req.reference }),
    ],
  );
}
