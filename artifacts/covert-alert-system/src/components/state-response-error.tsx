import { useState } from 'react';
import { AlertTriangle, ChevronDown, RotateCcw } from 'lucide-react';

/**
 * Full-screen takeover shown when the server's GET /api/cas/state response
 * does not match what this console expects (stale or mismatched server
 * build). It replaces the entire console — including the demo seed data —
 * so an operator can never mistake a drifted response for real state. The
 * friendly summary leads; the technical reason stays one tap away.
 */
export function StateResponseError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const [showDetail, setShowDetail] = useState(false);
  return (
    <div
      data-testid="state-response-error"
      className="flex min-h-screen flex-col items-center justify-center bg-background px-6 text-center"
    >
      <AlertTriangle size={32} className="mb-4 text-destructive" />
      <h1 className="text-lg font-semibold">The server answered in a way this console doesn&apos;t recognize</h1>
      <p className="mt-2 max-w-xl text-sm text-muted-foreground">
        No console data is being shown, because showing half-recognized data could misstate how
        ready the system is. This usually means the server was updated — try again once, and if it
        keeps happening, ask whoever runs the server to redeploy the matching build.
      </p>
      <div className="mt-4 max-w-xl">
        <button
          type="button"
          onClick={() => setShowDetail((open) => !open)}
          className="inline-flex items-center gap-1 text-sm font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground"
          data-testid="button-state-error-details"
        >
          Technical details
          <ChevronDown size={14} className={showDetail ? 'rotate-180 transition-transform' : 'transition-transform'} />
        </button>
        <p
          data-testid="state-response-error-detail"
          hidden={!showDetail}
          className="mt-2 break-words rounded-md border border-border bg-muted px-3 py-2 text-left font-mono-ui text-xs leading-5 text-muted-foreground"
        >
          {message}
        </p>
      </div>
      <button
        type="button"
        data-testid="button-retry-state-load"
        onClick={onRetry}
        className="mt-6 inline-flex items-center gap-2 rounded-md border border-border bg-secondary px-4 py-2 text-sm font-medium text-secondary-foreground hover:bg-secondary/80"
      >
        <RotateCcw size={14} /> Try again
      </button>
    </div>
  );
}
