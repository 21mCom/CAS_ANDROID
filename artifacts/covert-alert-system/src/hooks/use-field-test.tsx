import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

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
  transport: 'SMS' | 'XMPP';
  state: 'QUEUED' | 'DISPATCHING' | 'SENT' | 'WAITING';
  priority: 'P1' | 'P2';
};

export type ActiveIncident = {
  id: string;
  status: KernelStatus;
  triggerCount: number;
  createdAt: string;
  events: KernelEvent[];
  outbox: OutboxItem[];
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
  updateFieldRun: (changes: Partial<Omit<FieldRun, 'observations'>>) => void;
  finalizeDecision: (decision: ReadinessDecision) => void;
  triggerKernel: () => void;
  acknowledgeKernel: () => void;
  resolveKernel: () => void;
  resetDemo: () => void;
};

const STORAGE_KEY = 'cas-milestone-0-state';

const initialGates: Gate[] = [
  {
    id: 'proxy-launch',
    index: '01',
    name: 'Proxy Launch',
    short: 'Cover app → alert surface',
    status: 'partial',
    criterion: 'A hardware shortcut or approved entry path must reach the alert surface on the stock Pixel without an observable dead end.',
    evidence: ['Cover app opens from the launcher on Pixel 8a.', 'Shortcut path has not been exercised in this run.'],
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
  deviceModel: 'Google Pixel 8a',
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

export function FieldTestProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<FieldTestState>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      return stored ? { ...initialState, ...JSON.parse(stored) } : initialState;
    } catch {
      return initialState;
    }
  });

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state]);

  const value = useMemo<FieldTestContextValue>(() => ({
    ...state,
    updateGateStatus: (id, status) => setState((current) => ({
      ...current,
      gates: current.gates.map((gate) => gate.id === id ? { ...gate, status } : gate),
    })),
    recordObservation: (id, observation) => setState((current) => ({
      ...current,
      fieldRun: { ...current.fieldRun, observations: { ...current.fieldRun.observations, [id]: observation }, decision: 'pending' },
      gates: current.gates.map((gate) => gate.id === id ? {
        ...gate,
        status: observation.result === 'pass' ? 'verified' : observation.result === 'fail' ? 'blocked' : 'partial',
      } : gate),
    })),
    updateFieldRun: (changes) => setState((current) => ({ ...current, fieldRun: { ...current.fieldRun, ...changes } })),
    finalizeDecision: (decision) => setState((current) => ({
      ...current,
      fieldRun: { ...current.fieldRun, decision, startedAt: current.fieldRun.startedAt || new Date().toISOString() },
    })),
    toggleSetupItem: (id) => setState((current) => ({
      ...current,
      setup: current.setup.map((item) => item.id === id ? { ...item, complete: !item.complete } : item),
    })),
    runTestIncident: () => setState((current) => {
      const now = new Date();
      const stamp = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
      const incident: Incident = {
        id: `test-${now.getTime()}`,
        priority: 'P3',
        time: stamp,
        title: 'TEST incident recorded',
        detail: 'Local test action completed. No message was sent and no device action was triggered.',
        state: 'Local only',
        source: 'Console control',
        sample: false,
      };
      return { ...current, incidents: [incident, ...current.incidents] };
    }),
    triggerKernel: () => setState((current) => {
      const now = new Date();
      const stamp = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
      if (current.activeIncident && current.activeIncident.status !== 'RESOLVED') {
        const retrigger: KernelEvent = {
          id: `event-retrigger-${now.getTime()}`,
          type: 'TRIGGER_REUSED',
          priority: 'P1',
          time: stamp,
          detail: 'Repeat trigger folded into the existing active incident; timers and outbox were not reset.',
        };
        return {
          ...current,
          activeIncident: {
            ...current.activeIncident,
            triggerCount: current.activeIncident.triggerCount + 1,
            events: [...current.activeIncident.events, retrigger],
          },
        };
      }
      const id = `sim-${now.getTime()}`;
      const events: KernelEvent[] = [
        { id: `${id}-received`, type: 'TRIGGER_RECEIVED', priority: 'P1', time: stamp, detail: 'Durable trigger received and incident identity committed.' },
        { id: `${id}-queued`, type: 'P1_QUEUED', priority: 'P1', time: stamp, detail: 'SMS and XMPP outbox items queued independently.' },
      ];
      return {
        ...current,
        activeIncident: {
          id,
          status: 'ACTIVE_UNACKED',
          triggerCount: 1,
          createdAt: stamp,
          events,
          outbox: [
            { id: `${id}-sms`, transport: 'SMS', state: 'QUEUED', priority: 'P1' },
            { id: `${id}-xmpp`, transport: 'XMPP', state: 'QUEUED', priority: 'P1' },
          ],
        },
        incidents: [{
          id: `${id}-log`,
          priority: 'P1',
          time: stamp,
          title: 'Kernel simulation activated',
          detail: 'One active incident created. No SMS or XMPP message was sent.',
          state: 'Simulated',
          source: 'Kernel simulator',
          sample: false,
        }, ...current.incidents],
      };
    }),
    acknowledgeKernel: () => setState((current) => {
      if (!current.activeIncident || current.activeIncident.status !== 'ACTIVE_UNACKED') return current;
      const now = new Date();
      const stamp = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
      return {
        ...current,
        activeIncident: {
          ...current.activeIncident,
          status: 'ACTIVE_ACKED',
          events: [...current.activeIncident.events, {
            id: `event-ack-${now.getTime()}`,
            type: 'RESPONDER_ACK',
            priority: 'P1',
            time: stamp,
            detail: 'Simulated responder acknowledgement accepted; location would continue.',
          }],
        },
      };
    }),
    resolveKernel: () => setState((current) => {
      if (!current.activeIncident || current.activeIncident.status !== 'ACTIVE_ACKED') return current;
      const now = new Date();
      const stamp = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
      return {
        ...current,
        activeIncident: {
          ...current.activeIncident,
          status: 'RESOLVED',
          events: [...current.activeIncident.events, {
            id: `event-resolve-${now.getTime()}`,
            type: 'RESPONDER_RESOLVE',
            priority: 'P1',
            time: stamp,
            detail: 'Simulated authenticated resolution appended to the journal.',
          }],
        },
      };
    }),
    resetDemo: () => setState(initialState),
  }), [state]);

  return <FieldTestContext.Provider value={value}>{children}</FieldTestContext.Provider>;
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
