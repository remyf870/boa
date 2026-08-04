interface LoginPageProps {
  /** True when an authenticated session hit a 401 (idle/absolute timeout, A.8.5). */
  sessionExpired: boolean;
}

function MicrosoftLogo() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect x="0" y="0" width="7" height="7" fill="#f25022" />
      <rect x="9" y="0" width="7" height="7" fill="#7fba00" />
      <rect x="0" y="9" width="7" height="7" fill="#00a4ef" />
      <rect x="9" y="9" width="7" height="7" fill="#ffb900" />
    </svg>
  );
}

export function LoginPage({ sessionExpired }: LoginPageProps) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 p-6">
      <div className="w-full max-w-sm rounded-lg border border-slate-200 bg-white p-8 shadow-sm">
        <h1 className="text-lg font-semibold tracking-tight text-slate-900">Massy Purchasing</h1>
        <p className="mt-0.5 text-sm text-slate-500">Purchase requisition &amp; approval</p>

        {sessionExpired && (
          <p
            role="status"
            className="mt-4 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
          >
            Your session expired. Please sign in again.
          </p>
        )}

        <a
          href="/api/auth/login"
          className="mt-6 flex w-full items-center justify-center gap-2 rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 focus:outline-2 focus:outline-offset-2 focus:outline-slate-900"
        >
          <MicrosoftLogo />
          Sign in with Microsoft
        </a>

        <p className="mt-6 text-xs leading-5 text-slate-500">
          Access is restricted to authorised Massy Motors personnel. This system is for business
          use only; all activity is monitored and logged.
        </p>
      </div>
    </main>
  );
}
