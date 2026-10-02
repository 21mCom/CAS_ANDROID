import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { CasStateShapeError, parseCasIncidentDetailResponse, parseCasStateResponse } from '@/lib/cas-state-schema';
import { DeviceEnrollmentDialog } from '@/components/device-enrollment-dialog';
import {
  clearStoredDeviceToken,
  readStoredDeviceToken,
  requestDeviceEnrollment,
  storeDeviceToken,
  type DeviceEnrollmentExchange,
} from '@/lib/device-credential-storage';

export type GateStatus = 'verified' | 'partial' | 'blocked' | 'not-started';
export type Priority = 'P1' | 'P2' | 'P3';

export type ObservationResult = 'pass' | 'fail' | 'inconclusive';
export type Gate = {
  id: string;
  index: string;
  name: string;
  short: string;
  status: GateStatus;
  criterion: string;
  evidence: string[];
  nextAction: string;
  owner: string;
};

export type SetupItem = {
  id: string;
  label: string;
  detail: string;
  group: string;
  complete: boolean;
  mode: 'owner' | 'measured';
};

export type Incident = {
  id: string;
  priority: Priority;
  time: string;
  title: string;
  detail: string;
  state: string;
  source: string;
  sample: boolean;
};

export type GateObservation = {
  result: ObservationResult;
  notes: string;
  recordedAt: string;
};

export type Gate0AImportSummary = {
  evidenceClass: 'physical-device-observation' | 'simulated-emulator' | 'sample';
  runStatus: string;
  preflightStatus: string;
  warningCount: number;
};

/**
 * The state load (or an action) could not proceed because this browser has
 * no usable device credential: the operator cancelled the enrollment prompt
 * or the server rejected the credential. Distinct from an unreachable
 * server — this must lock the console, never fall back to demo data.
 */
export class CasCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CasCredentialError';
  }
}

export type Gate0AImportIssue = { path?: string; message?: string };

/** Import rejection that carries the server's structured per-field issue list. */
export class Gate0AImportError extends Error {
  issues: Gate0AImportIssue[];
  constructor(message: string, issues: Gate0AImportIssue[]) {
    super(message);
    this.name = 'Gate0AImportError';
    this.issues = issues;
  }
}

export type KernelStatus = 'INACTIVE' | 'ACTIVE_UNACKED' | 'ACTIVE_ACKED' | 'RESOLVED';

export type KernelEvent = {
  id: string;
  type: string;
  priority: Priority;
  time: string;
  detail: string;
};

export type OutboxItem = {
  id: string;
  transport: 'SMS' | 'XMPP' | 'WHATSAPP' | 'EMAIL';
  state: 'QUEUED' | 'PROCESSING' | 'FAILED' | 'SENT' | 'DEAD_LETTER' | 'WITHDRAWN';
  priority: 'P1' | 'P2';
  attempts: number;
  lastError: string | null;
  /** Where a SENT delivery was accepted: 'dev-sink' (built-in test inbox —
   *  simulated, no real provider), the provider identity for gateway
   *  deliveries, or 'handset-sim' when the handset sent it over its own SIM. */
  deliveredTo: string | null;
  terminal: boolean;
};

export type IncidentLocation = {
  latitude: number;
  longitude: number;
  accuracyM: number;
  /** ISO timestamp; the console renders its age so a stale fix is never read as current. */
  capturedAt: string;
};

export type EvidenceItem = {
  id: string;
  kind: 'audio' | 'photo' | 'video';
  contentType: string;
  sizeBytes: number;
  sequence: number;
  /** Which lens captured a photo/video clip; null for audio and older uploads. */
  camera: 'front' | 'back' | null;
  /** Device-reported capture start; null when the handset did not supply one. */
  capturedAt: string | null;
  uploadedAt: string;
  requestId: string | null;
};
export type ActiveIncident = {
  id: string;
  status: KernelStatus;
  /** The server serializes the incident's priority with the state payload. */
  priority: Priority;
  triggerCount: number;
  createdAt: string;
  /** Null when the alert went out before the handset had any position fix. */
  location: IncidentLocation | null;
  events: KernelEvent[];
  outbox: OutboxItem[];
  /** Bounded clips captured on the handset for this incident (metadata only). */
  evidence: EvidenceItem[];
  /** Responder-requested captures and their measured outcomes. */
  captureRequests: CaptureRequestItem[];
};

