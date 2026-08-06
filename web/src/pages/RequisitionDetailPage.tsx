import { useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../api/client";
import type { RequisitionDetail } from "../api/types";
import { useAuth } from "../components/AuthProvider";
import { uploadFile, useApiQuery } from "../hooks/useApi";
import { Button, ErrorNote, Field, formatDate, inputClass, Modal, Money, StatusBadge } from "../components/ui";

function InvoiceModal({ requisitionId, onClose }: { requisitionId: string; onClose: (changed: boolean) => void }) {
  const [meta, setMeta] = useState({ invoiceNo: "", invoiceDate: "", amount: "" });
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const result = await uploadFile<{ needsReapproval: boolean }>(`/api/requisitions/${requisitionId}/invoice`, file, {
        invoiceNo: meta.invoiceNo,
        invoiceDate: meta.invoiceDate,
        amount: meta.amount,
        currency: "TTD",
      });
      if (result.needsReapproval) {
        alert("The invoice varies from the approved amount beyond tolerance — it now requires re-approval by the final approver before Accounting can post it.");
      }
      onClose(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
      setBusy(false);
    }
  };

  return (
    <Modal title="Submit supplier invoice" onClose={() => onClose(false)}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Invoice number">
          <input className={inputClass} value={meta.invoiceNo} onChange={(e) => setMeta((m) => ({ ...m, invoiceNo: e.target.value }))} />
        </Field>
        <Field label="Invoice date">
          <input className={inputClass} type="date" value={meta.invoiceDate} onChange={(e) => setMeta((m) => ({ ...m, invoiceDate: e.target.value }))} />
        </Field>
        <Field label="Amount (TTD)">
          <input className={inputClass} type="number" min="0.01" step="0.01" value={meta.amount} onChange={(e) => setMeta((m) => ({ ...m, amount: e.target.value }))} />
        </Field>
      </div>
      <div className="mt-3">
        <Field label="Invoice file" hint="PDF, JPG, PNG or XLSX — scanned for malware before it is accepted">
          <input type="file" accept=".pdf,.jpg,.jpeg,.png,.xlsx" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-sm" />
        </Field>
      </div>
      <ErrorNote message={error} />
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={() => onClose(false)}>Cancel</Button>
        <Button kind="primary" disabled={busy || !file || !meta.invoiceNo || !meta.invoiceDate || !meta.amount} onClick={() => void submit()}>
          Submit invoice
        </Button>
      </div>
    </Modal>
  );
}

