import { useState } from "react";
import { api } from "../api/client";
import type { AppSettingRow, DoaVersionRow } from "../api/types";
import { hasRole } from "../api/types";
import { useAuth } from "../components/AuthProvider";
import { uploadFile, useApiQuery } from "../hooks/useApi";
import { Button, EmptyState, ErrorNote, formatDate, inputClass, StatusBadge } from "../components/ui";

interface AdminUser {
  id: string;
  email: string;
  display_name: string;
  job_title: string | null;
  status: string;
  last_login_at: string | null;
  roles: { assignmentId: string; role: string; costCentreCode: string | null; grantedReason: string }[];
}

function DoaSection() {
  const { state } = useAuth();
  const me = state.status === "authenticated" ? state.user : null;
  const versions = useApiQuery<{ versions: DoaVersionRow[] }>("/api/doa/versions");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const canUpload = hasRole(me, "doa_admin");
  const canActivate = hasRole(me, "doa_approver");

  const [warnings, setWarnings] = useState<string[]>([]);

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

  const activate = async (id: string) => {
    if (!window.confirm("Activate this DOA version? The current active version will be superseded.")) return;
    setError(null);
    try {
      await api(`/api/doa/versions/${id}/activate`, { method: "POST" });
      versions.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Activation failed");
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
                  {v.status === "draft" && canActivate ? (
                    <Button kind="primary" onClick={() => void activate(v.id)}>
                      Activate
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
  const isAdminish = hasRole(me, "sysadmin") || hasRole(me, "auditor") || hasRole(me, "doa_admin") || hasRole(me, "doa_approver");

  return (
    <div>
      <h1 className="text-lg font-semibold text-slate-900">Admin</h1>
      <p className="mt-1 text-sm text-slate-500">
        DOA versions, configurable settings, and access administration. The System Admin can never approve or touch financial records (A.5.3/A.8.2).
      </p>
      <DoaSection />
      {isAdminish ? (
        <>
          <SettingsSection />
          <UsersSection />
        </>
      ) : null}
    </div>
  );
}