export type IncidentDetailSummary = {
  id: string;
  status: KernelStatus;
  priority: Priority;
  triggerCount: number;
  createdAt: string;
};

/**
 * Any incident's evidence list plus its append-only journal, from
 * GET /api/cas/incidents/:id/evidence. /cas/state carries evidence only for
 * the latest incident; this is the browse-any-past-alert payload.
 */
export type IncidentDetail = {
  incident: IncidentDetailSummary;
  evidence: EvidenceItem[];
  events: KernelEvent[];
};

type FieldTestState = {
  gates: Gate[];
  setup: SetupItem[];
  incidents: Incident[];
  activeIncident: ActiveIncident | null;
  fieldRun: FieldRun;
};

type FieldTestContextValue = FieldTestState & {
  updateGateStatus: (id: string, status: GateStatus) => void;
  toggleSetupItem: (id: string) => void;
  runTestIncident: () => void;
  recordObservation: (id: string, observation: GateObservation) => void;
  importGate0AReport: (reportText: string) => Promise<Gate0AImportSummary>;
  updateFieldRun: (changes: Partial<Omit<FieldRun, 'observations'>>) => void;
  finalizeDecision: (decision: ReadinessDecision) => void;
  triggerKernel: () => void;
  acknowledgeKernel: () => void;
  resolveKernel: () => void;
  requeueOutboxItem: (id: string, reason?: string) => Promise<void>;
  requestCapture: (kind: 'audio' | 'photo' | 'video') => Promise<void>;
  /**
   * Loads any incident's evidence list and journal (not just the latest
   * one's, which /cas/state carries) for the past-alert evidence browser.
   */
  loadIncidentDetail: (incidentId: string) => Promise<IncidentDetail>;
  /**
   * Permanently deletes one evidence clip (its bytes and listing entry) and
   * journals the deletion on its incident; reloads state so the latest
   * incident's panel and timeline reflect it.
   */
  deleteEvidence: (evidenceId: string) => Promise<void>;
  resetDemo: () => void;
  /**
   * Set when the server's state response did not match this console's
   * contract: the app replaces every screen with the mismatch surface
   * instead of rendering partial/garbage (or demo) data.
   */
  stateIssue: string | null;
  /** Retries the state load after a stateIssue; clears it on success. */
  retryStateLoad: () => void;
  /**
   * Set when a state load — or any credentialed action mid-session —
   * discovers this browser has no usable device credential (enrollment
   * prompt cancelled, credential rejected, or credential revoked
   * mid-session): the console locks behind a signed-out surface instead of
   * showing any incident data — least of all the demo seed.
   */
  authLock: string | null;
  /** Re-opens the enrollment dialog and retries the state load. */
  unlockConsole: () => void;
  /**
   * Signs this browser out: clears the stored device credential (both the
   * session and the kept-signed-in copy) and reloads, which lands on the
   * enrollment dialog. Server-side revocation of a lost device stays in the
   * device-credentials management panel.
   */
  signOutConsole: () => void;
  /**
   * True from sign-out until a state load has authenticated with a fresh
   * credential: the shell shows only a blank signed-out backdrop (with the
   * enrollment dialog on top), never the previous session's screens.
   */
  signedOut: boolean;
  /**
   * True only when the visible state is the built-in demo seed because the
   * server itself was unreachable; the shell labels it as demo/offline data.
   */
  offlineDemo: boolean;
};
const initialGates: Gate[] = [
  {
    id: 'proxy-launch',
    index: '01',
    name: 'Proxy Launch',
    short: 'Cover app → alert surface',
    status: 'partial',
    criterion: 'A hardware shortcut or approved entry path must reach the alert surface on the stock Pixel without an observable dead end.',
    evidence: ['Pixel 11 is the approved physical target; no physical launch has been recorded yet.', 'The Pixel 8a/API 35 emulator remains simulation-only evidence.'],
    nextAction: 'Exercise the chosen shortcut three times while the device is locked.',
    owner: 'Operator',
  },
  {
    id: 'sms-behavior',
    index: '02',
    name: 'SMS Behavior',
    short: 'Recipient delivery path',
    status: 'verified',
    criterion: 'An SMS can be composed to the configured recipient set and its send / failure state can be observed.',
    evidence: ['Outbound test message observed at 14:06 UTC.', 'Two configured recipients acknowledged receipt.'],
    nextAction: 'Repeat with the device in a low-signal area and record the failure state.',
    owner: 'Operator',
  },
  {
    id: 'persistence',
    index: '03',
    name: 'Persistence',
    short: 'State after interruption',
    status: 'partial',
    criterion: 'The alert state and the minimum event record must remain inspectable after lock, app backgrounding, and process interruption.',
    evidence: ['Alert state survives screen lock.', 'Process restart evidence is not attached to this run.'],
    nextAction: 'Force-stop the cover app, relaunch, and compare the preserved event timestamp.',
    owner: 'Operator',
  },
  {
    id: 'location',
    index: '04',
    name: 'Location',
    short: 'Location fix availability',
    status: 'verified',
    criterion: 'A recent location fix can be requested with an explicit permission state and a measurable age / accuracy result.',
    evidence: ['Permission state: granted while in use.', 'Fix observed: 14:08 UTC · 18 m reported accuracy.'],
    nextAction: 'Record a second fix after moving 100 m; note time-to-fix and accuracy.',
    owner: 'Operator',
  },
  {
    id: 'observer-inspection',
    index: '05',
    name: 'Observer Inspection',
    short: 'Evidence can be reviewed',
    status: 'blocked',
    criterion: 'An observer can inspect the alert attempt, delivery outcome, and location result without relying on hidden application state.',
    evidence: ['No observer inspection view is implemented in the prototype.', 'Evidence labels and timestamps are defined for handoff.'],
    nextAction: 'Define the observer surface and capture one end-to-end inspection record.',
    owner: 'Handoff',
  },
];

