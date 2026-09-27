import { AlertTriangle } from 'lucide-react';

/**
 * Full-screen takeover shown when the server's GET /api/cas/state response
 * does not match what this console expects (stale or mismatched server
 * build). It replaces the entire console — including the demo seed data —
 * so an operator can never mistake a drifted response for real state.
 */
export function StateResponseError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      data-testid="state-response-error"
      className="flex min-h-screen flex-col items-center justify-center bg-background px-6 text-center"
    >
      <AlertTriangle size={32} className="mb-4 text-destructive" />
      <h1 className="text-lg font-semibold">Server response not understood</h1>
      <p data-testid="state-response-error-detail" className="mt-2 max-w-xl text-sm text-muted-foreground">
        {message}
      </p>
      <p className="mt-2 max-w-xl text-sm text-muted-foreground">
        No console data is being shown, because applying an unrecognized response could misstate readiness.
      </p>
      <button
        type="button"
        data-testid="button-retry-state-load"
        onClick={onRetry}
        className="mt-6 rounded-md border border-border bg-secondary px-4 py-2 text-sm font-medium text-secondary-foreground hover:bg-secondary/80"
      >
        Retry
      </button>
    </div>
  );
}
