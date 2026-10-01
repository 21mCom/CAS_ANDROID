import { KeyRound, LockKeyhole } from 'lucide-react';

/**
 * Full-screen takeover shown when the console has no usable device
 * credential (the operator cancelled the enrollment dialog, or the server
 * rejected the credential). It replaces the entire console — including the
 * demo seed data — so an operator can never mistake sample records for live
 * incident state while signed out. The retry re-opens the enrollment dialog.
 */
export function ConsoleLocked({ message, onUnlock }: { message: string; onUnlock: () => void }) {
  return (
    <div
      data-testid="console-locked"
      className="flex min-h-screen flex-col items-center justify-center bg-background px-6 text-center"
    >
      <LockKeyhole size={32} className="mb-4 text-muted-foreground" />
      <h1 className="text-lg font-semibold">Console locked</h1>
      <p data-testid="console-locked-detail" className="mt-2 max-w-xl text-sm text-muted-foreground">
        {message}
      </p>
      <p className="mt-2 max-w-xl text-sm text-muted-foreground">
        Nothing is shown while the console is locked — not even the built-in sample records — so you
        can never mistake demo data for a real alert.
      </p>
      <div className="mt-5 max-w-xl rounded-lg border border-border bg-card px-4 py-3 text-left">
        <p className="flex items-center gap-2 text-sm font-semibold">
          <KeyRound size={14} className="shrink-0 text-muted-foreground" />
          Where do I find the enrollment credential?
        </p>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">
          It is the alert password chosen when the server was set up — stored as the{' '}
          <span className="font-mono-ui text-xs">CAS_ALERT_TOKEN</span> value in the server&apos;s
          secrets. Ask whoever deployed the server if you don&apos;t have it. This browser swaps it
          for its own revocable credential; the password itself is never stored here.
        </p>
      </div>
      <button
        type="button"
        data-testid="button-unlock-console"
        onClick={onUnlock}
        className="mt-6 rounded-md border border-border bg-secondary px-4 py-2 text-sm font-medium text-secondary-foreground hover:bg-secondary/80"
      >
        Unlock with the enrollment credential
      </button>
    </div>
  );
}