const initialSetup: SetupItem[] = [
  { id: 'cover-app', label: 'Cover app selected', detail: 'Choose the benign app that will host the entry path on the managed Pixel.', group: 'Device surface', complete: true, mode: 'owner' },
  { id: 'recipients', label: 'Recipients confirmed', detail: 'Verify names and numbers for the small test recipient set.', group: 'Delivery', complete: true, mode: 'owner' },
  { id: 'sim', label: 'Test SIM present', detail: 'Confirm the Pixel has the intended SIM, service, and enough balance for SMS tests.', group: 'Connectivity', complete: true, mode: 'owner' },
  { id: 'xmpp', label: 'XMPP endpoint noted', detail: 'Record the test endpoint and account owner. Connectivity is not measured by this console.', group: 'Connectivity', complete: false, mode: 'owner' },
  { id: 'location', label: 'Location permission checked', detail: 'Confirm the stock Android permission state before requesting a fix.', group: 'Device surface', complete: true, mode: 'measured' },
  { id: 'shortcut', label: 'Shortcut path exercised', detail: 'Run the selected hardware or launcher shortcut while locked and unlocked.', group: 'Entry path', complete: false, mode: 'measured' },
  { id: 'test-mode', label: 'Test mode understood', detail: 'All recipients know that TEST events are local feasibility records, not live alerts.', group: 'Run control', complete: false, mode: 'owner' },
];

const initialIncidents: Incident[] = [
  { id: 'inc-1408', priority: 'P1', time: '14:08:12', title: 'Alert surface reached', detail: 'Operator entered the alert surface from the managed Pixel.', state: 'Observed', source: 'Local test path', sample: true },
  { id: 'inc-1408-sms', priority: 'P2', time: '14:08:18', title: 'SMS send acknowledged', detail: 'Two recipient sends returned an observable success state.', state: 'Observed', source: 'SMS transport', sample: true },
  { id: 'inc-1408-location', priority: 'P2', time: '14:08:31', title: 'Location fix attached', detail: 'Recent fix returned with 18 m reported accuracy.', state: 'Observed', source: 'Stock location provider', sample: true },
  { id: 'inc-1409', priority: 'P3', time: '14:09:02', title: 'Observer record pending', detail: 'No inspection surface is available yet for a second operator.', state: 'Blocked', source: 'Handoff review', sample: true },
];