export function RequisitionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { state } = useAuth();
  const me = state.status === "authenticated" ? state.user : null;
  const detail = useApiQuery<RequisitionDetail>(id ? `/api/requisitions/${id}` : null);
  const [error, setError] = useState<string | null>(null);
  const [showInvoice, setShowInvoice] = useState(false);
  const quoteInput = useRef<HTMLInputElement>(null);

  if (detail.loading) return <p className="text-sm text-slate-500">Loading…</p>;
  if (detail.error || !detail.data) return <ErrorNote message={detail.error ?? "Not found"} />;
  const { requisition: r, steps, attachments, invoices } = detail.data;
  const isMine = me?.id === r.requester_id;

  const act = (path: string, body?: unknown) => async () => {
    setError(null);
    try {
      await api(path, { method: "POST", body });
      detail.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    }
  };

  const cancelWithReason = async () => {
    const reason = window.prompt("Reason for cancelling this requisition:");
    if (!reason) return;
    await act(`/api/requisitions/${r.id}/cancel`, { reason })();
  };

  const uploadQuote = async (file: File) => {
    setError(null);
    try {
      await uploadFile(`/api/requisitions/${r.id}/attachments`, file, { type: "quote" });
      detail.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    }
  };

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-3 text-lg font-semibold text-slate-900">
            {r.reference} <StatusBadge status={r.status} />
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            {r.cost_centre_code} · {r.category_code} · raised by {r.requester_name} on {formatDate(r.created_at)}
          </p>
          {/* Gated on live status, not just the reference: a cancellation
              withdraws the authority — telling the requester to "contact the
              supplier" on a cancelled requisition was wrong (review finding). */}
          {r.approval_reference && ["approved", "closed"].includes(r.status) ? (
            <p className="mt-2 rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
              Approval Reference: <span className="font-semibold">{r.approval_reference}</span> — you may now contact the supplier. Quote this reference on the
              invoice.
            </p>
          ) : null}
          {r.approval_reference && r.status === "cancelled" ? (
            <p className="mt-2 rounded border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
              This requisition was approved as <span className="font-semibold">{r.approval_reference}</span> but has since been cancelled — the approval is
              withdrawn and no further spend may reference it.
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          {isMine && r.status === "draft" ? (
            <>
              <Button onClick={() => quoteInput.current?.click()}>Attach quote</Button>
              <Button kind="primary" onClick={act(`/api/requisitions/${r.id}/submit`)}>
                Submit for approval
              </Button>
            </>
          ) : null}
          {isMine && ["draft", "submitted", "approved"].includes(r.status) ? (
            <Button kind="danger" onClick={() => void cancelWithReason()}>
              Cancel requisition
            </Button>
          ) : null}
          {isMine && r.status === "approved" ? (
            <Button kind="primary" onClick={() => setShowInvoice(true)}>
              Submit invoice
            </Button>
          ) : null}
          {r.approval_reference && ["approved", "closed"].includes(r.status) ? (
            <a
              className="rounded border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
              href={`/api/requisitions/${r.id}/certificate.pdf`}
            >
              Approval certificate (PDF)
            </a>
          ) : null}
        </div>
      </div>
      <input
        ref={quoteInput}
        type="file"
        accept=".pdf,.jpg,.jpeg,.png,.xlsx"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void uploadQuote(f);
          e.target.value = "";
        }}
      />
      <ErrorNote message={error} />

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section className="rounded-md border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-slate-900">Details</h2>
          <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <dt className="text-slate-500">Amount</dt>
            <dd className="font-medium tabular-nums">
              <Money amount={r.amount} currency={r.currency} />
            </dd>
            <dt className="text-slate-500">Supplier</dt>
            <dd>{r.supplier_name ?? "—"}</dd>
            <dt className="text-slate-500">Needed by</dt>
            <dd>{r.needed_by ? formatDate(r.needed_by) : "—"}</dd>
            <dt className="text-slate-500">Description</dt>
            <dd>{r.description}</dd>
            <dt className="text-slate-500">Justification</dt>
            <dd>{r.justification}</dd>
            <dt className="text-slate-500">Classification</dt>
            <dd>{r.classification}</dd>
          </dl>
        </section>

        <section className="rounded-md border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-slate-900">Approval trail</h2>
          {steps.length === 0 ? <p className="mt-2 text-sm text-slate-500">Not yet submitted.</p> : null}
          <ol className="mt-2 space-y-2">
            {steps.map((s) => (
              <li key={s.id} className="flex items-start justify-between gap-2 rounded border border-slate-100 bg-slate-50 px-3 py-2 text-sm">
                <div>
                  <p className="font-medium text-slate-900">
                    {s.step_no}. {s.assigned_name ?? "—"}
                    {s.delegate_of_name ? <span className="text-slate-500"> (delegate of {s.delegate_of_name})</span> : null}
                  </p>
                  <p className="text-xs text-slate-500">
                    {s.assigned_role ?? s.assigned_job_title ?? ""}
                    {s.purpose === "variance_reapproval" ? " · variance re-approval" : ""}
                    {s.decided_at ? ` · ${formatDate(s.decided_at)}` : ""}
                  </p>
                  {s.decision_reason ? <p className="mt-1 text-xs text-red-700">Reason: {s.decision_reason}</p> : null}
                </div>
                {/* A step the chain never reached is not "pending" — nobody
                    is going to decide it (review finding). */}
                {s.decision === "pending" && ["denied", "cancelled"].includes(r.status) ? (
                  <span className="inline-block rounded border border-transparent bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-500">
                    not reached
                  </span>
                ) : (
                  <StatusBadge status={s.decision} />
                )}
              </li>
            ))}
          </ol>
        </section>

        <section className="rounded-md border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-slate-900">Attachments</h2>
          {attachments.length === 0 ? <p className="mt-2 text-sm text-slate-500">None.</p> : null}
          <ul className="mt-2 space-y-1 text-sm">
            {attachments.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-2">
                <span>
                  {a.scan_status === "clean" ? (
                    <a className="text-slate-900 underline-offset-2 hover:underline" href={`/api/attachments/${a.id}/download`}>
                      {a.filename}
                    </a>
                  ) : (
                    <span className="text-slate-400">{a.filename}</span>
                  )}
                  <span className="ml-2 text-xs text-slate-400">
                    {a.type} · {(a.size_bytes / 1024).toFixed(0)} KB
                  </span>
                </span>
                <StatusBadge status={a.scan_status} />
              </li>
            ))}
          </ul>
        </section>

        <section className="rounded-md border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-slate-900">Invoices</h2>
          {invoices.length === 0 ? <p className="mt-2 text-sm text-slate-500">None submitted.</p> : null}
          <ul className="mt-2 space-y-2 text-sm">
            {invoices.map((i) => (
              <li key={i.id} className="flex items-center justify-between gap-2 rounded border border-slate-100 bg-slate-50 px-3 py-2">
                <div>
                  <p className="font-medium">
                    {i.invoice_no} · <Money amount={i.amount} currency={i.currency} />
                  </p>
                  <p className="text-xs text-slate-500">
                    {formatDate(i.invoice_date)}
                    {i.variance_vs_approved !== null ? ` · variance ${(Number(i.variance_vs_approved) * 100).toFixed(1)}%` : ""}
                    {i.cdk_reference ? ` · CDK ${i.cdk_reference}` : ""}
                  </p>
                  {i.status === "rejected" && i.rejection_reason ? (
                    <p className="mt-1 text-xs text-red-700">
                      Rejected{i.rejected_at ? ` ${formatDate(i.rejected_at)}` : ""}: {i.rejection_reason} — submit a corrected invoice if the purchase still
                      stands.
                    </p>
                  ) : null}
                </div>
                <StatusBadge status={i.status} />
              </li>
            ))}
          </ul>
        </section>
      </div>

      {showInvoice ? (
        <InvoiceModal
          requisitionId={r.id}
          onClose={(changed) => {
            setShowInvoice(false);
            if (changed) detail.refresh();
          }}
        />
      ) : null}
    </div>
  );
}
