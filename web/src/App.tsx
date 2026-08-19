import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AcceptableUseBanner } from "./components/AcceptableUseBanner";
import { AppLayout } from "./components/AppLayout";
import { AuthProvider, useAuth } from "./components/AuthProvider";
import { AccountingPage } from "./pages/AccountingPage";
import { AdminPage } from "./pages/AdminPage";
import { ApprovalsPage } from "./pages/ApprovalsPage";
import { BudgetsPage } from "./pages/BudgetsPage";
import { DashboardPage } from "./pages/DashboardPage";
import { LogbookPage } from "./pages/LogbookPage";
import { LoginPage } from "./pages/LoginPage";
import { RequisitionDetailPage } from "./pages/RequisitionDetailPage";
import { RequisitionsPage } from "./pages/RequisitionsPage";

function AuthGate() {
  const { state, acknowledgeBanner, reload } = useAuth();

  if (state.status === "loading") {
    return (
      <main
        className="flex min-h-dvh items-center justify-center bg-slate-50"
        aria-busy="true"
      >
        <p role="status" className="text-sm text-slate-500">
          Loading…
        </p>
      </main>
    );
  }

  if (state.status === "error") {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-slate-50 p-6">
        <div className="w-full max-w-sm rounded-lg border border-slate-200 bg-white p-8 text-center shadow-sm">
          <h1 className="text-base font-semibold text-slate-900">Unable to reach the server</h1>
          <p className="mt-2 text-sm text-slate-500">{state.message}</p>
          <button
            type="button"
            onClick={reload}
            className="mt-4 rounded border border-slate-300 bg-white px-4 py-2 text-sm text-slate-700 hover:bg-slate-50 focus:outline-2 focus:outline-offset-2 focus:outline-slate-900"
          >
            Retry
          </button>
        </div>
      </main>
    );
  }

  if (state.status === "unauthenticated") {
    return <LoginPage sessionExpired={state.sessionExpired} />;
  }

  // A.5.10: the acceptable-use notice is rendered INSTEAD of the shell —
  // no application content is mounted until it is acknowledged.
  if (!state.user.bannerAcknowledged) {
    return <AcceptableUseBanner onAcknowledge={acknowledgeBanner} />;
  }

  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<DashboardPage />} />
        <Route path="requisitions" element={<RequisitionsPage />} />
        <Route path="requisitions/:id" element={<RequisitionDetailPage />} />
        <Route path="approvals" element={<ApprovalsPage />} />
        <Route path="budgets" element={<BudgetsPage />} />
        <Route path="budgets/versions/:id" element={<BudgetsPage />} />
        <Route path="accounting" element={<AccountingPage />} />
        <Route path="logbook" element={<LogbookPage />} />
        <Route path="admin" element={<AdminPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AuthGate />
      </AuthProvider>
    </BrowserRouter>
  );
}