const initialFieldRun: FieldRun = {
  deviceModel: 'Google Pixel 11',
  androidVersion: 'Stock Android (enter version)',
  build: '',
  operator: '',
  startedAt: '',
  decision: 'no-go',
  observations: {},
};
const initialState: FieldTestState = {
  gates: initialGates,
  setup: initialSetup,
  incidents: initialIncidents,
  activeIncident: null,
  fieldRun: initialFieldRun,
};

const FieldTestContext = createContext<FieldTestContextValue | null>(null);

/**
 * Monotonic authentication generation. Sign-out (or any credential
 * teardown) bumps it, and every state-applying callback captures it before
 * its request and compares after: a response from before the teardown is
 * stale and must be ignored, or a held in-flight response from the previous
 * session could re-apply old data, clear the lock, and re-open a console
 * whose credential stores are empty.
 */
let casAuthGeneration = 0;

export function FieldTestProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<FieldTestState>(initialState);
  const [stateIssue, setStateIssue] = useState<string | null>(null);
  const [authLock, setAuthLock] = useState<string | null>(null);
  const [offlineDemo, setOfflineDemo] = useState(false);
  // True from the moment the operator signs this browser out until a fresh
  // credential has actually authenticated a state load. While set, the shell
  // replaces every route with a blank signed-out backdrop — the enrollment
  // dialog opens on top of it — so no previously rendered screen (responders,
  // incident data) stays visible or interactive behind the dialog, and no
  // late in-flight response can re-expose it.
  const [signedOut, setSignedOut] = useState(false);

  // A cancelled or rejected credential locks the console (never demo data);
  // only a genuinely unreachable server falls back to the demo seed, and
  // that state is labeled as offline demo data by the shell.
  const lockForCredential = (message: string) => { setOfflineDemo(false); setAuthLock(message); };
  const routeLoadFailure = (error: unknown) => {
    applyLoadFailure(
      error,
      setStateIssue,
      lockForCredential,
      () => { setAuthLock(null); setState(initialState); setOfflineDemo(true); },
    );
  };

  useEffect(() => {
    let cancelled = false;
    const generation = casAuthGeneration;
    const load = async () => {
      try {
        // State reads are credential-gated like mutations: the first load of
        // a session asks for the enrollment credential and this browser
        // enrolls its own revocable device credential before anything is read.
        let response = await casAuthedFetch('/api/cas/state');
        if (!response.ok) throw new Error('Unable to load durable state');
        // The response is validated against the console's mirror of the
        // server contract before any of it is applied: a drifted server
        // (stale deployment, mixed environments) raises the mismatch
        // surface instead of rendering partial/garbage data.
        let remote = parseCasStateResponse(await response.json());
        if (remote.gates.length === 0 && remote.setup.length === 0) {
          // Seeding is a credentialed mutation: on a fresh server the
          // operator is asked for the alert credential before anything is
          // written, exactly like the incident actions.
          await casAuthedFetch('/api/cas/bootstrap', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ gates: initialGates, setup: initialSetup }),
          });
          response = await casAuthedFetch('/api/cas/state');
          remote = parseCasStateResponse(await response.json());
        }
        if (!cancelled && generation === casAuthGeneration) {
          setState({ ...remote, fieldRun: initialState.fieldRun });
          setStateIssue(null);
          setAuthLock(null);
          setOfflineDemo(false);
        }
      } catch (error) {
        if (!cancelled && generation === casAuthGeneration) routeLoadFailure(error);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, []);

  const reload = async () => {
    const generation = casAuthGeneration;
    const response = await casAuthedFetch('/api/cas/state');
    if (!response.ok) throw new Error('Unable to reload durable state');
    const remote = parseCasStateResponse(await response.json());
    // Ignore a response whose request predates a sign-out: the credential
    // it used is gone, and applying it would unseal the console without a
    // fresh sign-in.
    if (generation !== casAuthGeneration) return;
    setState((current) => ({ ...remote, fieldRun: current.fieldRun }));
    setStateIssue(null);
    setAuthLock(null);
    setOfflineDemo(false);
    // A state load authenticated by a fresh credential: only now may the
    // console come back after sign-out.
    setSignedOut(false);
  };

  // Any action whose reload hits a drifted server raises the same mismatch
  // surface as the initial load; a mid-session credential loss (e.g. the
  // lost-phone revoke flow) locks the console instead of leaving the
  // last-loaded — now stale — incident data on screen behind a transient
  // alert. Other action errors keep their existing alert behavior.
  const handleActionError = (error: unknown) => {
    applyActionFailure(error, setStateIssue, lockForCredential, reportAuthError);
  };

  const value = useMemo<FieldTestContextValue>(() => ({
    ...state,
    updateGateStatus: (id, nextStatus) => { void casAuthedFetch(`/api/cas/gates/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: nextStatus }) }).then(reload).catch(handleActionError); },
    recordObservation: (id, observation) => setState((current) => ({
      ...current,
      fieldRun: { ...current.fieldRun, observations: { ...current.fieldRun.observations, [id]: observation }, decision: 'pending' },
      gates: current.gates.map((gate) => gate.id === id ? {
        ...gate,
        status: observation.result === 'pass' ? 'verified' : observation.result === 'fail' ? 'blocked' : 'partial',
      } : gate),
    })),
    importGate0AReport: (reportText) => lockOnCredentialFailure((async () => {
      let report: unknown;
      try {
        report = JSON.parse(reportText);
      } catch {
        throw new Error('The selected file is not valid JSON.');
      }
      if (!report || typeof report !== 'object' || Array.isArray(report)) {
        throw new Error('The selected file must contain a Gate 0A JSON report.');
      }
      const response = await casAuthedFetch('/api/cas/gate0a/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(report),
      });
      const body = await response.json() as {
        error?: string;
        issues?: { path?: string; message?: string }[];
        observation?: GateObservation;
        summary?: Gate0AImportSummary;
      };
      if (!response.ok) {
        const issues = body.issues ?? [];
        const reason = body.error || 'Gate 0A report was rejected.';
        // The server error embeds only the top issues; the structured list
        // carries every reported failing field for the gates panel to render.
        throw new Gate0AImportError(reason, issues);
      }
      const observation = body.observation;
      if (!observation) throw new Error('Gate 0A report was accepted without an observation.');
      setState((current) => ({
        ...current,
        fieldRun: {
          ...current.fieldRun,
          observations: { ...current.fieldRun.observations, 'proxy-launch': observation },
          decision: 'pending',
        },
        gates: current.gates.map((gate) => gate.id === 'proxy-launch'
          ? { ...gate, status: 'partial' }
          : gate),
      }));
      if (!body.summary) throw new Error('Gate 0A report was accepted without classification.');
      return body.summary;
    })(), lockForCredential),
    updateFieldRun: (changes) => setState((current) => ({ ...current, fieldRun: { ...current.fieldRun, ...changes } })),
    finalizeDecision: (decision) => setState((current) => ({
      ...current,
      fieldRun: { ...current.fieldRun, decision, startedAt: current.fieldRun.startedAt || new Date().toISOString() },
    })),
    toggleSetupItem: (id) => { const item = state.setup.find((entry) => entry.id === id); if (item) void casAuthedFetch(`/api/cas/setup/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ complete: !item.complete }) }).then(reload).catch(handleActionError); },
    runTestIncident: () => { void casAuthedFetch('/api/cas/incidents/test', { method: 'POST' }).then(reload).catch(handleActionError); },
    triggerKernel: () => { void casAuthedFetch('/api/cas/incidents/trigger', { method: 'POST' }).then(reload).catch(handleActionError); },
    acknowledgeKernel: () => { if (state.activeIncident) void casAuthedFetch(`/api/cas/incidents/${state.activeIncident.id}/ack`, { method: 'POST' }).then(reload).catch(handleActionError); },
    resolveKernel: () => { if (state.activeIncident) void casAuthedFetch(`/api/cas/incidents/${state.activeIncident.id}/resolve`, { method: 'POST' }).then(reload).catch(handleActionError); },
    // Promise-returning actions hand operational rejections to their caller
    // for inline display, but a credential failure — from the action's own
    // fetch or from its reload — must lock the console no matter how the
    // caller handles the error, or the stale incident data stays on screen.
    requeueOutboxItem: (id, reason) => lockOnCredentialFailure((async () => {
      const response = await casAuthedFetch(`/api/cas/outbox/${id}/requeue`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reason ? { reason } : {}) });
      if (!response.ok) {
        // Surface the server's rejection (e.g. a note that looks like a
        // credential) so the responder can rephrase instead of retrying blind.
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error || `Re-queue was rejected (${response.status}).`);
      }
      await reload();
    })(), lockForCredential),
    requestCapture: (kind) => lockOnCredentialFailure((async () => {
      if (!state.activeIncident) throw new Error('No active incident to capture evidence for.');
      const response = await casAuthedFetch(`/api/cas/incidents/${state.activeIncident.id}/capture-requests`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind }) });
      if (!response.ok) {
        // Surface the server's rejection (e.g. the policy toggle for this
        // kind is off or already start-on-trigger) instead of failing silent.
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error || `Capture request was rejected (${response.status}).`);
      }
      await reload();
    })(), lockForCredential),
    loadIncidentDetail: (incidentId) => lockOnCredentialFailure((async () => {
      const response = await casAuthedFetch(`/api/cas/incidents/${encodeURIComponent(incidentId)}/evidence`);
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error || `The incident's evidence could not be loaded (${response.status}).`);
      try {
        return parseCasIncidentDetailResponse(body);
      } catch (error) {
        // A detail payload this console cannot parse is the same
        // server/console version mismatch as a drifted state response:
        // raise the shared mismatch surface instead of rendering
        // partial/garbage data.
        if (error instanceof CasStateShapeError) setStateIssue(error.message);
        throw error;
      }
    })(), lockForCredential),
    deleteEvidence: (evidenceId) => lockOnCredentialFailure((async () => {
      const response = await casAuthedFetch(`/api/cas/evidence/${encodeURIComponent(evidenceId)}`, { method: 'DELETE' });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error || `Delete was rejected (${response.status}).`);
      }
      // Refresh the latest incident's panel and timeline so the deletion
      // and its journal entry show without a manual reload.
      await reload();
    })(), lockForCredential),
    resetDemo: () => { void reload().catch(handleActionError); },
    stateIssue,
    retryStateLoad: () => { void reload().catch(routeLoadFailure); },
    authLock,
    // The retry re-opens the enrollment dialog: a cancelled/rejected
    // credential leaves no stored token, so casAuthedFetch asks again.
    unlockConsole: () => { void reload().catch(routeLoadFailure); },
    // Sign-out forgets this browser's credential, bumps the auth generation
    // (invalidating every in-flight request from the previous session), and
    // reloads: with nothing stored, the reload's first credentialed read
    // lands on the enrollment dialog, and a cancellation there locks the
    // console behind the signed-out surface. The signedOut gate unmounts
    // every route (and its locally cached data) immediately and keeps the
    // shell hidden until a state load belonging to the NEW generation has
    // authenticated — neither a slow or rejected enrollment nor a stale
    // in-flight response can re-expose the previous session's screens.
    signOutConsole: () => {
      clearStoredDeviceToken();
      casAuthGeneration += 1;
      setState(initialState);
      setSignedOut(true);
      setAuthLock(null);
      setStateIssue(null);
      void reload().catch(routeLoadFailure);
    },
    signedOut,
    offlineDemo,
  }), [state, stateIssue, authLock, signedOut, offlineDemo]);

  return (
    <FieldTestContext.Provider value={value}>
      {/* The in-app enrollment dialog the data layer opens when this browser
          has no usable device credential. */}
      <DeviceEnrollmentDialog />
      {children}
    </FieldTestContext.Provider>
  );
}

