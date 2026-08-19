import { useState } from "react";
import { api, ApiError } from "../api/client";
import type {
  AdminUser,
  AppSettingRow,
  DoaDiffResponse,
  DoaVersionDetail,
  DoaVersionRow,
  ReferenceData,
  SupplierRow,
} from "../api/types";
import { hasRole, roleLabel } from "../api/types";
import { useAuth } from "../components/AuthProvider";
import { uploadFile, useApiQuery } from "../hooks/useApi";
import { Button, EmptyState, ErrorNote, Field, formatDate, Modal, StatusBadge, inputClass } from "../components/ui";

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
      <div className="flex flex-wrap items-center gap-2 text-sm">
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
        <div className="mt-2 max-h-64 overflow-x-auto overflow-y-auto rounded border border-slate-200">
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs text-slate-500">
              <tr>
                {["Category", "Department", "Band", "Change", "Detail"].map((h) => (
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
        <div className="mt-2 max-h-64 overflow-x-auto overflow-y-auto rounded border border-slate-200">
          <table className="w-full min-w-[600px] text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs text-slate-500">
              <tr>
                {["Category", "Department", "Band", "Approval sequence", "Quotes", "Notes"].map((h) => (
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
        <div className="flex flex-wrap items-center gap-3">
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
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
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
        </div>
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
              <div className="min-w-0 sm:min-w-[220px]">
                <p className="text-sm font-medium text-slate-900 break-words">{s.key}</p>
                <p className="max-w-xl text-xs text-slate-500">{s.description}</p>
              </div>
              <input
                className={`${inputClass} max-w-full sm:max-w-[160px]`}
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

const GRANTABLE_ROLES = [
  "requester",
  "approver",
  "budget_owner",
  "accounting",
  "budget_approver",
  "supplier_approver",
  "doa_admin",
  "doa_approver",
  "auditor",
  "sysadmin",
] as const;
const SCOPED_ROLES = ["requester", "approver", "budget_owner"];

function rolePill(r: AdminUser["roles"][number]): string {
  return `${roleLabel({ role: r.role, costCentreId: r.costCentreId, tier: r.tier })}${
    r.costCentreCode ? ` @${r.costCentreCode}` : ""
  }`;
}

/** Add a user before their first sign-in (client change list, "System Admin
 * UI"). The row is claimed by email on their first real login; roles are
 * granted right after creation via the Manage modal that opens automatically. */
function AddUserModal({
  reference,
  onClose,
}: {
  reference: ReferenceData;
  onClose: (createdUserId: string | null) => void;
}) {
  const [form, setForm] = useState({ email: "", displayName: "", jobTitle: "", homeCostCentreId: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (key: keyof typeof form) => (value: string) => setForm((f) => ({ ...f, [key]: value }));

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await api<{ id: string }>("/api/admin/users", {
        method: "POST",
        body: {
          email: form.email,
          displayName: form.displayName,
          jobTitle: form.jobTitle || null,
          homeCostCentreId: form.homeCostCentreId || null,
        },
      });
      onClose(created.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the user");
      setBusy(false);
    }
  };

  return (
    <Modal title="Add user" onClose={() => onClose(null)}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Email" hint="They sign in with this address — the account links up on first login">
          <input className={inputClass} type="email" value={form.email} onChange={(e) => set("email")(e.target.value)} />
        </Field>
        <Field label="Full name">
          <input className={inputClass} value={form.displayName} onChange={(e) => set("displayName")(e.target.value)} />
        </Field>
        <Field label="Job title" hint="Optional">
          <input className={inputClass} value={form.jobTitle} onChange={(e) => set("jobTitle")(e.target.value)} />
        </Field>
        <Field label="Department" hint="Shown under their name; roles carry the real authority">
          <select className={inputClass} value={form.homeCostCentreId} onChange={(e) => set("homeCostCentreId")(e.target.value)}>
            <option value="">(none)</option>
            {reference.costCentres.map((cc) => (
              <option key={cc.id} value={cc.id}>
                {cc.department} — {cc.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <p className="mt-3 text-xs text-slate-500">
        New users start with no roles (default-deny). The role editor opens next so you can assign them.
      </p>
      <ErrorNote message={error} />
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={() => onClose(null)}>Cancel</Button>
        <Button kind="primary" disabled={busy || !form.email || !form.displayName} onClick={() => void submit()}>
          Create user
        </Button>
      </div>
    </Modal>
  );
}

/** Everything the sysadmin does to one user: status, department, grant and
 * revoke roles (each with the mandatory A.5.18 reason). */
function ManageUserModal({
  user,
  reference,
  canEdit,
  onClose,
}: {
  user: AdminUser;
  reference: ReferenceData;
  canEdit: boolean;
  onClose: (changed: boolean) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  const [roles, setRoles] = useState(user.roles);
  const [dept, setDept] = useState(user.home_cost_centre_id ?? "");
  const [status, setStatus] = useState(user.status);
  const [grant, setGrant] = useState({ role: "requester", costCentreId: "", tier: "5", reason: "" });
  const [busy, setBusy] = useState(false);

  const refreshRoles = async () => {
    const data = await api<{ users: AdminUser[] }>("/api/admin/users");
    const fresh = data.users.find((u) => u.id === user.id);
    if (fresh) setRoles(fresh.roles);
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      setChanged(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The change failed");
    }
    setBusy(false);
  };

  const grantRole = () =>
    run(async () => {
      await api(`/api/admin/users/${user.id}/roles`, {
        method: "POST",
        body: {
          role: grant.role,
          costCentreId: SCOPED_ROLES.includes(grant.role) ? grant.costCentreId || null : null,
          tier: grant.role === "approver" ? Number(grant.tier) : null,
          reason: grant.reason,
        },
      });
      setGrant((g) => ({ ...g, reason: "" }));
      setNotice("Role granted.");
      await refreshRoles();
    });

  const revokeRole = (assignmentId: string) => {
    const reason = window.prompt("Reason for revoking this role (recorded in the audit log):");
    if (!reason) return;
    void run(async () => {
      await api(`/api/admin/roles/${assignmentId}/revoke`, { method: "POST", body: { reason } });
      setNotice("Role revoked.");
      await refreshRoles();
    });
  };

  const toggleStatus = () => {
    const next = status === "active" ? "disabled" : "active";
    const reason = window.prompt(`Reason for setting this user to ${next} (recorded in the audit log):`);
    if (!reason) return;
    void run(async () => {
      await api(`/api/admin/users/${user.id}/status`, { method: "POST", body: { status: next, reason } });
      setStatus(next);
      setNotice(`User is now ${next}.`);
    });
  };

  const saveDept = () =>
    run(async () => {
      await api(`/api/admin/users/${user.id}/department`, {
        method: "POST",
        body: { homeCostCentreId: dept || null },
      });
      setNotice("Department updated.");
    });

  return (
    <Modal title={`${user.display_name}`} onClose={() => onClose(changed)}>
      <p className="text-sm text-slate-500 break-words">
        {user.email}
        {user.job_title ? ` · ${user.job_title}` : ""}
        {user.pending_first_login ? " · has not signed in yet" : ""}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <StatusBadge status={status} />
        {canEdit ? (
          <Button kind={status === "active" ? "danger" : "secondary"} disabled={busy} onClick={toggleStatus}>
            {status === "active" ? "Disable user" : "Re-enable user"}
          </Button>
        ) : null}
      </div>

      <div className="mt-4 flex flex-wrap items-end gap-2">
        <div className="w-full min-w-0 sm:w-auto">
          <Field label="Department">
            <select className={inputClass} value={dept} onChange={(e) => setDept(e.target.value)} disabled={!canEdit}>
              <option value="">(none)</option>
              {reference.costCentres.map((cc) => (
                <option key={cc.id} value={cc.id}>
                  {cc.department} — {cc.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {canEdit && dept !== (user.home_cost_centre_id ?? "") ? (
          <Button kind="primary" disabled={busy} onClick={() => void saveDept()}>
            Save department
          </Button>
        ) : null}
      </div>

      <h3 className="mt-5 text-sm font-semibold text-slate-900">Roles</h3>
      {roles.length === 0 ? <p className="mt-1 text-sm text-slate-500">No roles — the user can sign in but do nothing (default-deny).</p> : null}
      <ul className="mt-2 space-y-1">
        {roles.map((r) => (
          <li key={r.assignmentId} className="flex items-center justify-between gap-2 rounded border border-slate-100 bg-slate-50 px-3 py-1.5 text-sm">
            <span className="min-w-0">
              <span className="font-medium text-slate-900">{rolePill(r)}</span>
              <span className="ml-2 text-xs text-slate-500">{r.grantedReason}</span>
            </span>
            {canEdit ? (
              <Button kind="danger" disabled={busy} onClick={() => revokeRole(r.assignmentId)}>
                Revoke
              </Button>
            ) : null}
          </li>
        ))}
      </ul>

      {canEdit ? (
        <div className="mt-4 rounded border border-slate-200 bg-white p-3">
          <h4 className="text-sm font-semibold text-slate-900">Grant a role</h4>
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-4">
            <Field label="Role">
              <select className={inputClass} value={grant.role} onChange={(e) => setGrant((g) => ({ ...g, role: e.target.value }))}>
                {GRANTABLE_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {roleLabel(r)}
                  </option>
                ))}
              </select>
            </Field>
            {SCOPED_ROLES.includes(grant.role) ? (
              <Field label="Department">
                <select className={inputClass} value={grant.costCentreId} onChange={(e) => setGrant((g) => ({ ...g, costCentreId: e.target.value }))}>
                  <option value="">(choose)</option>
                  {reference.costCentres.map((cc) => (
                    <option key={cc.id} value={cc.id}>
                      {cc.department} — {cc.name}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}
            {grant.role === "approver" ? (
              <Field label="DOA tier" hint="5 supervisors · 4 senior mgmt · 3 executive">
                <select className={inputClass} value={grant.tier} onChange={(e) => setGrant((g) => ({ ...g, tier: e.target.value }))}>
                  <option value="5">Tier 5</option>
                  <option value="4">Tier 4</option>
                  <option value="3">Tier 3</option>
                </select>
              </Field>
            ) : null}
            <Field label="Reason" hint="Recorded in the audit log">
              <input className={inputClass} value={grant.reason} onChange={(e) => setGrant((g) => ({ ...g, reason: e.target.value }))} />
            </Field>
          </div>
          <div className="mt-2 flex justify-end">
            <Button
              kind="primary"
              disabled={busy || grant.reason.trim().length < 3 || (SCOPED_ROLES.includes(grant.role) && !grant.costCentreId)}
              onClick={() => void grantRole()}
            >
              Grant role
            </Button>
          </div>
        </div>
      ) : null}

      {notice ? <p className="mt-3 rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">{notice}</p> : null}
      <ErrorNote message={error} />
      <div className="mt-4 flex justify-end">
        <Button onClick={() => onClose(changed)}>Close</Button>
      </div>
    </Modal>
  );
}

function UsersSection() {
  const { state } = useAuth();
  const me = state.status === "authenticated" ? state.user : null;
  const canEdit = hasRole(me, "sysadmin");
  const users = useApiQuery<{ users: AdminUser[] }>("/api/admin/users");
  const reference = useApiQuery<ReferenceData>("/api/reference");
  const [showAdd, setShowAdd] = useState(false);
  const [managing, setManaging] = useState<string | null>(null);

  const managed = users.data?.users.find((u) => u.id === managing) ?? null;

  return (
    <section className="mt-8">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-slate-900">Users &amp; roles (A.5.18)</h2>
        <div className="flex flex-wrap items-center gap-3">
          <a className="text-sm text-slate-700 underline underline-offset-2" href="/api/admin/access-review.xlsx">
            Access review export (.xlsx)
          </a>
          {canEdit ? (
            <Button kind="primary" onClick={() => setShowAdd(true)} disabled={!reference.data}>
              Add user
            </Button>
          ) : null}
        </div>
      </div>
      <ErrorNote message={users.error} />
      {users.data ? (
        <div className="mt-3 overflow-x-auto rounded-md border border-slate-200 bg-white">
          <table className="w-full min-w-[860px] text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs text-slate-500">
              <tr>
                {["User", "Department", "Job title", "Status", "Roles", "Last login", ""].map((h) => (
                  <th key={h} className="px-3 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {users.data.users.map((u) => (
                <tr key={u.id} className="border-b border-slate-100">
                  <td className="px-3 py-2">
                    <p className="font-medium">{u.display_name}</p>
                    <p className="text-xs text-slate-500">
                      {u.email}
                      {u.pending_first_login ? " · awaiting first login" : ""}
                    </p>
                  </td>
                  <td className="px-3 py-2">{u.home_department ?? "—"}</td>
                  <td className="px-3 py-2">{u.job_title ?? "—"}</td>
                  <td className="px-3 py-2">
                    <StatusBadge status={u.status} />
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {u.roles.map((r) => (
                      <span key={r.assignmentId} className="mr-1 inline-block rounded bg-slate-100 px-1.5 py-0.5">
                        {rolePill(r)}
                      </span>
                    ))}
                  </td>
                  <td className="px-3 py-2 text-slate-500">{formatDate(u.last_login_at)}</td>
                  <td className="px-3 py-2 text-right">
                    <Button onClick={() => setManaging(u.id)}>{canEdit ? "Manage" : "View"}</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {showAdd && reference.data ? (
        <AddUserModal
          reference={reference.data}
          onClose={(createdUserId) => {
            setShowAdd(false);
            if (createdUserId) {
              users.refresh();
              setManaging(createdUserId);
            }
          }}
        />
      ) : null}
      {managing && managed && reference.data ? (
        <ManageUserModal
          user={managed}
          reference={reference.data}
          canEdit={canEdit}
          onClose={(changed) => {
            setManaging(null);
            if (changed) users.refresh();
          }}
        />
      ) : null}
    </section>
  );
}

/** Approved-supplier workflow (client change list): Tier 5+ request, the
 * supplier_approver role (Tier 4) approves, the sysadmin records/uploads —
 * two-person rule throughout, and only 'active' suppliers are usable on
 * requisitions. */
function SuppliersSection() {
  const { state } = useAuth();
  const me = state.status === "authenticated" ? state.user : null;
  const canApprove = hasRole(me, "supplier_approver");
  const isAdmin = hasRole(me, "sysadmin");
  const canRequest = hasRole(me, "approver") || canApprove;
  const suppliers = useApiQuery<{ suppliers: SupplierRow[] }>("/api/suppliers");
  const [form, setForm] = useState({ name: "", cdkVendorRef: "", taxId: "", reason: "" });
  const [showRequest, setShowRequest] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>, done: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(done);
      suppliers.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The change failed");
    }
    setBusy(false);
  };

  const request = () =>
    run(async () => {
      if (isAdmin) {
        await api("/api/admin/suppliers", {
          method: "POST",
          body: { name: form.name, cdkVendorRef: form.cdkVendorRef || null, taxId: form.taxId || null, reason: form.reason || null },
        });
      } else {
        await api("/api/suppliers/request", {
          method: "POST",
          body: { name: form.name, cdkVendorRef: form.cdkVendorRef || null, taxId: form.taxId || null, reason: form.reason },
        });
      }
      setForm({ name: "", cdkVendorRef: "", taxId: "", reason: "" });
      setShowRequest(false);
    }, "Supplier request recorded — a supplier approver must approve it before it can be used.");

  const decide = (id: string, kind: "approve" | "reject") => {
    const reason = kind === "reject" ? window.prompt("Reason for rejecting this supplier (recorded in the audit log):") : null;
    if (kind === "reject" && !reason) return;
    void run(async () => {
      await api(`/api/suppliers/${id}/${kind}`, { method: "POST", body: kind === "reject" ? { reason } : {} });
    }, kind === "approve" ? "Supplier approved — it is now on the approved list." : "Supplier rejected.");
  };

  const uploadList = async (file: File) => {
    setError(null);
    setNotice(null);
    try {
      const result = await uploadFile<{ createdCount: number; skippedExisting: string[] }>(
        "/api/admin/suppliers/upload",
        file,
      );
      setNotice(
        `${result.createdCount} supplier(s) uploaded as pending approval${
          result.skippedExisting.length > 0 ? ` · already listed: ${result.skippedExisting.join(", ")}` : ""
        }`,
      );
      suppliers.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    }
  };

  const pending = suppliers.data?.suppliers.filter((s) => s.status === "pending_approval") ?? [];

  return (
    <section className="mt-8">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-slate-900">Approved suppliers</h2>
        <div className="flex flex-wrap items-center gap-3">
          {isAdmin ? (
            <label className="cursor-pointer text-sm text-slate-700 underline underline-offset-2">
              Upload list (.xlsx)
              <input
                type="file"
                accept=".xlsx"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void uploadList(f);
                  e.target.value = "";
                }}
              />
            </label>
          ) : null}
          {canRequest || isAdmin ? (
            <Button kind="primary" onClick={() => setShowRequest(true)}>
              {isAdmin ? "Add supplier" : "Request supplier"}
            </Button>
          ) : null}
        </div>
      </div>
      <p className="mt-1 text-sm text-slate-500">
        Suppliers are requested (Tier 5+), approved by a supplier approver (Tier 4 — never the requester), and only then
        usable on requisitions.
      </p>
      {canApprove && pending.length > 0 ? (
        <p className="mt-2 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {pending.length} supplier request{pending.length === 1 ? "" : "s"} await{pending.length === 1 ? "s" : ""} your approval.
        </p>
      ) : null}
      {notice ? <p className="mt-2 rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">{notice}</p> : null}
      <ErrorNote message={error ?? suppliers.error} />
      {suppliers.data && suppliers.data.suppliers.length === 0 ? <EmptyState message="No suppliers yet." /> : null}
      {suppliers.data && suppliers.data.suppliers.length > 0 ? (
        <div className="mt-3 overflow-x-auto rounded-md border border-slate-200 bg-white">
          <table className="w-full min-w-[820px] text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs text-slate-500">
              <tr>
                {["Supplier", "CDK ref", "Tax ID", "Status", "Requested by", "Decision", ""].map((h) => (
                  <th key={h} className="px-3 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {suppliers.data.suppliers.map((s) => (
                <tr key={s.id} className="border-b border-slate-100">
                  <td className="px-3 py-2">
                    <p className="font-medium">{s.name}</p>
                    {s.requested_reason ? <p className="text-xs text-slate-500">{s.requested_reason}</p> : null}
                  </td>
                  <td className="px-3 py-2">{s.cdk_vendor_ref ?? "—"}</td>
                  <td className="px-3 py-2">{s.tax_id ?? "—"}</td>
                  <td className="px-3 py-2">
                    <StatusBadge status={s.status === "pending_approval" ? "pending_approval" : s.status} />
                  </td>
                  <td className="px-3 py-2 text-slate-500">{s.requested_by_name ?? "—"}</td>
                  <td className="px-3 py-2 text-xs text-slate-500">
                    {s.status === "active" && s.approved_by_name ? `approved by ${s.approved_by_name}` : null}
                    {s.status === "rejected" ? (
                      <span className="text-red-700">
                        rejected by {s.rejected_by_name}
                        {s.rejection_reason ? `: ${s.rejection_reason}` : ""}
                      </span>
                    ) : null}
                    {s.status === "pending_approval" ? "awaiting approval" : null}
                    {s.status === "inactive" ? "deactivated" : null}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {canApprove && s.status === "pending_approval" && s.requested_by !== me?.id ? (
                      <span className="flex justify-end gap-1">
                        <Button kind="primary" disabled={busy} onClick={() => decide(s.id, "approve")}>
                          Approve
                        </Button>
                        <Button kind="danger" disabled={busy} onClick={() => decide(s.id, "reject")}>
                          Reject
                        </Button>
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {showRequest ? (
        <Modal title={isAdmin ? "Add supplier" : "Request a supplier"} onClose={() => setShowRequest(false)}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Supplier name">
              <input className={inputClass} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
            </Field>
            <Field label="CDK vendor ref" hint="Optional">
              <input className={inputClass} value={form.cdkVendorRef} onChange={(e) => setForm((f) => ({ ...f, cdkVendorRef: e.target.value }))} />
            </Field>
            <Field label="Tax ID" hint="Optional">
              <input className={inputClass} value={form.taxId} onChange={(e) => setForm((f) => ({ ...f, taxId: e.target.value }))} />
            </Field>
            <Field label="Reason" hint="Why this supplier is needed">
              <input className={inputClass} value={form.reason} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} />
            </Field>
          </div>
          <p className="mt-3 text-xs text-slate-500">
            No bank or payment details are stored here — they belong in CDK (A.5.34).
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button onClick={() => setShowRequest(false)}>Cancel</Button>
            <Button
              kind="primary"
              disabled={busy || !form.name || (!isAdmin && form.reason.trim().length < 3)}
              onClick={() => void request()}
            >
              {isAdmin ? "Add (pending approval)" : "Submit request"}
            </Button>
          </div>
        </Modal>
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
  // The supplier list is for everyone who acts on it: requesters of new
  // suppliers (approvers), the supplier_approver, accounting and audit.
  const seesSuppliers = ["sysadmin", "supplier_approver", "approver", "accounting", "auditor"].some((r) =>
    hasRole(me, r),
  );

  return (
    <div>
      <h1 className="text-lg font-semibold text-slate-900">Admin</h1>
      <p className="mt-1 text-sm text-slate-500">
        DOA versions, approved suppliers, configurable settings, and access administration. The System Admin can never approve or touch financial records (A.5.3/A.8.2).
      </p>
      {seesDoa ? <DoaSection /> : null}
      {seesSuppliers ? <SuppliersSection /> : null}
      {seesAdministration ? (
        <>
          <SettingsSection />
          <UsersSection />
        </>
      ) : null}
      {!seesDoa && !seesAdministration && !seesSuppliers ? (
        <EmptyState message="Your roles have no administration surface. DOA versions need doa_admin/doa_approver; suppliers need an approver-family role; settings and users need sysadmin or auditor." />
      ) : null}
    </div>
  );
}
