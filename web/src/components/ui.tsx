import type { ReactNode } from "react";

export function Money({ amount, currency }: { amount: string | number; currency?: string }) {
  const n = Number(amount);
  const formatted = n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (
    <span className={n < 0 ? "text-red-700" : undefined}>
      {currency ? `${currency} ` : ""}
      {formatted}
    </span>
  );
}

const STATUS_STYLES: Record<string, string> = {
  draft: "bg-slate-100 text-slate-700",
  submitted: "bg-amber-50 text-amber-800 border-amber-200",
  pending_approval: "bg-amber-50 text-amber-800 border-amber-200",
  pending_reapproval: "bg-amber-50 text-amber-800 border-amber-200",
  pending: "bg-amber-50 text-amber-800 border-amber-200",
  approved: "bg-emerald-50 text-emerald-800 border-emerald-200",
  active: "bg-emerald-50 text-emerald-800 border-emerald-200",
  posted: "bg-emerald-50 text-emerald-800 border-emerald-200",
  clean: "bg-emerald-50 text-emerald-800 border-emerald-200",
  denied: "bg-red-50 text-red-800 border-red-200",
  rejected: "bg-red-50 text-red-800 border-red-200",
  infected: "bg-red-50 text-red-800 border-red-200",
  closed: "bg-slate-100 text-slate-600",
  superseded: "bg-slate-100 text-slate-500",
  cancelled: "bg-slate-100 text-slate-500",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-block rounded border border-transparent px-1.5 py-0.5 text-[11px] font-medium ${
        STATUS_STYLES[status] ?? "bg-slate-100 text-slate-700"
      }`}
    >
      {status.replaceAll("_", " ")}
    </span>
  );
}

export function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="mt-2 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
      {message}
    </p>
  );
}

export function Button({
  children,
  onClick,
  kind = "secondary",
  disabled,
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  kind?: "primary" | "secondary" | "danger";
  disabled?: boolean;
  type?: "button" | "submit";
}) {
  const styles =
    kind === "primary"
      ? "bg-slate-900 text-white hover:bg-slate-700"
      : kind === "danger"
        ? "border border-red-300 bg-white text-red-700 hover:bg-red-50"
        : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50";
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`rounded px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 ${styles}`}
    >
      {children}
    </button>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-slate-600">{label}</span>
      <div className="mt-1">{children}</div>
      {hint ? <span className="mt-0.5 block text-[11px] text-slate-400">{hint}</span> : null}
    </label>
  );
}

export const inputClass =
  "w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-900 focus:outline-2 focus:outline-offset-1 focus:outline-slate-900";

export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 p-4" role="dialog" aria-modal="true">
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-lg border border-slate-200 bg-white p-5 shadow-xl">
        <div className="flex items-start justify-between">
          <h2 className="text-base font-semibold text-slate-900">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded px-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
            ✕
          </button>
        </div>
        <div className="mt-3">{children}</div>
      </div>
    </div>
  );
}

export function EmptyState({ message }: { message: string }) {
  return <p className="mt-4 rounded border border-dashed border-slate-200 bg-slate-50 p-6 text-center text-sm text-slate-500">{message}</p>;
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}