export function useFieldTest() {
  const context = useContext(FieldTestContext);
  if (!context) throw new Error('useFieldTest must be used inside FieldTestProvider');
  return context;
}

export type FieldRun = {
  deviceModel: string;
  androidVersion: string;
  build: string;
  operator: string;
  startedAt: string;
  decision: ReadinessDecision;
  observations: Record<string, GateObservation>;
};

export type ReadinessDecision = 'pending' | 'go' | 'no-go';

// Exported for the configuration pages (responders / alert text) and the
// incident view's evidence downloads, which call their own endpoints with
// the same enrolled-credential flow.

export async function casAuthedFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const token = await ensureDeviceToken();
  if (!token) throw new CasCredentialError('An enrolled device credential is required for this action.');
  const response = await fetch(input, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  if (response.status === 401) {
    // Revoked or unknown credential: drop it from both storages so the next
    // action re-enrolls (a kept-signed-in browser is no exception).
    clearStoredDeviceToken();
    throw new CasCredentialError('The device credential was rejected by the server (revoked or unknown). The next action will ask for the enrollment credential again.');
  }
  return response;
}

// Each console browser enrolls its own revocable device credential: the
// operator enters the shared enrollment credential (the server's
// CAS_ALERT_TOKEN secret) in the in-app enrollment dialog, the browser
// exchanges it at the enrollment endpoint for a per-device token, and only
// that token is kept — session-only by default, or pinned to this browser
// when the operator explicitly opts in — and presented on requests. A lost
// laptop or shared session is then containable by revoking that one
// credential, and every journaled mutation names the console that sent it.
async function ensureDeviceToken(): Promise<string> {
  const stored = readStoredDeviceToken() ?? '';
  if (stored) return stored;
  // Concurrent credentialed calls (initial load + a poll landing together)
  // share one dialog instead of racing to open several.
  if (!enrollmentInFlight) {
    enrollmentInFlight = enrollViaDialog().finally(() => { enrollmentInFlight = null; });
  }
  return enrollmentInFlight;
}

