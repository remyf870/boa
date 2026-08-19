import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, ApiError } from "../api/client";
import type { BudgetPosition, BudgetVersionDetail, BudgetVersionRow, ReferenceData } from "../api/types";
import { hasRole } from "../api/types";
import { useAuth } from "../components/AuthProvider";
import { uploadFile, useApiQuery } from "../hooks/useApi";
import { Button, EmptyState, ErrorNote, Field, formatDate, inputClass, Modal, Money, StatusBadge } from "../components/ui";

/** §5.9 live tracker: the position streams over SSE and updates the moment a
 * purchase is approved, an invoice posts, or a budget version activates. */
function LivePosition({ costCentreId }: { costCentreId: string }) {
  const [position, setPosition] = useState<BudgetPosition | null>(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    setPosition(null);
    const source = new EventSource(`/api/budgets/stream?costCentreId=${costCentreId}`);
    source.addEventListener("position", (event) => {
      setPosition(JSON.parse((event as MessageEvent).data) as BudgetPosition);
      setLive(true);
    });
    source.onerror = () => setLive(false);
    return () => source.close();
  }, [costCentreId]);

  if (!position) return <p className="mt-3 text-sm text-slate-500">Loading live position…</p>;

  return (
    <div className="mt-3 rounded-md border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-2">
        <p className="text-sm font-medium text-slate-900">
          Period {position.period}
          {position.budgetVersionId === null ? <span className="ml-2 text-amber-700">— no approved budget for this period yet</span> : null}
        </p>
        <span className={`flex items-center gap-1.5 text-xs ${live ? "text-emerald-700" : "text-slate-400"}`}>
          <span className={`inline-block h-2 w-2 rounded-full ${live ? "bg-emerald-500" : "bg-slate-300"}`} aria-hidden="true" />
          {live ? "live" : "reconnecting…"}
        </span>
      </div>
      {/* Five money columns never fit a phone — the table scrolls, the page does not. */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-left text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-xs text-slate-500">
            <tr>
              {["Category", "Budget", "Committed", "Actual", "Available"].map((h) => (
                <th key={h} className="px-4 py-2 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {position.categories.map((c) => (
              <tr key={c.categoryId} className="border-b border-slate-100">
                <td className="px-4 py-2">
                  {c.categoryCode} <span className="text-xs text-slate-400">{c.categoryName}</span>
                </td>
                <td className="px-4 py-2 tabular-nums">
                  <Money amount={c.budget} />
                </td>
                <td className="px-4 py-2 tabular-nums">
                  <Money amount={c.committed} />
                </td>
                <td className="px-4 py-2 tabular-nums">
                  <Money amount={c.actual} />
                </td>
                <td className="px-4 py-2 font-medium tabular-nums">
                  <Money amount={c.available} />
                </td>
              </tr>
            ))}
            <tr className="bg-slate-50 font-semibold">
              <td className="px-4 py-2">Total</td>
              <td className="px-4 py-2 tabular-nums">
                <Money amount={position.totals.budget} />
              </td>
              <td className="px-4 py-2 tabular-nums">
                <Money amount={position.totals.committed} />
              </td>
              <td className="px-4 py-2 tabular-nums">
                <Money amount={position.totals.actual} />
              </td>
              <td className="px-4 py-2 tabular-nums">
                <Money amount={position.totals.available} />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="border-t border-slate-100 px-4 py-2 text-[11px] text-slate-400">
        Available = Budget − Committed − Actual. Committed the moment a purchase is finally approved; moved to Actual when its invoice posts.
      </p>
    </div>
  );
}

