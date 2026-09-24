import type { Attempt } from './dispatch.js';
import type { TokenUsage } from './omp-worker.js';

/**
 * What a live view needs from a running dispatch. omp's RPC stream is far richer (every thinking delta repeats the
 * whole partial message), so only these cross the seam.
 */
export type WorkerEvent =
  /** The dispatch is starting this model (after skipping or failing the ones before it). */
  | { type: 'model'; provider: string; modelId: string }
  /** A model in the chain finished, failed, or was skipped for a cooldown. */
  | { type: 'attempt'; attempt: Attempt }
  | { type: 'ready'; readyMs: number }
  | { type: 'text'; delta: string }
  | { type: 'tool_start'; name: string; intent?: string }
  | { type: 'tool_end'; name: string; isError: boolean }
  /** Usage of one model turn — omp reports it per turn, not cumulatively. */
  | { type: 'turn'; usage: TokenUsage; costUsd: number };

export type WorkerEventListener = (event: WorkerEvent) => void;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Usage of one omp assistant message, or undefined when it carries none. */
export function usageOf(message: unknown): { usage: TokenUsage; costUsd?: number } | undefined {
  if (!isRecord(message) || !isRecord(message.usage)) return undefined;
  const { usage } = message;
  const cost = isRecord(usage.cost) && typeof usage.cost.total === 'number' ? usage.cost.total : undefined;
  return {
    usage: {
      input: count(usage.input),
      output: count(usage.output),
      cacheRead: count(usage.cacheRead),
      cacheWrite: count(usage.cacheWrite),
    },
    ...(cost !== undefined ? { costUsd: cost } : {}),
  };
}

/** Maps one omp RPC event to the view-level event it implies, if any. */
export function toWorkerEvent(event: unknown): WorkerEvent | undefined {
  if (!isRecord(event)) return undefined;
  switch (event.type) {
    case 'message_update': {
      const update = event.assistantMessageEvent;
      if (isRecord(update) && update.type === 'text_delta' && typeof update.delta === 'string') {
        return { type: 'text', delta: update.delta };
      }
      return undefined;
    }
    case 'tool_execution_start':
      return {
        type: 'tool_start',
        name: String(event.toolName),
        ...(typeof event.intent === 'string' ? { intent: event.intent } : {}),
      };
    case 'tool_execution_end':
      return { type: 'tool_end', name: String(event.toolName), isError: event.isError === true };
    case 'turn_end': {
      const turn = usageOf(event.message);
      return turn ? { type: 'turn', usage: turn.usage, costUsd: turn.costUsd ?? 0 } : undefined;
    }
    default:
      return undefined;
  }
}