let enrollmentInFlight: Promise<string> | null = null;

/**
 * Drives the enrollment dialog until it produces a working device token or
 * the operator gives up. The dialog owns retry: it stays open while the
 * exchange is in flight and shows a rejection inline, so a signed-out
 * console is never re-exposed mid-authentication and a typo never locks
 * the console. A cancellation returns '' so the caller locks the console
 * behind the signed-out surface. There is deliberately no silent
 * re-enrollment path.
 */
async function enrollViaDialog(): Promise<string> {
  let issued = '';
  const exchange: DeviceEnrollmentExchange = async ({ credential, keepSignedIn }) => {
    const response = await fetch('/api/cas/devices/enroll', {
      method: 'POST',
      headers: { authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: `operator-console-${Math.random().toString(16).slice(2, 8)}` }),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      return body.error || 'The enrollment credential was rejected by the server; no device credential was enrolled.';
    }
    const { token } = (await response.json()) as { token?: string };
    if (!token) return 'The server answered the enrollment without a device credential; nothing was stored.';
    storeDeviceToken(token, keepSignedIn);
    issued = token;
    return null;
  };
  const prompt = requestDeviceEnrollment(exchange);
  // No dialog mounted (unit tests, non-UI callers): refuse rather than
  // fall back to a native prompt or an implicit enrollment.
  if (!prompt) return '';
  const enrolled = await prompt;
  return enrolled ? issued : '';
}

