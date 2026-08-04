import { useState } from "react";
import { roleNames } from "../api/types";
import { useAuth } from "./AuthProvider";

export function TopBar() {
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
    <header className="flex h-12 shrink-0 items-center justify-between border-b border-slate-200 bg-white px-4">
      <p className="text-xs text-slate-400">Massy Motors — internal use only</p>
      <div className="flex items-center gap-4">
        <div className="text-right">
          <p className="text-sm font-medium leading-4 text-slate-900">
            {user.displayName || user.email}
          </p>
          <p className="text-xs leading-4 text-slate-500">
            {roles.length > 0 ? roles.join(", ") : "No roles assigned"}
          </p>
        </div>
        <button
          type="button"
          onClick={handleSignOut}
          disabled={signingOut}
          className="rounded border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 focus:outline-2 focus:outline-offset-2 focus:outline-slate-900 disabled:opacity-50"
        >
          {signingOut ? "Signing out…" : "Sign out"}
        </button>
      </div>
    </header>
  );
}
