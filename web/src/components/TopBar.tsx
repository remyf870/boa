import { useState } from "react";
import { roleNames } from "../api/types";
import { useAuth } from "./AuthProvider";

export function TopBar({ onOpenNav }: { onOpenNav: () => void }) {
  const { state, signOut } = useAuth();
  const [signingOut, setSigningOut] = useState(false);

  if (state.status !== "authenticated") {
    return null;
  }
  const { user } = state;
  const roles = roleNames(user.roles);

  function handleSignOut() {
    setSigningOut(true);
    void signOut();
  }

  return (
    <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-slate-200 bg-white px-3 md:px-4">
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          onClick={onOpenNav}
          aria-label="Open navigation"
          className="rounded border border-slate-300 bg-white p-1.5 text-slate-600 hover:bg-slate-50 focus:outline-2 focus:outline-offset-2 focus:outline-slate-900 md:hidden"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
        <p className="hidden text-xs text-slate-400 lg:block">Massy Motors — internal use only</p>
      </div>
      <div className="flex min-w-0 items-center gap-2 md:gap-4">
        <div className="min-w-0 text-right">
          <p className="truncate text-sm font-medium leading-4 text-slate-900">
            {user.displayName || user.email}
          </p>
          <p className="truncate text-xs leading-4 text-slate-500">
            {user.department ? (
              <span className="font-medium text-slate-600">{user.department.department} · </span>
            ) : null}
            {roles.length > 0 ? roles.join(", ") : "No roles assigned"}
          </p>
        </div>
        <button
          type="button"
          onClick={handleSignOut}
          disabled={signingOut}
          className="whitespace-nowrap rounded border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 focus:outline-2 focus:outline-offset-2 focus:outline-slate-900 disabled:opacity-50"
        >
          {signingOut ? "Signing out…" : "Sign out"}
        </button>
      </div>
    </header>
  );
}
