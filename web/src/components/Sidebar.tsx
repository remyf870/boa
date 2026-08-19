import { NavLink } from "react-router-dom";
import { hasRole } from "../api/types";
import { useAuth } from "./AuthProvider";

interface NavItem {
  to: string;
  label: string;
  end?: boolean;
  /** Roles (any of) that make this destination useful. Omitted = everyone.
   * Visibility only — every page's API stays server-side authorised; hiding
   * doomed links also stops innocent nav clicks writing AccessDenied audit
   * rows (review finding). */
  anyOf?: string[];
}

const NAV_ITEMS: NavItem[] = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/requisitions", label: "Requisitions", anyOf: ["requester", "approver", "accounting", "auditor"] },
  // Accounting decides the finance_review step on every requisition (the
  // "Accounts final hurdle"), so the approvals queue is theirs too.
  { to: "/approvals", label: "Approvals", anyOf: ["approver", "accounting"] },
  {
    to: "/budgets",
    label: "Budgets",
    anyOf: ["requester", "approver", "budget_owner", "budget_approver", "accounting", "auditor"],
  },
  { to: "/accounting", label: "Accounting", anyOf: ["accounting"] },
  { to: "/logbook", label: "Logbook", anyOf: ["requester", "approver", "accounting", "auditor"] },
  // Approvers reach Admin for the supplier request/approval workflow;
  // the page itself gates each section by role.
  {
    to: "/admin",
    label: "Admin",
    anyOf: ["sysadmin", "auditor", "doa_admin", "doa_approver", "supplier_approver", "approver", "accounting"],
  },
];

function Brand() {
  return (
    <div>
      <p className="text-sm font-semibold tracking-tight text-slate-900">Massy Purchasing</p>
      <p className="mt-0.5 text-xs text-slate-500">Purchase approval &amp; DOA</p>
    </div>
  );
}

function Nav({ items }: { items: NavItem[] }) {
  return (
    <nav aria-label="Primary" className="flex-1 overflow-y-auto p-2">
      <ul className="space-y-0.5">
        {items.map((item) => (
          <li key={item.to}>
            <NavLink
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                [
                  "block rounded px-3 py-1.5 text-sm",
                  isActive
                    ? "bg-slate-100 font-medium text-slate-900"
                    : "text-slate-600 hover:bg-slate-50 hover:text-slate-900",
                ].join(" ")
              }
            >
              {item.label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function Notice() {
  return (
    <div className="border-t border-slate-200 px-4 py-3">
      <p className="text-[11px] leading-4 text-slate-400">
        Internal system — authorised use only. Activity is monitored and logged.
      </p>
    </div>
  );
}

/**
 * Primary navigation. Two renderings, one source of truth:
 * - md+ : static rail, always visible (unchanged desktop behaviour).
 * - < md: slide-over drawer, mounted only while open so its links can never
 *         take keyboard focus while off-screen.
 */
export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state } = useAuth();
  const me = state.status === "authenticated" ? state.user : null;
  const visible = NAV_ITEMS.filter((item) => !item.anyOf || item.anyOf.some((role) => hasRole(me, role)));

  return (
    <>
      {/* Desktop rail */}
      <aside className="hidden w-56 shrink-0 flex-col border-r border-slate-200 bg-white md:flex">
        <div className="border-b border-slate-200 px-4 py-4">
          <Brand />
        </div>
        <Nav items={visible} />
        <Notice />
      </aside>

      {/* Mobile drawer */}
      {open ? (
        <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <div className="absolute inset-0 bg-slate-900/40" onClick={onClose} aria-hidden="true" />
          <aside className="absolute inset-y-0 left-0 flex w-64 max-w-[85vw] flex-col border-r border-slate-200 bg-white shadow-xl">
            <div className="flex items-start justify-between border-b border-slate-200 px-4 py-4">
              <Brand />
              <button
                type="button"
                onClick={onClose}
                aria-label="Close navigation"
                className="-mr-1 rounded px-2 py-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              >
                ✕
              </button>
            </div>
            <Nav items={visible} />
            <Notice />
          </aside>
        </div>
      ) : null}
    </>
  );
}
