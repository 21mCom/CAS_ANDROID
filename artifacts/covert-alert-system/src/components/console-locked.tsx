import { LockKeyhole } from 'lucide-react';

/**
 * Full-screen takeover shown when the console has no usable device
 * credential (the operator cancelled the enrollment prompt, or the server
 * rejected the credential). It replaces the entire console — including the
 * demo seed data — so an operator can never mistake sample records for live
 * incident state while signed out. The retry re-opens the enrollment prompt.
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
        No incident data is being shown — not even the built-in demo records. Without an enrolled
        credential this console cannot distinguish live state from samples, so it shows nothing.
      </p>
      <button
        type="button"
        data-testid="button-unlock-console"
        onClick={onUnlock}
        className="mt-6 rounded-md border border-border bg-secondary px-4 py-2 text-sm font-medium text-secondary-foreground hover:bg-secondary/80"
      >
        Enter enrollment credential
      </button>
    </div>
  );
}
