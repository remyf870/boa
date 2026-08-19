interface DashboardTileProps {
  title: string;
}

/** Dashboard tile (§5.7) — neutral empty state until Phase 1 wires in data. */
export function DashboardTile({ title }: DashboardTileProps) {
  return (
    <section aria-label={title} className="rounded-md border border-slate-200 bg-white p-4">
      <h2 className="break-words text-sm font-medium text-slate-600">{title}</h2>
      <p className="mt-3 break-words text-2xl font-semibold text-slate-300" aria-hidden="true">
        —
      </p>
      <p className="mt-1 text-xs text-slate-400">No data yet — Phase 1</p>
    </section>
  );
}
