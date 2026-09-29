import { type ReactNode } from 'react';
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
  const { runTestIncident, stateIssue, retryStateLoad, authLock, unlockConsole, offlineDemo } = useFieldTest();
  // A missing or rejected credential locks the whole console: rendering
  // anything else would risk presenting the demo seed as live state.
  if (authLock) return <ConsoleLocked message={authLock} onUnlock={unlockConsole} />;
  // A state response this console cannot parse replaces every screen:
  // rendering the console anyway would present unrecognized (or demo) data
  // as real durable state.
  if (stateIssue) return <StateResponseError message={stateIssue} onRetry={retryStateLoad} />;
  return (
    <AppShell onRunTest={runTestIncident}>
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
