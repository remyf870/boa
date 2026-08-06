import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type { DelegationRow, QueueItem, ReferenceData, StepDetail } from "../api/types";
import { useAuth } from "../components/AuthProvider";
import { useApiQuery } from "../hooks/useApi";
import { Button, EmptyState, ErrorNote, Field, formatDate, inputClass, Modal, Money, StatusBadge } from "../components/ui";

/** §5.2: the decide modal shows the budget impact BEFORE the decision. */
function DecideModal({ stepId, onClose }: { stepId: string; onClose: (decided: boolean) => void }) {
  const detail = useApiQuery<StepDetail>(`/api/approvals/steps/${stepId}`);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const decide = async (kind: "approve" | "deny") => {
    if (kind === "deny" && reason.trim().length < 3) {
      setError("A reason is mandatory when denying (plan §5.2).");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api(`/api/approvals/steps/${stepId}/${kind}`, {
        method: "POST",
        body: reason.trim() ? { reason: reason.trim() } : {},
      });
      onClose(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Decision failed");
      setBusy(false);
    }
  };

  return (
    <Modal title="Review and decide" onClose={() => onClose(false)}>
      {detail.loading ? <p className="text-sm text-slate-500">Loading…</p> : null}
      <ErrorNote message={detail.error} />
      {detail.data ? (
        <>
          <div className="text-sm">
            <p className="font-medium text-slate-900">
              {detail.data.step.reference} — <Money amount={detail.data.step.amount} currency={detail.data.step.currency} />
            </p>
            <p className="mt-1 text-slate-600">{detail.data.step.description}</p>
            <p className="mt-1 text-slate-500">Justification: {detail.data.step.justification}</p>
            <p className="mt-1 text-xs text-slate-500">
              {detail.data.step.cost_centre_code} · {detail.data.step.category_name} · requested by {detail.data.step.requester_name}
              {detail.data.step.supplier_name ? ` · supplier ${detail.data.step.supplier_name}` : ""}
            </p>
            {detail.data.step.purpose === "variance_reapproval" ? (
              <p className="mt-2 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900">
                This is an invoice variance re-approval: the supplier invoice exceeds the approved amount beyond the configured tolerance.
              </p>
            ) : null}
          </div>
          <div className="mt-3 rounded border border-slate-200 bg-slate-50 p-3 text-sm">
            <p className="font-medium text-slate-900">Budget impact ({detail.data.budget.period})</p>
            <p className="mt-1 text-slate-700">
              Available now: <Money amount={detail.data.budget.available} currency={detail.data.step.currency} /> · After approval:{" "}
              <Money amount={detail.data.budget.afterApproval} currency={detail.data.step.currency} />
            </p>
          </div>
          <div className="mt-3">
            <Field label="Reason (mandatory when denying)">
              <textarea className={inputClass} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
          </div>
          <ErrorNote message={error} />
          <div className="mt-4 flex justify-end gap-2">
            <Button onClick={() => onClose(false)}>Close</Button>
            <Button kind="danger" disabled={busy} onClick={() => void decide("deny")}>
              Deny
            </Button>
            <Button kind="primary" disabled={busy} onClick={() => void decide("approve")}>
              Approve
            </Button>
          </div>
        </>
      ) : null}
    </Modal>
  );
}

function DelegationsSection() {
  const { state } = useAuth();
  const me = state.status === "authenticated" ? state.user : null;
  const delegations = useApiQuery<{ delegations: DelegationRow[] }>("/api/delegations");
  const reference = useApiQuery<ReferenceData>("/api/reference");
  const [form, setForm] = useState({ delegateEmail: "", costCentreId: "", startsAt: "", endsAt: "", reason: "" });
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setError(null);
    try {
      await api("/api/delegations", {
        method: "POST",
        body: {
          delegateEmail: form.delegateEmail,
          costCentreId: form.costCentreId || null,
          startsAt: form.startsAt,
          endsAt: form.endsAt,
          reason: form.reason,
        },
      });
      setForm({ delegateEmail: "", costCentreId: "", startsAt: "", endsAt: "", reason: "" });
      delegations.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the delegation");
    }
  };

  const revoke = async (id: string) => {
    await api(`/api/delegations/${id}/revoke`, { method: "POST" });
    delegations.refresh();
  };

  return (
    <section className="mt-8">
      <h2 className="text-base font-semibold text-slate-900">Delegation</h2>
      <p className="mt-1 text-sm text-slate-500">
        Nominate a delegate for a date range while you are away. The delegate must hold the approver role; decisions record both identities (§5.2).
      </p>
      <div className="mt-3 grid grid-cols-1 gap-3 rounded-md border border-slate-200 bg-white p-4 sm:grid-cols-5">
        <Field label="Delegate email">
          <input className={inputClass} value={form.delegateEmail} onChange={(e) => setForm((f) => ({ ...f, delegateEmail: e.target.value }))} />
        </Field>
        <Field label="Cost centre" hint="Blank = all yours">
          <select className={inputClass} value={form.costCentreId} onChange={(e) => setForm((f) => ({ ...f, costCentreId: e.target.value }))}>
            <option value="">All</option>
            {reference.data?.costCentres.map((cc) => (
              <option key={cc.id} value={cc.id}>
                {cc.code}
              </option>
            ))}
          </select>
        </Field>
        <Field label="From">
          <input className={inputClass} type="datetime-local" value={form.startsAt} onChange={(e) => setForm((f) => ({ ...f, startsAt: e.target.value }))} />
        </Field>
        <Field label="Until">
          <input className={inputClass} type="datetime-local" value={form.endsAt} onChange={(e) => setForm((f) => ({ ...f, endsAt: e.target.value }))} />
        </Field>
        <Field label="Reason">
          <input className={inputClass} value={form.reason} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} />
        </Field>
        <div className="sm:col-span-5">
          <Button kind="primary" disabled={!form.delegateEmail || !form.startsAt || !form.endsAt || form.reason.length < 3} onClick={() => void create()}>
            Create delegation
          </Button>
          <ErrorNote message={error} />
        </div>
      </div>
      {delegations.data && delegations.data.delegations.length > 0 ? (
        <ul className="mt-3 space-y-2">
          {delegations.data.delegations.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-200 bg-white px-3 py-2 text-sm">
              <span>
                <span className="font-medium">{d.delegator_name}</span> → <span className="font-medium">{d.delegate_name}</span>
                <span className="ml-2 text-xs text-slate-500">
                  {d.cost_centre_code ?? "all cost centres"} · {formatDate(d.starts_at)} – {formatDate(d.ends_at)} · {d.reason}
                </span>
              </span>
              {d.revoked_at ? (
                <span className="text-xs text-slate-400">revoked</span>
              ) : me?.id === d.delegator_id ? (
                <Button kind="danger" onClick={() => void revoke(d.id)}>
                  Revoke
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export function ApprovalsPage() {
  const queue = useApiQuery<{ queue: QueueItem[] }>("/api/approvals/queue");
  const [deciding, setDeciding] = useState<string | null>(null);

  return (
    <div>
      <h1 className="text-lg font-semibold text-slate-900">Approvals</h1>
      <p className="mt-1 text-sm text-slate-500">Requisitions waiting on your decision, in DOA sequence.</p>
      <ErrorNote message={queue.error} />
      {queue.data && queue.data.queue.length === 0 ? <EmptyState message="Nothing waiting on you." /> : null}
      {queue.data && queue.data.queue.length > 0 ? (
        <div className="mt-4 overflow-x-auto rounded-md border border-slate-200 bg-white">
          <table className="w-full min-w-[860px] text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs text-slate-500">
              <tr>
                {["Reference", "Requester", "Cost centre", "Category", "Amount", "Submitted", "Kind", ""].map((h) => (
                  <th key={h} className="px-3 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {queue.data.queue.map((q) => (
                <tr key={q.step_id} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="px-3 py-2">
                    <Link className="font-medium text-slate-900 underline-offset-2 hover:underline" to={`/requisitions/${q.requisition_id}`}>
                      {q.reference}
                    </Link>
                    {q.via_delegation ? <span className="ml-2 rounded bg-sky-50 px-1.5 py-0.5 text-[11px] text-sky-700">as delegate</span> : null}
                  </td>
                  <td className="px-3 py-2">{q.requester_name}</td>
                  <td className="px-3 py-2">{q.cost_centre_code}</td>
                  <td className="px-3 py-2">{q.category_code}</td>
                  <td className="px-3 py-2 tabular-nums">
                    <Money amount={q.purpose === "variance_reapproval" && q.invoice_amount ? q.invoice_amount : q.amount} currency={q.currency} />
                  </td>
                  <td className="px-3 py-2 text-slate-500">{formatDate(q.submitted_at)}</td>
                  <td className="px-3 py-2">
                    {q.purpose === "variance_reapproval" ? <StatusBadge status="pending_reapproval" /> : <span className="text-xs text-slate-500">step {q.step_no}</span>}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Button kind="primary" onClick={() => setDeciding(q.step_id)}>
                      Review
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {deciding ? (
        <DecideModal
          stepId={deciding}
          onClose={(decided) => {
            setDeciding(null);
            if (decided) queue.refresh();
          }}
        />
      ) : null}

      <DelegationsSection />
    </div>
  );
}
