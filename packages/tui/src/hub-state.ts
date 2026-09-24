import type { Attempt, Role, WorkerControl, WorkerEvent } from '@mmbridge/dispatch';

/** Tool calls shown per lane (DESIGN.md live trace feed: max 3 lines). */
const TRACE_LINES = 3;

export type LaneStatus = 'starting' | 'running' | 'aborting' | 'done' | 'aborted' | 'error';

export interface TraceLine {
  name: string;
  intent?: string;
  state: 'running' | 'ok' | 'error';
}

export interface LaneState {
  role: Role;
  status: LaneStatus;
  startedAt: number;
  endedAt?: number;
  /** `provider/model` currently running (or that answered). */
  model?: string;
  readyMs?: number;
  /** Earlier models in the chain that were skipped or failed. */
  passed: Attempt[];
  trace: TraceLine[];
  toolCalls: number;
  tokens: { input: number; output: number };
  costUsd: number;
  text: string;
  /** A model turn ended since the last answer text. */
  turnEnded: boolean;
  /** The last message the user steered this worker with. */
  lastSteer?: string;
  errorMessage?: string;
}

/** Worker events, what the user did to the lane, and how the dispatch call itself ended. */
export type LaneEvent =
  | WorkerEvent
  | { type: 'steer'; message: string }
  | { type: 'abort_requested' }
  | { type: 'done'; at: number; stopReason: string; errorMessage?: string }
  | { type: 'failed'; at: number; message: string };

export function initialLane(role: Role, startedAt: number): LaneState {
  return {
    role,
    status: 'starting',
    startedAt,
    passed: [],
    trace: [],
    toolCalls: 0,
    tokens: { input: 0, output: 0 },
    costUsd: 0,
    text: '',
    turnEnded: false,
  };
}

export function reduceLane(lane: LaneState, event: LaneEvent): LaneState {
  switch (event.type) {
    case 'model':
      return { ...lane, model: `${event.provider}/${event.modelId}`, status: 'starting', text: '' };
    case 'attempt':
      return event.attempt.outcome === 'ok' ? lane : { ...lane, passed: [...lane.passed, event.attempt] };
    case 'ready':
      return { ...lane, status: lane.status === 'aborting' ? 'aborting' : 'running', readyMs: event.readyMs };
    case 'steer':
      return { ...lane, lastSteer: event.message };
    case 'abort_requested':
      return { ...lane, status: 'aborting' };
    case 'text':
      // A later turn (after tool calls or a steer) starts on its own line.
      return {
        ...lane,
        text: lane.text + (lane.turnEnded && lane.text !== '' ? '\n' : '') + event.delta,
        turnEnded: false,
      };
    case 'tool_start': {
      const line: TraceLine = { name: event.name, state: 'running', ...(event.intent ? { intent: event.intent } : {}) };
      return { ...lane, toolCalls: lane.toolCalls + 1, trace: [...lane.trace, line].slice(-TRACE_LINES) };
    }
    case 'tool_end': {
      let index = lane.trace.length - 1;
      while (index >= 0 && !(lane.trace[index]?.name === event.name && lane.trace[index]?.state === 'running')) index--;
      if (index === -1) return lane;
      const trace = lane.trace.map((line, i) =>
        i === index ? { ...line, state: event.isError ? ('error' as const) : ('ok' as const) } : line,
      );
      return { ...lane, trace };
    }
    case 'turn':
      return {
        ...lane,
        turnEnded: true,
        tokens: { input: lane.tokens.input + event.usage.input, output: lane.tokens.output + event.usage.output },
        costUsd: lane.costUsd + event.costUsd,
      };
    case 'done':
      return {
        ...lane,
        status: event.stopReason === 'error' ? 'error' : event.stopReason === 'aborted' ? 'aborted' : 'done',
        endedAt: event.at,
        ...(event.errorMessage ? { errorMessage: event.errorMessage } : {}),
      };
    case 'failed':
      return { ...lane, status: 'error', endedAt: event.at, errorMessage: event.message };
  }
}

export function isLive(lane: LaneState): boolean {
  return lane.status === 'starting' || lane.status === 'running' || lane.status === 'aborting';
}

/** One lane per dispatch; workers run outside React and push events here, and the view steers them through it. */
export interface HubStore {
  getSnapshot: () => LaneState[];
  subscribe: (listener: () => void) => () => void;
  apply: (index: number, event: LaneEvent) => void;
  /** The worker now running in this lane (a fallback starts a new one). */
  setControl: (index: number, control: WorkerControl) => void;
  steer: (index: number, message: string) => void;
  /** Stops the lane's worker; pressed before the worker is up, it is delivered when the worker starts. */
  abort: (index: number) => void;
}

export function createHubStore(lanes: LaneState[]): HubStore {
  let snapshot = lanes;
  const listeners = new Set<() => void>();
  const controls = new Map<number, WorkerControl>();
  const apply = (index: number, event: LaneEvent) => {
    snapshot = snapshot.map((lane, i) => (i === index ? reduceLane(lane, event) : lane));
    for (const listener of listeners) listener();
  };
  const liveLane = (index: number) => {
    const lane = snapshot[index];
    return lane !== undefined && isLive(lane) ? lane : undefined;
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    apply,
    setControl: (index, control) => {
      controls.set(index, control);
      if (snapshot[index]?.status === 'aborting') control.abort();
    },
    steer: (index, message) => {
      const control = controls.get(index);
      if (!liveLane(index) || !control) return;
      control.steer(message);
      apply(index, { type: 'steer', message });
    },
    abort: (index) => {
      if (!liveLane(index)) return;
      controls.get(index)?.abort();
      apply(index, { type: 'abort_requested' });
    },
  };
}