function ProposeModal({
  costCentreId,
  period,
  reference,
  position,
  onClose,
}: {
  costCentreId: string;
  period: string;
  reference: ReferenceData;
  position: BudgetPosition | null;
  onClose: (created: boolean) => void;
}) {
  const [reason, setReason] = useState("");
  // Prefilled with the ACTIVE budget so the owner edits from the real
  // baseline. Starting blank silently dropped every untouched category to
  // zero the moment the proposal was approved (review finding — the Excel
  // template always prefilled; the in-app form now matches).
  const activeByCategory = new Map(
    (position?.categories ?? []).filter((c) => Number(c.budget) > 0).map((c) => [c.categoryId, c.budget]),
  );
  const [lines, setLines] = useState<Record<string, string>>(() =>
    Object.fromEntries([...activeByCategory.entries()].map(([id, amount]) => [id, String(Number(amount))])),
  );
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDrop, setConfirmDrop] = useState<string[] | null>(null);

  /** Categories with an active budget that this proposal would zero out. */
  const droppedCategories = () =>
    reference.categories
      .filter((c) => activeByCategory.has(c.id) && !((lines[c.id] ?? "") !== "" && Number(lines[c.id]) >= 0))
      .map((c) => c.code);

  /** `sendForApproval` is the default action: creating a draft nobody is told
   * to submit was a dead-end — the proposal simply sat there while the
   * approver saw a version with no available action. */
  const submit = async (sendForApproval: boolean) => {
    // A category with budget left blank goes to ZERO on approval — make that
    // an explicit, confirmed act rather than a silent side effect.
    if (!file) {
      const dropped = droppedCategories();
      if (dropped.length > 0 && confirmDrop === null) {
        setConfirmDrop(dropped);
        return;
      }
    }
    setBusy(true);
    setError(null);
    try {
      let versionId: string;
      if (file) {
        const created = await uploadFile<{ versionId: string }>("/api/budgets/upload", file, {
          costCentreId,
          period,
          reason,
        });
        versionId = created.versionId;
      } else {
        const lineItems = Object.entries(lines)
          .filter(([, v]) => v !== "" && Number(v) >= 0)
          .map(([categoryId, amount]) => ({ categoryId, amount: Number(amount) }));
        if (lineItems.length === 0) throw new Error("Enter at least one category amount, or attach the Excel template.");
        const created = await api<{ versionId: string }>("/api/budgets/versions", {
          method: "POST",
          body: { costCentreId, period, reason, lines: lineItems },
        });
        versionId = created.versionId;
      }
      if (sendForApproval) {
        await api(`/api/budgets/versions/${versionId}/submit`, { method: "POST" });
      }
      onClose(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the proposal");
      setBusy(false);
    }
  };

  return (
    <Modal title={`Propose budget — ${period}`} onClose={() => onClose(false)}>
      <p className="text-sm text-slate-500">
        The proposal becomes a draft version. After you submit it, a Budget Approver must approve it before it takes effect (§5.9). Nothing changes until then.
        Amounts are prefilled from the current active budget — what you leave untouched stays as it is proposed below.
      </p>
      <div className="mt-3">
        <Field label="Reason for this budget / change (mandatory)">
          <textarea className={inputClass} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
        {reference.categories.map((c) => (
          <Field
            key={c.id}
            label={`${c.code} — ${c.name}`}
            hint={activeByCategory.has(c.id) ? `current: ${Number(activeByCategory.get(c.id)).toLocaleString()}` : "no budget in the active version"}
          >
            <input
              className={inputClass}
              type="number"
              min="0"
              step="0.01"
              value={lines[c.id] ?? ""}
              onChange={(e) => {
                setConfirmDrop(null);
                setLines((l) => ({ ...l, [c.id]: e.target.value }));
              }}
              disabled={!!file}
            />
          </Field>
        ))}
      </div>
      {confirmDrop !== null ? (
        <p className="mt-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          This proposal leaves {confirmDrop.join(", ")} blank — on approval {confirmDrop.length > 1 ? "their budgets go" : "its budget goes"} to zero while any
          committed or actual spend remains. Click the same button again to proceed, or fill the amount{confirmDrop.length > 1 ? "s" : ""} in.
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <a className="text-sm text-slate-700 underline underline-offset-2" href={`/api/budgets/template.xlsx?costCentreId=${costCentreId}&period=${period}`}>
          Download Excel template
        </a>
        <span className="text-xs text-slate-400">or upload a completed one:</span>
        <input type="file" accept=".xlsx" className="text-sm" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </div>
      <ErrorNote message={error} />
      <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
        <Button onClick={() => onClose(false)}>Cancel</Button>
        <Button disabled={busy || reason.trim().length < 3} onClick={() => void submit(false)}>
          Save as draft
        </Button>
        <Button kind="primary" disabled={busy || reason.trim().length < 3} onClick={() => void submit(true)}>
          Submit for approval
        </Button>
      </div>
      <p className="mt-2 text-right text-xs text-slate-400">
        A draft stays with you until you submit it — only a submitted proposal reaches a Budget Approver.
      </p>
    </Modal>
  );
}

function VersionDetailModal({ versionId, onClose }: { versionId: string; onClose: (changed: boolean) => void }) {
  const { state } = useAuth();
  const me = state.status === "authenticated" ? state.user : null;
  const detail = useApiQuery<BudgetVersionDetail>(`/api/budgets/versions/${versionId}`);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const act = (path: string, body?: unknown) => async () => {
    setError(null);
    try {
      await api(path, { method: "POST", body });
      onClose(true);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 409
          ? "Another approver decided this proposal first — the view below has been refreshed."
          : err instanceof Error
            ? err.message
            : "Action failed",
      );
      // A 409 means the version moved under us: re-fetch so the buttons match
      // its real state instead of offering a decision that no longer exists.
      detail.refresh();
    }
  };

  if (detail.loading) {
    return (
      <Modal title="Budget version" onClose={() => onClose(false)}>
        <p className="text-sm text-slate-500">Loading…</p>
      </Modal>
    );
  }
  if (!detail.data) {
    return (
      <Modal title="Budget version" onClose={() => onClose(false)}>
        <ErrorNote message={detail.error ?? "Not found"} />
      </Modal>
    );
  }
  const v = detail.data.version;
  const isProposer = me?.id === v.proposed_by;
  const isApprover = hasRole(me, "budget_approver");

  return (
    <Modal title={`${v.cost_centre_code} ${v.period} — v${v.version_no}`} onClose={() => onClose(false)}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <StatusBadge status={v.status} />
        <span className="text-slate-500">
          proposed by {v.proposed_by_name} · {formatDate(v.created_at)}
        </span>
      </div>
      <p className="mt-2 text-sm text-slate-700">Reason: {v.reason}</p>
      {v.rejection_reason ? <p className="mt-1 text-sm text-red-700">Rejected: {v.rejection_reason}</p> : null}

      <h3 className="mt-4 text-sm font-semibold text-slate-900">Line-by-line change vs the active budget</h3>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full min-w-[480px] text-left text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-xs text-slate-500">
            <tr>
              <th className="px-3 py-1.5 font-medium">Category</th>
              <th className="px-3 py-1.5 font-medium">Current</th>
              <th className="px-3 py-1.5 font-medium">Proposed</th>
              <th className="px-3 py-1.5 font-medium">Change</th>
            </tr>
          </thead>
          <tbody>
            {detail.data.diff.map((d) => (
              <tr key={d.categoryCode} className="border-b border-slate-100">
                <td className="px-3 py-1.5">{d.categoryCode}</td>
                <td className="px-3 py-1.5 tabular-nums">{d.before === null ? "—" : <Money amount={d.before} />}</td>
                <td className="px-3 py-1.5 tabular-nums">{d.after === null ? "—" : <Money amount={d.after} />}</td>
                <td className="px-3 py-1.5 text-xs">{d.change}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Every state says what it is waiting for and who owns the next move,
          so nobody opens a version and finds an unexplained dead-end. */}
      <p className="mt-4 rounded border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
        {v.status === "draft"
          ? isProposer
            ? "This proposal is still a draft. It has not reached a Budget Approver — submit it below."
            : `Still a draft with ${v.proposed_by_name}. It has not been submitted for approval yet, so there is nothing to approve.`
          : v.status === "pending_approval"
            ? isProposer
              ? "Submitted and awaiting a Budget Approver. You cannot approve your own proposal (two-person rule)."
              : isApprover
                ? "Awaiting your decision."
                : "Awaiting a Budget Approver's decision."
            : v.status === "active"
              ? "Approved and active — this is the budget the live position is measured against."
              : v.status === "rejected"
                ? "Rejected. Propose a new version to try again; this one is kept as a record."
                : "Superseded by a later approved version, and kept as a record."}
      </p>

      <ErrorNote message={error} />
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        {isProposer && v.status === "draft" ? (
          <Button kind="primary" onClick={() => void act(`/api/budgets/versions/${v.id}/submit`)()}>
            Submit for approval
          </Button>
        ) : null}
        {isApprover && v.status === "pending_approval" && !isProposer ? (
          <>
            <div className="w-full">
              <Field label="Rejection reason (only needed when rejecting)">
                <input className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} />
              </Field>
            </div>
            <Button kind="danger" onClick={() => void act(`/api/budgets/versions/${v.id}/reject`, { reason })()}>
              Reject
            </Button>
            <Button kind="primary" onClick={() => void act(`/api/budgets/versions/${v.id}/approve`)()}>
              Approve &amp; activate
            </Button>
          </>
        ) : null}
        <Button onClick={() => onClose(false)}>Close</Button>
      </div>
    </Modal>
  );
}

export function BudgetsPage() {
  const { state } = useAuth();
  const me = state.status === "authenticated" ? state.user : null;
  const reference = useApiQuery<ReferenceData>("/api/reference");
  const [costCentreId, setCostCentreId] = useState<string>("");
  const [showPropose, setShowPropose] = useState(false);
  // Notification deep links are /budgets/versions/:id — open that version
  // directly instead of dropping the recipient on the page with no context.
  const { id: linkedVersionId } = useParams<{ id: string }>();
  const [openVersion, setOpenVersion] = useState<string | null>(linkedVersionId ?? null);

  // Only cost centres the signed-in roles can see budgets for (mirrors the
  // server-side scope; the server remains authoritative).
  const orgWide = ["accounting", "auditor", "budget_approver"].some((r) => hasRole(me, r));
  const visibleCostCentres = (reference.data?.costCentres ?? []).filter(
    (cc) =>
      orgWide ||
      ["requester", "approver", "budget_owner"].some((role) => hasRole(me, role, cc.id)),
  );
  const selected = costCentreId || visibleCostCentres[0]?.id || "";
  const versions = useApiQuery<{ versions: BudgetVersionRow[] }>(selected ? `/api/budgets/versions?costCentreId=${selected}` : null);
  const position = useApiQuery<BudgetPosition>(selected ? `/api/budget-position?costCentreId=${selected}` : null);
  const period = position.data?.period ?? "";

  const navigate = useNavigate();
  const canPropose = me !== null && selected !== "" && hasRole(me, "budget_owner", selected);
  const isBudgetApprover = hasRole(me, "budget_approver");
  // Org-wide: everything waiting on this approver, across ALL cost centres —
  // the whole point is that they should not have to hunt for it.
  const awaiting = useApiQuery<{ versions: BudgetVersionRow[] }>(
    isBudgetApprover ? "/api/budgets/versions?status=pending_approval" : null,
  );
  const awaitingMine = (awaiting.data?.versions ?? []).filter((v) => v.proposed_by_name !== me?.displayName);
  // A proposer's own drafts are equally easy to forget about.
  const myDrafts = (versions.data?.versions ?? []).filter(
    (v) => v.status === "draft" && v.proposed_by_name === me?.displayName,
  );

  const refreshAll = () => {
    versions.refresh();
    position.refresh();
    awaiting.refresh();
  };

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">Budgets</h1>
          <p className="mt-1 text-sm text-slate-500">
            Live position per department. Budgets change only through approved versions (§5.9) — never by direct edit.
          </p>
        </div>
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
          <select className={inputClass} value={selected} onChange={(e) => setCostCentreId(e.target.value)} aria-label="Department">
            {visibleCostCentres.map((cc) => (
              <option key={cc.id} value={cc.id}>
                {cc.code} — {cc.name}
              </option>
            ))}
          </select>
          {canPropose && period ? (
            <Button kind="primary" onClick={() => setShowPropose(true)}>
              Propose budget change
            </Button>
          ) : null}
        </div>
      </div>

      {awaitingMine.length > 0 ? (
        <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3">
          <p className="text-sm font-medium text-amber-900">
            {awaitingMine.length} budget proposal{awaitingMine.length > 1 ? "s" : ""} awaiting your approval
          </p>
          <ul className="mt-2 space-y-1">
            {awaitingMine.map((v) => (
              <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 text-sm text-amber-900">
                <span>
                  <span className="font-medium">
                    {v.cost_centre_code} {v.period} v{v.version_no}
                  </span>{" "}
                  · <Money amount={v.total_amount} /> · proposed by {v.proposed_by_name} — {v.reason}
                </span>
                <Button kind="primary" onClick={() => setOpenVersion(v.id)}>
                  Review
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {myDrafts.length > 0 ? (
        <div className="mt-4 rounded-md border border-sky-200 bg-sky-50 p-3">
          <p className="text-sm font-medium text-sky-900">
            You have {myDrafts.length} unsubmitted draft{myDrafts.length > 1 ? "s" : ""} — a draft never reaches an
            approver until you submit it.
          </p>
          <ul className="mt-2 space-y-1">
            {myDrafts.map((v) => (
              <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 text-sm text-sky-900">
                <span>
                  <span className="font-medium">
                    {v.period} v{v.version_no}
                  </span>{" "}
                  · <Money amount={v.total_amount} /> — {v.reason}
                </span>
                <Button kind="primary" onClick={() => setOpenVersion(v.id)}>
                  Submit for approval
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {selected ? (
        <LivePosition key={selected} costCentreId={selected} />
      ) : (
        <EmptyState message="Your roles have no budget visibility for any department." />
      )}

      <h2 className="mt-6 text-base font-semibold text-slate-900">Versions</h2>
      <ErrorNote message={versions.error} />
      {versions.data && versions.data.versions.length === 0 ? <EmptyState message="No budget versions for this department yet." /> : null}
      {versions.data && versions.data.versions.length > 0 ? (
        <div className="mt-2 overflow-x-auto rounded-md border border-slate-200 bg-white">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs text-slate-500">
              <tr>
                {["Period", "Version", "Status", "Total", "Proposed by", "Reason", "Approved by", ""].map((h) => (
                  <th key={h} className="px-3 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {versions.data.versions.map((v) => (
                <tr key={v.id} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="px-3 py-2">{v.period}</td>
                  <td className="px-3 py-2">v{v.version_no}</td>
                  <td className="px-3 py-2">
                    <StatusBadge status={v.status} />
                  </td>
                  <td className="px-3 py-2 tabular-nums">
                    <Money amount={v.total_amount} />
                  </td>
                  <td className="px-3 py-2">{v.proposed_by_name}</td>
                  <td className="max-w-[240px] truncate px-3 py-2 text-slate-500">{v.reason}</td>
                  <td className="px-3 py-2">{v.approved_by_name ?? v.rejected_by_name ?? "—"}</td>
                  <td className="px-3 py-2 text-right">
                    {/* The label names the action the viewer can actually take
                        in this state, so no row is an unexplained "Open". */}
                    <Button
                      kind={
                        (v.status === "draft" && v.proposed_by_name === me?.displayName) ||
                        (v.status === "pending_approval" && isBudgetApprover && v.proposed_by_name !== me?.displayName)
                          ? "primary"
                          : "secondary"
                      }
                      onClick={() => setOpenVersion(v.id)}
                    >
                      {v.status === "draft" && v.proposed_by_name === me?.displayName
                        ? "Submit"
                        : v.status === "pending_approval" && isBudgetApprover && v.proposed_by_name !== me?.displayName
                          ? "Review"
                          : "Open"}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {showPropose && reference.data && period ? (
        <ProposeModal
          costCentreId={selected}
          period={period}
          reference={reference.data}
          position={position.data}
          onClose={(created) => {
            setShowPropose(false);
            if (created) refreshAll();
          }}
        />
      ) : null}
      {openVersion ? (
        <VersionDetailModal
          versionId={openVersion}
          onClose={(changed) => {
            setOpenVersion(null);
            // Deep-linked opens land on /budgets/versions/:id; returning to
            // /budgets keeps the URL honest once the modal is dismissed.
            if (linkedVersionId) navigate("/budgets", { replace: true });
            if (changed) refreshAll();
          }}
        />
      ) : null}
    </div>
  );
}
