import type { Attempt, Role, WorkerEvent } from '@mmbridge/dispatch';

/** Tool calls shown per lane (DESIGN.md live trace feed: max 3 lines). */
const TRACE_LINES = 3;

export type LaneStatus = 'starting' | 'running' | 'done' | 'error';

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
  errorMessage?: string;
}

/** Worker events plus how the dispatch call itself ended. */
export type LaneEvent =
  | WorkerEvent
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
  };
}

export function reduceLane(lane: LaneState, event: LaneEvent): LaneState {
  switch (event.type) {
    case 'model':
      return { ...lane, model: `${event.provider}/${event.modelId}`, status: 'starting', text: '' };
    case 'attempt':
      return event.attempt.outcome === 'ok' ? lane : { ...lane, passed: [...lane.passed, event.attempt] };
    case 'ready':
      return { ...lane, status: 'running', readyMs: event.readyMs };
    case 'text':
      return { ...lane, text: lane.text + event.delta };
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
        tokens: { input: lane.tokens.input + event.usage.input, output: lane.tokens.output + event.usage.output },
        costUsd: lane.costUsd + event.costUsd,
      };
    case 'done':
      return {
        ...lane,
        status: event.stopReason === 'error' ? 'error' : 'done',
        endedAt: event.at,
        ...(event.errorMessage ? { errorMessage: event.errorMessage } : {}),
      };
    case 'failed':
      return { ...lane, status: 'error', endedAt: event.at, errorMessage: event.message };
  }
}

/** One lane per dispatch; workers run outside React and push events here. */
export interface HubStore {
  getSnapshot: () => LaneState[];
  subscribe: (listener: () => void) => () => void;
  apply: (index: number, event: LaneEvent) => void;
}

export function createHubStore(lanes: LaneState[]): HubStore {
  let snapshot = lanes;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    apply: (index, event) => {
      snapshot = snapshot.map((lane, i) => (i === index ? reduceLane(lane, event) : lane));
      for (const listener of listeners) listener();
    },
  };
}
