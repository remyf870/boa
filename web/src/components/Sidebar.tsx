import { NavLink } from "react-router-dom";

interface NavItem {
  to: string;
  label: string;
  end?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/requisitions", label: "Requisitions" },
  { to: "/approvals", label: "Approvals" },
  { to: "/accounting", label: "Accounting" },
  { to: "/logbook", label: "Logbook" },
  { to: "/admin", label: "Admin" },
];

export function Sidebar() {
  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-slate-200 bg-white">
      <div className="border-b border-slate-200 px-4 py-4">
        <p className="text-sm font-semibold tracking-tight text-slate-900">Massy Purchasing</p>
        <p className="mt-0.5 text-xs text-slate-500">Purchase approval &amp; DOA</p>
      </div>
      <nav aria-label="Primary" className="flex-1 overflow-y-auto p-2">
        <ul className="space-y-0.5">
          {NAV_ITEMS.map((item) => (
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
      <div className="border-t border-slate-200 px-4 py-3">
        <p className="text-[11px] leading-4 text-slate-400">
          Internal system — authorised use only. Activity is monitored and logged.
        </p>
      </div>
    </aside>
  );
}
