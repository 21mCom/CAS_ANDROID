import { useEffect, useRef, useState } from 'react';
import { KeyRound, ShieldCheck } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  registerDeviceEnrollmentPrompt,
  type DeviceEnrollmentExchange,
} from '@/lib/device-credential-storage';

/**
 * The console's in-app enrollment dialog, replacing the native
 * window.prompt that used to collect the enrollment credential. Mounted once
 * inside the field-test provider; the data layer opens it through the
 * registered prompt bridge whenever a credentialed request finds no stored
 * device token.
 *
 * The dialog stays open — in a busy state — while the enrollment exchange is
 * in flight, and stays open with the server's rejection inline when the
 * credential is refused. It only closes on success or an explicit cancel.
 * That matters for sign-out privacy: a signed-out console must never become
 * visible again before authentication has actually succeeded.
 *
 * Security posture (unchanged from the prompt era): the enrollment
 * credential is only ever submitted to the enrollment endpoint — never
 * stored, never replayed silently. Persisting the issued *device* credential
 * across sessions is an explicit, unchecked-by-default opt-in; without it
 * the credential stays session-only. Cancelling (Cancel button, X, Escape,
 * overlay) locks the console — there is no path to the demo seed from here.
 */
export function DeviceEnrollmentDialog() {
  const [open, setOpen] = useState(false);
  const [rejection, setRejection] = useState<string | null>(null);
  const [credential, setCredential] = useState('');
  const [keepSignedIn, setKeepSignedIn] = useState(false);
  const [busy, setBusy] = useState(false);
  const exchangeRef = useRef<DeviceEnrollmentExchange | null>(null);
  const resolver = useRef<((enrolled: boolean) => void) | null>(null);
  // Mirror of `busy` readable from the dialog-close callback, whose closure
  // would otherwise capture a stale value.
  const busyRef = useRef(false);

  useEffect(
    () =>
      registerDeviceEnrollmentPrompt(
        (exchange) =>
          new Promise<boolean>((resolve) => {
            exchangeRef.current = exchange;
            resolver.current = resolve;
            busyRef.current = false;
            setBusy(false);
            setRejection(null);
            setCredential('');
            setKeepSignedIn(false);
            setOpen(true);
          }),
      ),
    [],
  );

  const settle = (enrolled: boolean) => {
    const resolve = resolver.current;
    resolver.current = null;
    exchangeRef.current = null;
    setOpen(false);
    resolve?.(enrolled);
  };

  const submit = async () => {
    const trimmed = credential.trim();
    const exchange = exchangeRef.current;
    if (!trimmed || !exchange || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setRejection(null);
    let error: string | null;
    try {
      error = await exchange({ credential: trimmed, keepSignedIn });
    } catch {
      error = 'The enrollment request could not reach the server; nothing was stored.';
    }
    busyRef.current = false;
    setBusy(false);
    if (error === null) {
      settle(true);
      return;
    }
    // Rejected: stay open with the reason inline so the operator can retry
    // without the console (or a lock screen) flashing in between.
    setRejection(error);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Any dismiss path (X, Escape, overlay click) is a cancellation; the
        // data layer turns that into the locked console surface. Dismissal
        // is ignored while an exchange is in flight so the dialog can't
        // close — and re-expose a signed-out console — mid-authentication.
        if (!next && !busyRef.current) settle(false);
      }}
    >
      <DialogContent
        data-testid="device-enrollment-dialog"
        className="sm:max-w-md"
        onEscapeKeyDown={(event) => {
          if (busyRef.current) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (busyRef.current) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound size={16} className="shrink-0 text-muted-foreground" />
            Sign in this console
          </DialogTitle>
          <DialogDescription>
            Enter the enrollment credential — the alert password chosen when the server was set up
            (its <span className="font-mono-ui text-xs">CAS_ALERT_TOKEN</span> secret). This browser
            swaps it for its own revocable access credential; the password itself is never stored
            here.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {rejection && (
            <p
              data-testid="enrollment-error"
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {rejection}
            </p>
          )}
          <div className="grid gap-1.5">
            <label htmlFor="enrollment-credential" className="text-sm font-medium">
              Enrollment credential
            </label>
            <input
              id="enrollment-credential"
              data-testid="input-enrollment-credential"
              type="password"
              autoComplete="off"
              autoFocus
              disabled={busy}
              value={credential}
              onChange={(event) => setCredential(event.target.value)}
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60"
            />
          </div>
          <div className="flex items-start gap-2.5 rounded-md border border-border bg-muted/40 px-3 py-2.5">
            <input
              id="keep-signed-in"
              data-testid="checkbox-keep-signed-in"
              type="checkbox"
              checked={keepSignedIn}
              disabled={busy}
              onChange={(event) => setKeepSignedIn(event.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
            />
            <label htmlFor="keep-signed-in" className="text-sm leading-5">
              <span className="font-medium">Keep this browser signed in on this device</span>
              <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                Stores this browser&apos;s revocable credential so you are not asked again after
                closing the browser. Leave unchecked on shared devices — the credential stays for
                this session only. You can always cut a browser off from the device credentials
                panel on the Setup checklist page.
              </span>
            </label>
          </div>
          <DialogFooter className="gap-2 sm:gap-2">
            <button
              type="button"
              data-testid="button-cancel-enrollment"
              disabled={busy}
              onClick={() => settle(false)}
              className="rounded-md border border-border bg-secondary px-4 py-2 text-sm font-medium text-secondary-foreground hover:bg-secondary/80 disabled:opacity-50"
            >
              Not now
            </button>
            <button
              type="submit"
              data-testid="button-enroll-device"
              disabled={busy || !credential.trim()}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              <ShieldCheck size={14} />
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