function reportAuthError(error: unknown) {
  if (error instanceof Error && error.message.includes('credential')) window.alert(error.message);
}

/**
 * Decides what the console shows when a state load fails. A response the
 * console cannot parse is a server/console version mismatch and must raise
 * the visible mismatch surface. A missing or rejected credential locks the
 * console behind an explicit signed-out surface — falling back to the demo
 * seed in either case would let an operator mistake sample records for real
 * durable state. Only a genuinely unreachable server keeps the demo
 * fallback, and that path is labeled as offline demo data by the shell.
 */
export function applyLoadFailure(
  error: unknown,
  raiseMismatch: (message: string) => void,
  lockForCredential: (message: string) => void,
  fallBackToDemo: () => void,
): void {
  if (error instanceof CasStateShapeError) raiseMismatch(error.message);
  else if (error instanceof CasCredentialError) lockForCredential(error.message);
  else fallBackToDemo();
}

/**
 * Decides what the console shows when an action's state reload fails
 * mid-session. A drifted response raises the mismatch surface exactly like
 * the initial load. A credential failure (the enrolled credential was
 * revoked or is gone — e.g. the lost-phone revoke flow) locks the console
 * behind the same signed-out surface as a failed first load: the
 * last-loaded incident data is now unverifiable and must not stay on
 * screen as if current behind only a transient alert. Every other action
 * error keeps the pre-existing reporting behavior.
 */
