import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import type { PreviewResponse, ReferenceData, RequisitionRow } from "../api/types";
import { useApiQuery } from "../hooks/useApi";
import { Button, EmptyState, ErrorNote, Field, formatDate, inputClass, Modal, Money, StatusBadge } from "../components/ui";

/** §5.1: requisition form with the live "who will approve this" and budget
 * displays, resolved from the active DOA as the user types. */
function NewRequisitionModal({ reference, onClose }: { reference: ReferenceData; onClose: (created: string | null) => void }) {
  const navigate = useNavigate();
  const [form, setForm] = useState({
    costCentreId: reference.costCentres[0]?.id ?? "",
    categoryId: reference.categories[0]?.id ?? "",
    supplierId: "",
    description: "",
    justification: "",
    amount: "",
    neededBy: "",
  });
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const amountNumber = Number(form.amount);
  const previewKey = useMemo(
    () => (form.costCentreId && form.categoryId && amountNumber > 0 ? `${form.costCentreId}|${form.categoryId}|${amountNumber}` : null),
    [form.costCentreId, form.categoryId, amountNumber],
  );

  useEffect(() => {
    if (!previewKey) {
      setPreview(null);
      return;
    }
    const [costCentreId, categoryId, amount] = previewKey.split("|");
    const timer = setTimeout(() => {
      api<PreviewResponse>("/api/requisitions/preview", {
        method: "POST",
        body: { costCentreId, categoryId, amount: Number(amount), currency: "TTD" },
      })
        .then(setPreview)
        .catch(() => setPreview(null));
    }, 300);
    return () => clearTimeout(timer);
  }, [previewKey]);

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const created = await api<{ requisition: { id: string } }>("/api/requisitions", {
        method: "POST",
        body: {
          costCentreId: form.costCentreId,
          categoryId: form.categoryId,
          supplierId: form.supplierId || null,
          description: form.description,
          justification: form.justification,
          amount: amountNumber,
          currency: "TTD",
          neededBy: form.neededBy || null,
        },
      });
      onClose(created.requisition.id);
      navigate(`/requisitions/${created.requisition.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the requisition");
      setSaving(false);
    }
  };

  const set = (key: keyof typeof form) => (value: string) => setForm((f) => ({ ...f, [key]: value }));

  return (
    <Modal title="New requisition" onClose={() => onClose(null)}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Cost centre">
          <select className={inputClass} value={form.costCentreId} onChange={(e) => set("costCentreId")(e.target.value)}>
            {reference.costCentres.map((cc) => (
              <option key={cc.id} value={cc.id}>
                {cc.code} — {cc.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Category">
          <select className={inputClass} value={form.categoryId} onChange={(e) => set("categoryId")(e.target.value)}>
            {reference.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.code} — {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Supplier" hint="Optional at draft stage">
          <select className={inputClass} value={form.supplierId} onChange={(e) => set("supplierId")(e.target.value)}>
            <option value="">(not selected)</option>
            {reference.suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Amount (TTD)">
          <input className={inputClass} type="number" min="0.01" step="0.01" value={form.amount} onChange={(e) => set("amount")(e.target.value)} />
        </Field>
        <Field label="Needed by" hint="Optional">
          <input className={inputClass} type="date" value={form.neededBy} onChange={(e) => set("neededBy")(e.target.value)} />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Description">
            <input className={inputClass} value={form.description} onChange={(e) => set("description")(e.target.value)} placeholder="What is being purchased" />
          </Field>
        </div>
        <div className="sm:col-span-2">
          <Field label="Justification">
            <textarea className={inputClass} rows={2} value={form.justification} onChange={(e) => set("justification")(e.target.value)} placeholder="Why it is needed" />
          </Field>
        </div>
      </div>

      {preview ? (
        <div className="mt-4 rounded border border-slate-200 bg-slate-50 p-3 text-sm">
          {preview.route ? (
            <p className="text-slate-700">
              <span className="font-medium">This requires approval from:</span>{" "}
              {preview.route.map((r) => `${r.label} (${r.approverName})`).join(" → ")}
              {preview.requiresQuotes ? (
                <span className="ml-2 text-amber-700">· {preview.requiresQuotes} quote(s) required before submission</span>
              ) : null}
            </p>
          ) : (
            <p className="text-red-700">{preview.routeError?.message ?? "No DOA route found for this combination"}</p>
          )}
          <p className="mt-1 text-slate-700">
            <span className="font-medium">Available budget ({preview.budget.period}):</span> <Money amount={preview.budget.available} currency="TTD" />
            {" · "}
            <span className="font-medium">After this request:</span> <Money amount={preview.budget.afterThisRequest} currency="TTD" />
          </p>
        </div>
      ) : null}

      <ErrorNote message={error} />
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={() => onClose(null)}>Cancel</Button>
        <Button kind="primary" disabled={saving || !form.description || !form.justification || !(amountNumber > 0)} onClick={() => void submit()}>
          Save draft
        </Button>
      </div>
    </Modal>
  );
}

export function RequisitionsPage() {
  const [status, setStatus] = useState("");
  const [showNew, setShowNew] = useState(false);
  const reference = useApiQuery<ReferenceData>("/api/reference");
  const list = useApiQuery<{ requisitions: RequisitionRow[] }>(
    `/api/requisitions?limit=100${status ? `&status=${status}` : ""}`,
  );

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">Requisitions</h1>
          <p className="mt-1 text-sm text-slate-500">Your requests and those you can see for your cost centres.</p>
        </div>
        <div className="flex items-center gap-2">
          <select className={inputClass} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
            <option value="">All statuses</option>
            {["draft", "submitted", "approved", "denied", "closed", "cancelled"].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <Button kind="primary" onClick={() => setShowNew(true)} disabled={!reference.data}>
            New requisition
          </Button>
        </div>
      </div>

      <ErrorNote message={list.error} />
      {list.data && list.data.requisitions.length === 0 ? <EmptyState message="No requisitions yet." /> : null}
      {list.data && list.data.requisitions.length > 0 ? (
        <div className="mt-4 overflow-x-auto rounded-md border border-slate-200 bg-white">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs text-slate-500">
              <tr>
                {["Reference", "Created", "Requester", "Cost centre", "Category", "Supplier", "Amount", "Status"].map((h) => (
                  <th key={h} className="px-3 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {list.data.requisitions.map((r) => (
                <tr key={r.id} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="px-3 py-2">
                    <Link className="font-medium text-slate-900 underline-offset-2 hover:underline" to={`/requisitions/${r.id}`}>
                      {r.reference}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-slate-500">{formatDate(r.created_at)}</td>
                  <td className="px-3 py-2">{r.requester_name}</td>
                  <td className="px-3 py-2">{r.cost_centre_code}</td>
                  <td className="px-3 py-2">{r.category_code}</td>
                  <td className="px-3 py-2">{r.supplier_name ?? "—"}</td>
                  <td className="px-3 py-2 tabular-nums">
                    <Money amount={r.amount} currency={r.currency} />
                  </td>
                  <td className="px-3 py-2">
                    <StatusBadge status={r.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {showNew && reference.data ? (
        <NewRequisitionModal
          reference={reference.data}
          onClose={(created) => {
            setShowNew(false);
            if (created) list.refresh();
          }}
        />
      ) : null}
    </div>
  );
}
