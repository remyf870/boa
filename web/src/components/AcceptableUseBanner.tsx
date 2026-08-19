import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";

interface AcceptableUseBannerProps {
  onAcknowledge: () => Promise<void>;
}

/**
 * Acceptable-use notice (ISO 27001 A.5.10).
 *
 * Rendered INSTEAD of the application shell — nothing else is mounted until
 * the user acknowledges, so there is no way into the app around it. Focus is
 * moved into the dialog on mount and trapped there; Escape does not dismiss.
 */
export function AcceptableUseBanner({ onAcknowledge }: AcceptableUseBannerProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    buttonRef.current?.focus();
  }, []);

  // Focus trap: if focus ever lands outside the dialog, pull it back.
  useEffect(() => {
    function onFocusIn(event: FocusEvent) {
      const dialog = dialogRef.current;
      if (dialog && event.target instanceof Node && !dialog.contains(event.target)) {
        buttonRef.current?.focus();
      }
    }
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, []);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // The acknowledge button is the only focusable control; keep Tab cycling on it.
    if (event.key === "Tab") {
      event.preventDefault();
      buttonRef.current?.focus();
    }
  }

  async function handleAcknowledge() {
    setPending(true);
    setError(null);
    try {
      await onAcknowledge();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not record your acknowledgement. Please try again.",
      );
      setPending(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 sm:p-6"
      onKeyDown={handleKeyDown}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="aup-title"
        aria-describedby="aup-body"
        className="max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-lg border border-slate-200 bg-white p-6 shadow-xl sm:p-8"
      >
        <h1 id="aup-title" className="text-lg font-semibold text-slate-900">
          Acceptable use notice
        </h1>
        <div id="aup-body" className="mt-4 space-y-3 text-sm leading-6 text-slate-700">
          <p>
            This system is the property of Massy Motors and is provided for{" "}
            <strong>authorised business use only</strong>.
          </p>
          <p>
            All activity on this system is <strong>monitored and logged</strong>, including the
            records you view, create, approve, and export.
          </p>
          <p>
            Unauthorised access to, or misuse of, this system or its information may result in{" "}
            <strong>disciplinary action</strong> and, where applicable, legal proceedings.
          </p>
          <p>By continuing, you confirm that you have read and understood this notice.</p>
        </div>
        {error && (
          <p role="alert" className="mt-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            {error}
          </p>
        )}
        <button
          ref={buttonRef}
          type="button"
          onClick={() => void handleAcknowledge()}
          disabled={pending}
          className="mt-6 w-full rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 focus:outline-2 focus:outline-offset-2 focus:outline-slate-900 disabled:opacity-50"
        >
          {pending ? "Recording acknowledgement…" : "I acknowledge"}
        </button>
      </div>
    </div>
  );
}
