interface PlaceholderPageProps {
  title: string;
}

/** Consistent placeholder for sections that arrive in later build phases. */
export function PlaceholderPage({ title }: PlaceholderPageProps) {
  return (
    <div>
      <h1 className="text-lg font-semibold text-slate-900">{title}</h1>
      <div className="mt-4 rounded-md border border-dashed border-slate-300 bg-white px-6 py-12 text-center">
        <p className="text-sm font-medium text-slate-700">Coming in Phase 1–3</p>
        <p className="mt-1 text-sm text-slate-500">
          This area is not part of the Phase 0 foundation build.
        </p>
      </div>
    </div>
  );
}