export function applyActionFailure(
  error: unknown,
  raiseMismatch: (message: string) => void,
  lockForCredential: (message: string) => void,
  reportOther: (error: unknown) => void,
): void {
  if (error instanceof CasStateShapeError) raiseMismatch(error.message);
  else if (error instanceof CasCredentialError) lockForCredential(error.message);
  else reportOther(error);
}

/**
 * Promise-returning actions (outbox requeue, capture request, Gate 0A
 * report import) hand operational rejections to their caller for inline
 * display — but a credential failure means the credential was revoked or
 * lost mid-session, and the console must lock no matter how the caller
 * handles the error, so the last-loaded incident data cannot stay on
 * screen as if current behind an inline message. The error is rethrown so
 * the caller's local reporting still runs (it is simply invisible behind
 * the locked surface).
 */
export async function lockOnCredentialFailure<T>(
  action: Promise<T>,
  lockForCredential: (message: string) => void,
): Promise<T> {
  try {
    return await action;
  } catch (error) {
    if (error instanceof CasCredentialError) lockForCredential(error.message);
    throw error;
  }
}

/**
 * This browser's enrolled device token, or null when it has not enrolled
 * yet (whichever storage the operator chose). Read-only: unlike
 * casAuthedFetch this never prompts, so polling surfaces (outbox status)
 * can wait for the credential instead of opening a second enrollment
 * dialog.
 */
export function casStoredDeviceToken(): string | null {
  return readStoredDeviceToken();
}

export type CaptureRequestItem = {
  id: string;
  kind: 'audio' | 'photo' | 'video';
  state: 'PENDING' | 'STARTED' | 'COMPLETED' | 'FAILED';
  /** Measured reason a request failed (e.g. Android's background-start restriction). */
  detail: string | null;
  createdAt: string;
  updatedAt: string;
};
export type CasDevice = {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

async function enrollmentFetch(enrollmentCredential: string, input: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(input, {
    ...init,
    headers: { authorization: `Bearer ${enrollmentCredential}`, ...(init.headers ?? {}) },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error || `The server rejected the request (${response.status}).`);
  }
  return response;
}

/**
 * Revokes one device credential by id. Requires the enrollment credential;
 * the revocation takes effect on the device's very next request.
 */
export async function revokeCasDevice(enrollmentCredential: string, deviceId: string): Promise<{ id: string; revokedAt: string | null }> {
  const response = await enrollmentFetch(enrollmentCredential, `/api/cas/devices/${encodeURIComponent(deviceId)}/revoke`, { method: 'POST' });
  return (await response.json()) as { id: string; revokedAt: string | null };
}

/** Lists enrolled device credentials. Requires the enrollment credential. */
export async function listCasDevices(enrollmentCredential: string): Promise<CasDevice[]> {
  const response = await enrollmentFetch(enrollmentCredential, '/api/cas/devices');
  const body = await response.json() as { devices?: CasDevice[] };
  if (!Array.isArray(body.devices)) throw new Error('The server returned an unexpected device list.');
  return body.devices;
}
