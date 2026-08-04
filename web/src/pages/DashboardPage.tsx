import { DashboardTile } from "../components/DashboardTile";

const TILES = [
  "Pending my approval",
  "My open requisitions",
  "Budget position",
  "Denied this month",
] as const;

/** Deliberately thin dashboard (§5.7): four tiles, placeholders in Phase 0. */
export function DashboardPage() {
  return (
    <div>
      <h1 className="text-lg font-semibold text-slate-900">Dashboard</h1>
      <p className="mt-1 text-sm text-slate-500">Your purchasing activity at a glance.</p>
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {TILES.map((title) => (
          <DashboardTile key={title} title={title} />
        ))}
      </div>
    </div>
  );
}
