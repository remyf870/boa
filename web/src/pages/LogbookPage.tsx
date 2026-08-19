import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type { LogbookEntry, ReferenceData } from "../api/types";
import { useApiQuery } from "../hooks/useApi";
import { Button, EmptyState, ErrorNote, formatDate, inputClass, Money, StatusBadge } from "../components/ui";

interface SavedFilter {
  id: string;
  view: string;
  name: string;
  filter: Record<string, string>;
}

const EMPTY = { status: "", costCentreId: "", categoryId: "", from: "", to: "", search: "" };

/** §5.6: the logbook — one filterable, exportable table of every requisition
 * ever raised (scoped to what the signed-in role may see). */
export function LogbookPage() {
  const reference = useApiQuery<ReferenceData>("/api/reference");
  const [filter, setFilter] = useState({ ...EMPTY });
  const saved = useApiQuery<{ filters: SavedFilter[] }>("/api/saved-filters");
  const [error, setError] = useState<string | null>(null);

  const queryString = useMemo(() => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(filter)) if (v) params.set(k, v);
    params.set("limit", "500");
    return params.toString();
  }, [filter]);

  const entries = useApiQuery<{ entries: LogbookEntry[] }>(`/api/logbook?${queryString}`);

  const saveCurrent = async () => {
    const name = window.prompt("Name this filter:");
    if (!name) return;
    setError(null);
    try {
      await api("/api/saved-filters", { method: "POST", body: { view: "logbook", name, filter } });
      saved.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the filter");
    }
  };

  const set = (key: keyof typeof EMPTY) => (value: string) => setFilter((f) => ({ ...f, [key]: value }));

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">Logbook</h1>
          <p className="mt-1 text-sm text-slate-500">Every requisition ever raised, with its full approval trail.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => void saveCurrent()}>Save filter</Button>
          <a
            className="rounded bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700"
            href={`/api/logbook/export.xlsx?${queryString}`}
          >
            Export to Excel
          </a>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 rounded-md border border-slate-200 bg-white p-3 sm:grid-cols-3 lg:grid-cols-6">
        <select className={inputClass} value={filter.status} onChange={(e) => set("status")(e.target.value)} aria-label="Status">
          <option value="">All statuses</option>
          {["draft", "submitted", "approved", "denied", "closed", "cancelled"].map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select className={inputClass} value={filter.costCentreId} onChange={(e) => set("costCentreId")(e.target.value)} aria-label="Department">
          <option value="">All departments</option>
          {reference.data?.costCentres.map((cc) => (
            <option key={cc.id} value={cc.id}>
              {cc.code}
            </option>
          ))}
        </select>
        <select className={inputClass} value={filter.categoryId} onChange={(e) => set("categoryId")(e.target.value)} aria-label="Category">
          <option value="">All categories</option>
          {reference.data?.categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.code}
            </option>
          ))}
        </select>
        <input className={inputClass} type="date" value={filter.from} onChange={(e) => set("from")(e.target.value)} aria-label="From date" />
        <input className={inputClass} type="date" value={filter.to} onChange={(e) => set("to")(e.target.value)} aria-label="To date" />
        <input className={inputClass} placeholder="Search reference/description" value={filter.search} onChange={(e) => set("search")(e.target.value)} />
        {saved.data && saved.data.filters.length > 0 ? (
          <div className="col-span-full flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-slate-400">Saved:</span>
            {saved.data.filters.map((f) => (
              <span key={f.id} className="flex max-w-full items-center overflow-hidden rounded border border-slate-200">
                <button type="button" className="min-w-0 truncate bg-slate-50 px-2 py-1 hover:bg-slate-100" onClick={() => setFilter({ ...EMPTY, ...f.filter })}>
                  {f.name}
                </button>
                <button
                  type="button"
                  aria-label={`Delete saved filter ${f.name}`}
                  className="border-l border-slate-200 bg-white px-1.5 py-1 text-slate-400 hover:text-red-600"
                  onClick={() => {
                    void api(`/api/saved-filters/${f.id}`, { method: "DELETE" }).then(() => saved.refresh());
                  }}
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        ) : null}
      </div>

      <ErrorNote message={error ?? entries.error} />
      {entries.data && entries.data.entries.length === 0 ? <EmptyState message="No requisitions match this filter." /> : null}
      {entries.data && entries.data.entries.length > 0 ? (
        <div className="mt-3 overflow-x-auto rounded-md border border-slate-200 bg-white">
          <table className="w-full min-w-[1100px] text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs text-slate-500">
              <tr>
                {["Reference", "Date", "Requester", "Department", "Category", "Supplier", "Amount", "Status", "Approvals", "Invoice", "CDK"].map((h) => (
                  <th key={h} className="px-3 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {entries.data.entries.map((r) => (
                <tr key={r.id} className="border-b border-slate-100 align-top hover:bg-slate-50">
                  <td className="px-3 py-2">
                    <Link className="font-medium text-slate-900 underline-offset-2 hover:underline" to={`/requisitions/${r.id}`}>
                      {r.reference}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-slate-500">{formatDate(r.created_at)}</td>
                  <td className="px-3 py-2">{r.requester_name}</td>
                  <td className="px-3 py-2">{r.department ?? r.cost_centre_code}</td>
                  <td className="px-3 py-2">{r.category_code}</td>
                  <td className="px-3 py-2">{r.supplier_name ?? "—"}</td>
                  <td className="px-3 py-2 tabular-nums">
                    <Money amount={r.amount} currency={r.currency} />
                  </td>
                  <td className="px-3 py-2">
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-600">
                    {r.approval_trail?.map((s) => (
                      <p key={s.stepNo}>
                        {s.stepNo}. {s.approverName ?? "—"}
                        {s.delegateOf ? ` (for ${s.delegateOf})` : ""}: {s.decision}
                        {s.decidedAt ? ` ${new Date(s.decidedAt).toLocaleDateString()}` : ""}
                      </p>
                    )) ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-600">
                    {r.invoices?.map((i) => (
                      <p key={i.invoiceNo}>
                        {i.invoiceNo}: {i.status}
                      </p>
                    )) ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-600">{r.invoices?.map((i) => i.cdkReference).filter(Boolean).join(", ") || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
