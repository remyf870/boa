import { useState } from "react";
import { api, ApiError } from "../api/client";
import type { AppSettingRow, DoaDiffResponse, DoaVersionDetail, DoaVersionRow } from "../api/types";
import { hasRole } from "../api/types";
import { useAuth } from "../components/AuthProvider";
import { uploadFile, useApiQuery } from "../hooks/useApi";
import { Button, EmptyState, ErrorNote, formatDate, Modal, StatusBadge, inputClass } from "../components/ui";

interface AdminUser {
  id: string;
  email: string;
  display_name: string;
  job_title: string | null;
  status: string;
  last_login_at: string | null;
  roles: { assignmentId: string; role: string; costCentreCode: string | null; grantedReason: string }[];
}

/** §6.1 activation review: the second person must see everything they are
 * approving — the full rule set, the line-by-line diff vs the active version,
 * and the routing-hole warnings recorded at upload — before Activate. The old
 * flow was a bare window.confirm over a row showing only a rule COUNT, which
 * reduced the two-person control to a rubber stamp. */
function DoaReviewModal({
  versionId,
  canActivate,
  onClose,
}: {
  versionId: string;
  canActivate: boolean;
  onClose: (changed: boolean) => void;
}) {
  const detail = useApiQuery<DoaVersionDetail>(`/api/doa/versions/${versionId}`);
  const diff = useApiQuery<DoaDiffResponse>(`/api/doa/versions/${versionId}/diff`);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const activate = async () => {
    setBusy(true);
    setError(null);
    setIssues([]);
    try {
      await api(`/api/doa/versions/${versionId}/activate`, { method: "POST" });
      onClose(true);
    } catch (err) {
      if (err instanceof ApiError && err.issues.length > 0) {
        setError(
          "This draft no longer passes validation (users, categories or cost centres changed since upload). It cannot be activated — upload a corrected version instead.",
        );
        setIssues(err.issues);
      } else {
        setError(err instanceof Error ? err.message : "Activation failed");
      }
      setBusy(false);
    }
  };

  if (detail.loading) {
    return (
      <Modal title="DOA version" onClose={() => onClose(false)}>
        <p className="text-sm text-slate-500">Loading…</p>
      </Modal>
    );
  }
  if (!detail.data) {
    return (
      <Modal title="DOA version" onClose={() => onClose(false)}>
        <ErrorNote message={detail.error ?? "Not found"} />
      </Modal>
    );
  }
  const v = detail.data.version;
  const warnings = v.validation_warnings ?? [];
  const describeSequence = (seq: DoaVersionDetail["rules"][number]["approval_sequence"]) =>
    seq.map((a) => `${a.type}:${a.value}`).join(" → ");

  return (
    <Modal title={`DOA matrix — v${v.version_no}`} onClose={() => onClose(false)}>
      <div className="flex items-center gap-2 text-sm">
        <StatusBadge status={v.status} />
        <span className="text-slate-500">
          uploaded by {v.uploaded_by_name} · {formatDate(v.uploaded_at)}
          {v.approved_by_name ? ` · activated by ${v.approved_by_name}` : ""}
        </span>
      </div>

      {warnings.length > 0 ? (
        <div className="mt-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <p className="font-medium">
            Routing gaps recorded at upload — the uploader saw these. Activating means accepting them:
          </p>
          <ul className="mt-1 list-disc pl-5">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="mt-3 text-sm text-slate-500">No routing-gap warnings were recorded at upload.</p>
      )}

      <h3 className="mt-4 text-sm font-semibold text-slate-900">
        {diff.data
          ? diff.data.activeVersionNo === null
            ? "Changes (no active version to compare against — everything is new)"
            : `Changes vs active v${diff.data.activeVersionNo}`
          : "Changes vs the active version"}
      </h3>
      <ErrorNote message={diff.error} />
      {diff.data && diff.data.entries.length === 0 ? (
        <p className="mt-1 text-sm text-slate-500">No routing changes — identical to the active version.</p>
      ) : null}
      {diff.data && diff.data.entries.length > 0 ? (
        <div className="mt-2 max-h-64 overflow-y-auto rounded border border-slate-200">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs text-slate-500">
              <tr>
                {["Category", "Cost centre", "Band", "Change", "Detail"].map((h) => (
                  <th key={h} className="px-3 py-1.5 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="bg-white">
              {diff.data.entries.map((e, i) => (
                <tr key={i} className="border-b border-slate-100 align-top">
                  <td className="px-3 py-1.5">{e.categoryCode}</td>
                  <td className="px-3 py-1.5">{e.costCentreCode ?? "all"}</td>
                  <td className="px-3 py-1.5 whitespace-nowrap">{e.band}</td>
                  <td className="px-3 py-1.5">
                    <StatusBadge status={e.change} />
                  </td>
                  <td className="px-3 py-1.5 text-xs text-slate-600">{e.detail ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <details className="mt-4">
        <summary className="cursor-pointer text-sm font-semibold text-slate-900">
          Full rule set ({detail.data.rules.length} rule{detail.data.rules.length === 1 ? "" : "s"})
        </summary>
        <div className="mt-2 max-h-64 overflow-y-auto rounded border border-slate-200">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs text-slate-500">
              <tr>
                {["Category", "Cost centre", "Band", "Approval sequence", "Quotes", "Notes"].map((h) => (
                  <th key={h} className="px-3 py-1.5 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="bg-white">
              {detail.data.rules.map((r) => (
                <tr key={r.id} className="border-b border-slate-100 align-top">
                  <td className="px-3 py-1.5">{r.category_code}</td>
                  <td className="px-3 py-1.5">{r.cost_centre_code ?? "all"}</td>
                  <td className="px-3 py-1.5 whitespace-nowrap tabular-nums">
                    {Number(r.min_amount)} – {r.max_amount === null ? "no limit" : Number(r.max_amount)}
                  </td>
                  <td className="px-3 py-1.5 text-xs">{describeSequence(r.approval_sequence)}</td>
                  <td className="px-3 py-1.5">{r.requires_quotes}</td>
                  <td className="px-3 py-1.5 text-xs text-slate-500">{r.notes ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      <p className="mt-4 rounded border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
        {v.status === "draft"
          ? canActivate
            ? "Activating supersedes the current active version immediately — every new requisition routes on this matrix. Review the changes and warnings above first (§6.1 two-person rule)."
            : "A doa_approver (not the uploader) must review and activate this draft."
          : v.status === "active"
            ? "This is the active matrix — every new requisition routes on it."
            : "Superseded and kept as a record (A.5.33)."}
      </p>

      <ErrorNote message={error} />
      {issues.length > 0 ? (
        <ul className="mt-2 list-disc rounded border border-red-200 bg-red-50 py-2 pl-8 pr-3 text-sm text-red-800">
          {issues.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      ) : null}
      <div className="mt-4 flex justify-end gap-2">
        {canActivate && v.status === "draft" ? (
          <Button kind="primary" disabled={busy} onClick={() => void activate()}>
            Activate this version
          </Button>
        ) : null}
        <Button onClick={() => onClose(false)}>Close</Button>
      </div>
    </Modal>
  );
}

function DoaSection() {
  const { state } = useAuth();
  const me = state.status === "authenticated" ? state.user : null;
  const versions = useApiQuery<{ versions: DoaVersionRow[] }>("/api/doa/versions");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const canUpload = hasRole(me, "doa_admin");
  const canActivate = hasRole(me, "doa_approver");
  // The review endpoints (version detail + diff) are limited to these roles.
  const canReview = canUpload || canActivate || hasRole(me, "auditor");

  const [warnings, setWarnings] = useState<string[]>([]);
  const [openVersion, setOpenVersion] = useState<string | null>(null);

  const uploadMatrix = async (file: File) => {
    setError(null);
    setNotice(null);
    setWarnings([]);
    try {
      const result = await uploadFile<{ versionNo: number; diff: { entries: unknown[] }; warnings?: string[] }>(
        "/api/doa/upload",
        file,
      );
      setNotice(
        `Draft v${result.versionNo} created (${result.diff.entries.length} change(s) vs the active version). A doa_approver must activate it.`,
      );
      // Routing holes are not blocking during a phased rollout, but the
      // reviewer must see them before approving the version (§6.1).
      setWarnings(result.warnings ?? []);
      versions.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    }
  };

  return (
    <section className="mt-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-slate-900">DOA matrix (§6.1)</h2>
        <div className="flex items-center gap-3">
          <a className="text-sm text-slate-700 underline underline-offset-2" href="/api/doa/template.xlsx">
            Download template / current matrix
          </a>
          {canUpload ? (
            <label className="cursor-pointer rounded bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700">
              Upload new version
              <input
                type="file"
                accept=".xlsx"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void uploadMatrix(f);
                  e.target.value = "";
                }}
              />
            </label>
          ) : null}
        </div>
      </div>
      <p className="mt-1 text-sm text-slate-500">
        Upload (DOA administrator) → validate &amp; diff → a different person holding doa_approver activates. Versions are never deleted.
      </p>
      {notice ? <p className="mt-2 rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">{notice}</p> : null}
      {warnings.length > 0 ? (
        <div className="mt-2 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <p className="font-medium">Routing gaps in this matrix — review before activating:</p>
          <ul className="mt-1 list-disc pl-5">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <ErrorNote message={error ?? versions.error} />
      {versions.data && versions.data.versions.length > 0 ? (
        <table className="mt-3 w-full text-left text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-xs text-slate-500">
            <tr>
              {["Version", "Status", "Rules", "Uploaded by", "Uploaded", "Activated by", ""].map((h) => (
                <th key={h} className="px-3 py-2 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="bg-white">
            {versions.data.versions.map((v) => (
              <tr key={v.id} className="border-b border-slate-100">
                <td className="px-3 py-2 font-medium">v{v.version_no}</td>
                <td className="px-3 py-2">
                  <StatusBadge status={v.status} />
                </td>
                <td className="px-3 py-2">{v.rule_count}</td>
                <td className="px-3 py-2">{v.uploaded_by_name}</td>
                <td className="px-3 py-2 text-slate-500">{formatDate(v.uploaded_at)}</td>
                <td className="px-3 py-2">{v.approved_by_name ?? "—"}</td>
                <td className="px-3 py-2 text-right">
                  {canReview ? (
                    <Button
                      kind={v.status === "draft" && canActivate ? "primary" : "secondary"}
                      onClick={() => setOpenVersion(v.id)}
                    >
                      {v.status === "draft" && canActivate ? "Review & activate" : "Open"}
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <EmptyState message="No DOA versions yet." />
      )}
      {openVersion ? (
        <DoaReviewModal
          versionId={openVersion}
          canActivate={canActivate}
          onClose={(changed) => {
            setOpenVersion(null);
            if (changed) {
              setNotice("Version activated — every new requisition now routes on it.");
              versions.refresh();
            }
          }}
        />
      ) : null}
    </section>
  );
}

function SettingsSection() {
  const { state } = useAuth();
  const me = state.status === "authenticated" ? state.user : null;
  const settings = useApiQuery<{ settings: AppSettingRow[] }>("/api/admin/settings");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const canEdit = hasRole(me, "sysadmin");

  const save = async (key: string) => {
    setError(null);
    const raw = drafts[key];
    if (raw === undefined) return;
    let value: unknown = raw;
    try {
      value = JSON.parse(raw);
    } catch {
      // keep as string (e.g. base_currency)
    }
    try {
      await api(`/api/admin/settings/${key}`, { method: "PUT", body: { value } });
      setDrafts((d) => {
        const next = { ...d };
        delete next[key];
        return next;
      });
      settings.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the setting");
    }
  };

  return (
    <section className="mt-8">
      <h2 className="text-base font-semibold text-slate-900">Settings (§0.3 — data, not code)</h2>
      <ErrorNote message={error ?? settings.error} />
      {settings.data ? (
        <div className="mt-3 space-y-2">
          {settings.data.settings.map((s) => (
            <div key={s.key} className="flex flex-wrap items-center gap-3 rounded border border-slate-200 bg-white px-3 py-2">
              <div className="min-w-[220px]">
                <p className="text-sm font-medium text-slate-900">{s.key}</p>
                <p className="max-w-xl text-xs text-slate-500">{s.description}</p>
              </div>
              <input
                className={`${inputClass} max-w-[160px]`}
                value={drafts[s.key] ?? JSON.stringify(s.value)}
                onChange={(e) => setDrafts((d) => ({ ...d, [s.key]: e.target.value }))}
                disabled={!canEdit}
                aria-label={`Value for ${s.key}`}
              />
              {canEdit && drafts[s.key] !== undefined ? (
                <Button kind="primary" onClick={() => void save(s.key)}>
                  Save
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function UsersSection() {
  const users = useApiQuery<{ users: AdminUser[] }>("/api/admin/users");
  return (
    <section className="mt-8">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-slate-900">Users &amp; roles (A.5.18)</h2>
        <a className="text-sm text-slate-700 underline underline-offset-2" href="/api/admin/access-review.xlsx">
          Access review export (.xlsx)
        </a>
      </div>
      <ErrorNote message={users.error} />
      {users.data ? (
        <table className="mt-3 w-full text-left text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-xs text-slate-500">
            <tr>
              {["User", "Job title", "Status", "Roles", "Last login"].map((h) => (
                <th key={h} className="px-3 py-2 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="bg-white">
            {users.data.users.map((u) => (
              <tr key={u.id} className="border-b border-slate-100">
                <td className="px-3 py-2">
                  <p className="font-medium">{u.display_name}</p>
                  <p className="text-xs text-slate-500">{u.email}</p>
                </td>
                <td className="px-3 py-2">{u.job_title ?? "—"}</td>
                <td className="px-3 py-2">
                  <StatusBadge status={u.status === "active" ? "approved" : "denied"} />
                </td>
                <td className="px-3 py-2 text-xs">
                  {u.roles.map((r) => (
                    <span key={r.assignmentId} className="mr-1 inline-block rounded bg-slate-100 px-1.5 py-0.5">
                      {r.role}
                      {r.costCentreCode ? `@${r.costCentreCode}` : ""}
                    </span>
                  ))}
                </td>
                <td className="px-3 py-2 text-slate-500">{formatDate(u.last_login_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}

export function AdminPage() {
  const { state } = useAuth();
  const me = state.status === "authenticated" ? state.user : null;
  // Sections render only for roles their APIs actually allow — a doa_approver
  // opening Settings/Users saw nothing but "forbidden" alerts (review finding).
  const seesDoa = ["doa_admin", "doa_approver", "auditor", "sysadmin"].some((r) => hasRole(me, r));
  const seesAdministration = hasRole(me, "sysadmin") || hasRole(me, "auditor");

  return (
    <div>
      <h1 className="text-lg font-semibold text-slate-900">Admin</h1>
      <p className="mt-1 text-sm text-slate-500">
        DOA versions, configurable settings, and access administration. The System Admin can never approve or touch financial records (A.5.3/A.8.2).
      </p>
      {seesDoa ? <DoaSection /> : null}
      {seesAdministration ? (
        <>
          <SettingsSection />
          <UsersSection />
        </>
      ) : null}
      {!seesDoa && !seesAdministration ? (
        <EmptyState message="Your roles have no administration surface. DOA versions need doa_admin/doa_approver; settings and users need sysadmin or auditor." />
      ) : null}
    </div>
  );
}
