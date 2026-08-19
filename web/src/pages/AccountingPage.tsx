import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type { AccountingQueueItem } from "../api/types";
import { useApiQuery } from "../hooks/useApi";
import { Button, EmptyState, ErrorNote, formatDate, Money, StatusBadge } from "../components/ui";

/** §5.5: the posting queue — approval trail visible, invoice viewable inline,
 * mark-as-posted captures the CDK reference. */
export function AccountingPage() {
  const queue = useApiQuery<{ queue: AccountingQueueItem[] }>("/api/accounting/queue");
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const post = async (invoiceId: string) => {
    const cdkReference = window.prompt("CDK reference for this posting:");
    if (!cdkReference) return;
    setError(null);
    try {
      await api(`/api/accounting/invoices/${invoiceId}/post`, { method: "POST", body: { cdkReference } });
      queue.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Posting failed");
    }
  };

  const reject = async (invoiceId: string) => {
    const reason = window.prompt("Reason for rejecting this invoice:");
    if (!reason) return;
    setError(null);
    try {
      await api(`/api/accounting/invoices/${invoiceId}/reject`, { method: "POST", body: { reason } });
      queue.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Rejection failed");
    }
  };

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">Accounting</h1>
          <p className="mt-1 text-sm text-slate-500">Invoices awaiting posting to CDK. Every line has an approval behind it.</p>
        </div>
        <a
          className="rounded border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
          href="/api/accounting/batch-export.xlsx"
        >
          Batch export for CDK (.xlsx)
        </a>
      </div>
      <ErrorNote message={error ?? queue.error} />
      {queue.data && queue.data.queue.length === 0 ? <EmptyState message="The posting queue is empty." /> : null}
      {queue.data && queue.data.queue.length > 0 ? (
        <div className="mt-4 space-y-2">
          {queue.data.queue.map((q) => (
            <div key={q.invoice_id} className="rounded-md border border-slate-200 bg-white">
              <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                <div className="min-w-0 break-words text-sm">
                  <p className="font-medium text-slate-900">
                    {q.invoice_no} · <Money amount={q.invoice_amount} currency={q.currency} />
                    <span className="ml-2">
                      <StatusBadge status={q.invoice_status} />
                    </span>
                    {q.variance_vs_approved && Number(q.variance_vs_approved) !== 0 ? (
                      <span className={`ml-2 text-xs ${Number(q.variance_vs_approved) > 0.05 ? "text-red-700" : "text-slate-500"}`}>
                        variance {(Number(q.variance_vs_approved) * 100).toFixed(1)}%
                      </span>
                    ) : null}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    <Link className="underline underline-offset-2" to={`/requisitions/${q.requisition_id}`}>
                      {q.reference}
                    </Link>
                    {" · "}
                    approval {q.approval_reference ?? "—"} · approved <Money amount={q.approved_amount} currency={q.currency} /> · {q.supplier_name ?? "no supplier"}
                    {q.cdk_vendor_ref ? ` (CDK ${q.cdk_vendor_ref})` : ""} · GL {q.gl_account_code ?? "—"} · {q.cost_centre_code}
                  </p>
                  {q.invoice_status === "pending_reapproval" ? (
                    <p className="mt-1 text-xs text-amber-800">
                      Awaiting variance re-approval by{" "}
                      {q.approval_trail?.find((s) => s.purpose === "variance_reapproval" && s.decision === "pending")?.approverName ?? "the final approver"} —
                      posting unlocks when they decide.
                    </p>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <a
                    className="rounded border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
                    href={`/api/attachments/${q.attachment_id}/download`}
                  >
                    Invoice file
                  </a>
                  <Button onClick={() => setExpanded(expanded === q.invoice_id ? null : q.invoice_id)}>Trail</Button>
                  <Button kind="danger" onClick={() => void reject(q.invoice_id)}>
                    Reject
                  </Button>
                  <Button kind="primary" disabled={q.invoice_status !== "submitted"} onClick={() => void post(q.invoice_id)}>
                    Mark as posted
                  </Button>
                </div>
              </div>
              {expanded === q.invoice_id && q.approval_trail ? (
                <ol className="border-t border-slate-100 px-4 py-2 text-xs text-slate-600">
                  {q.approval_trail.map((s) => (
                    <li key={s.stepNo}>
                      {s.stepNo}. {s.approverName ?? "—"} — {s.decision}
                      {s.decidedAt ? ` (${formatDate(s.decidedAt)})` : ""}
                      {s.purpose === "variance_reapproval" ? " · variance re-approval" : ""}
                    </li>
                  ))}
                </ol>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
