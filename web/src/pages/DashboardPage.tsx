import { Link } from "react-router-dom";
import type { DashboardData } from "../api/types";
import { useApiQuery } from "../hooks/useApi";
import { ErrorNote, Money } from "../components/ui";

function Tile({ title, value, to, tone }: { title: string; value: string | number; to: string; tone?: "danger" }) {
  return (
    <Link
      to={to}
      className="rounded-md border border-slate-200 bg-white p-4 transition-colors hover:border-slate-300 hover:bg-slate-50"
      aria-label={title}
    >
      <h2 className="text-sm font-medium text-slate-600">{title}</h2>
      <p className={`mt-3 text-2xl font-semibold ${tone === "danger" ? "text-red-700" : "text-slate-900"}`}>{value}</p>
    </Link>
  );
}

/** §5.7: deliberately thin — four tiles; analytics belong in Power BI (§6.4). */
export function DashboardPage() {
  const dashboard = useApiQuery<DashboardData>("/api/dashboard");

  return (
    <div>
      <h1 className="text-lg font-semibold text-slate-900">Dashboard</h1>
      <p className="mt-1 text-sm text-slate-500">Your purchasing activity at a glance.</p>
      <ErrorNote message={dashboard.error} />
      {dashboard.data ? (
        <>
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Tile title="Pending my approval" value={dashboard.data.pendingMyApproval} to="/approvals" />
            <Tile title="My open requisitions" value={dashboard.data.myOpenRequisitions} to="/requisitions" />
            <Tile title="Denied this month" value={dashboard.data.deniedThisMonth} to="/logbook" tone={dashboard.data.deniedThisMonth > 0 ? "danger" : undefined} />
          </div>
          <h2 className="mt-6 text-sm font-medium text-slate-600">Budget position by cost centre (live figures on the Budgets page)</h2>
          <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {dashboard.data.budgetPositions.map((b) => (
              <Link key={b.costCentreId} to="/budgets" className="rounded-md border border-slate-200 bg-white p-4 hover:border-slate-300 hover:bg-slate-50">
                <p className="text-sm font-medium text-slate-900">
                  {b.costCentreCode} <span className="font-normal text-slate-500">· {b.period}</span>
                </p>
                {b.hasActiveBudget ? (
                  <>
                    <p className="mt-2 text-xl font-semibold tabular-nums">
                      <Money amount={b.totals.available} currency="TTD" />
                    </p>
                    <p className="mt-0.5 text-xs text-slate-500">
                      available of <Money amount={b.totals.budget} /> · committed <Money amount={b.totals.committed} /> · actual <Money amount={b.totals.actual} />
                    </p>
                  </>
                ) : (
                  <p className="mt-2 text-sm text-amber-700">No approved budget for this period.</p>
                )}
              </Link>
            ))}
            {dashboard.data.budgetPositions.length === 0 ? (
              <p className="text-sm text-slate-400">No cost centres visible to your roles.</p>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
