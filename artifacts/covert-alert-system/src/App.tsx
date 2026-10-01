import { type ReactNode } from 'react';
import { LogOut } from 'lucide-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { StateResponseError } from '@/components/state-response-error';
import { ConsoleLocked } from '@/components/console-locked';
import { OfflineDemoBanner } from '@/components/offline-demo-banner';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { AppShell } from '@/components/app-shell';
import { FieldTestProvider, useFieldTest } from '@/hooks/use-field-test';
import Overview from '@/pages/overview';
import Gates from '@/pages/gates';
import Incidents from '@/pages/incidents';
import Setup from '@/pages/setup';
import Responders from '@/pages/responders';
import Messages from '@/pages/messages';
import EmailDelivery from '@/pages/email';
import {
  Route,
  Switch,
  useLocation,
  Router as WouterRouter,
} from 'wouter';
import Capture from '@/pages/capture';

const queryClient = new QueryClient();

function RoutedApp() {
  const { runTestIncident, stateIssue, retryStateLoad, authLock, unlockConsole, signOutConsole, signedOut, offlineDemo } = useFieldTest();
  // A missing or rejected credential locks the whole console: rendering
  // anything else would risk presenting the demo seed as live state.
  if (authLock) return <ConsoleLocked message={authLock} onUnlock={unlockConsole} />;
  // A state response this console cannot parse replaces every screen:
  // rendering the console anyway would present unrecognized (or demo) data
  // as real durable state.
  if (stateIssue) return <StateResponseError message={stateIssue} onRetry={retryStateLoad} />;
  // Signed out and not yet re-authenticated: show nothing but a blank
  // backdrop (the enrollment dialog opens on top of it). Unmounting the
  // shell here is what discards route-local data — responder lists, email
  // settings — fetched under the previous credential.
  if (signedOut) return <SignedOutBackdrop />;
  return (
    <AppShell onRunTest={runTestIncident} onSignOut={signOutConsole}>
      {/* The demo seed survives only as the labeled offline fallback. */}
      {offlineDemo && <OfflineDemoBanner onRetry={retryStateLoad} />}
      <RoutedErrorBoundary>
        <Switch>
          <Route path="/" component={Overview} />
          <Route path="/gates" component={Gates} />
          <Route path="/incidents" component={Incidents} />
          <Route path="/capture" component={Capture} />
          <Route path="/setup" component={Setup} />
          <Route path="/responders" component={Responders} />
          <Route path="/messages" component={Messages} />
          <Route path="/email" component={EmailDelivery} />
          <Route component={NotFound} />
        </Switch>
      </RoutedErrorBoundary>
    </AppShell>
  );
}

function Router() {
  return (
    <FieldTestProvider>
      <RoutedApp />
    </FieldTestProvider>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

/**
 * Blank takeover shown from sign-out until a state load has authenticated
 * with a fresh credential. It renders no console chrome and no data — the
 * enrollment dialog opens on top of it, and cancelling that dialog trades
 * it for the locked surface.
 */
function SignedOutBackdrop() {
  return (
    <div
      data-testid="console-signed-out"
      className="flex min-h-screen flex-col items-center justify-center bg-background px-6 text-center"
    >
      <LogOut size={32} className="mb-4 text-muted-foreground" />
      <h1 className="text-lg font-semibold">Signed out</h1>
      <p className="mt-2 max-w-xl text-sm text-muted-foreground">
        This browser&apos;s credential was cleared. Sign in again to reopen the console.
      </p>
    </div>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
