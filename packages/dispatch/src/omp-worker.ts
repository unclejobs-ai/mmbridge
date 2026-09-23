import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { ModelRef } from './roles.js';

/** Flags that cut omp cold start from ~42s to ~1.6s (measured 2026-09-23). */
const LEAN_FLAGS = ['--no-session', '--no-extensions', '--no-skills', '--no-rules', '--no-lsp', '--no-title'];
/**
 * omp would otherwise swap to its own fallback model on quota/permission errors (and report success),
 * bypassing mmbridge's role chain, deny list, and cooldowns. mmbridge owns fallback, so a worker never does.
 */
const NO_INTERNAL_FALLBACK = 'retry:\n  modelFallback: false\n  usageAwareFallback: false\n';
const STDERR_TAIL_BYTES = 2048;
/** Extension UI requests that block the turn until the host answers (others, like setWidget, are fire-and-forget). */
const BLOCKING_UI_METHODS = new Set(['select', 'confirm', 'input', 'editor']);
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const PROVIDER_WAIT = /requested (\d+)ms wait/;

export class OmpTimeoutError extends Error {}

export interface OmpPromptInput {
  model: ModelRef;
  prompt: string;
  cwd: string;
  timeoutMs?: number;
  binary?: string;
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface OmpPromptResult {
  text: string;
  provider: string;
  modelId: string;
  stopReason: string;
  errorMessage?: string;
  /** How long the provider asked us to wait before retrying (quota/rate limits). */
  waitMs?: number;
  usage?: TokenUsage;
  costUsd?: number;
  readyMs: number;
  totalMs: number;
}

interface AssistantMessage {
  role: 'assistant';
  content: unknown[];
  provider?: string;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  usage?: TokenUsage & { cost?: { total?: number } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAssistantMessage(value: unknown): value is AssistantMessage {
  return isRecord(value) && value.role === 'assistant' && Array.isArray(value.content);
}

function textOf(message: AssistantMessage): string {
  return message.content
    .filter((part): part is { type: 'text'; text: string } => isRecord(part) && part.type === 'text')
    .map((part) => part.text)
    .join('');
}

/** Runs one prompt on one model through `omp --mode rpc` and returns the final assistant turn. */
export function runOmpPrompt(input: OmpPromptInput): Promise<OmpPromptResult> {
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  const overlay = join(tmpdir(), 'mmbridge-omp-worker.yml');
  writeFileSync(overlay, NO_INTERNAL_FALLBACK);
  const args = ['--mode', 'rpc', '--no-tools', ...LEAN_FLAGS, '--config', overlay, '--cwd', input.cwd];
  const child = spawn(input.binary ?? 'omp', args, {
    cwd: input.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderrTail = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES);
  });
  const send = (command: Record<string, unknown>) => child.stdin.write(`${JSON.stringify(command)}\n`);

  return new Promise<OmpPromptResult>((resolve, reject) => {
    let readyMs = -1;
    let waitMs: number | undefined;
    let settled = false;
    const finish = (outcome: { result: OmpPromptResult } | { error: Error }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if ('result' in outcome) resolve(outcome.result);
      else reject(outcome.error);
    };
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(
      () => finish({ error: new OmpTimeoutError(`omp worker timed out after ${timeoutMs}ms`) }),
      timeoutMs,
    );

    child.on('error', (err) => finish({ error: new Error(`Failed to start omp: ${err.message}`) }));
    child.on('exit', (code) =>
      finish({ error: new Error(`omp exited (code ${code}) before finishing. stderr: ${stderrTail.trim()}`) }),
    );

    createInterface({ input: child.stdout }).on('line', (line) => {
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        finish({ error: new Error(`omp wrote non-JSON to the RPC channel: ${line.slice(0, 200)}`) });
        return;
      }
      if (!isRecord(event)) return;

      if (event.type === 'ready') {
        readyMs = elapsed();
        send({ id: 'model', type: 'set_model', provider: input.model.provider, modelId: input.model.modelId });
        return;
      }
      // omp asks the host before spending anything (e.g. "Spend a saved Codex rate-limit reset?") and waits
      // forever for the answer. A dispatched worker has no human behind it, so it always declines.
      if (event.type === 'extension_ui_request' && BLOCKING_UI_METHODS.has(String(event.method))) {
        send({ type: 'extension_ui_response', id: event.id, cancelled: true });
        return;
      }
      if (event.type === 'response' && event.success !== true) {
        finish({ error: new Error(`omp rejected ${String(event.command)}: ${String(event.error)}`) });
        return;
      }
      if (event.type === 'response' && event.command === 'set_model') {
        if (input.model.thinking) {
          send({ id: 'thinking', type: 'set_thinking_level', level: input.model.thinking });
        } else {
          send({ id: 'prompt', type: 'prompt', message: input.prompt });
        }
        return;
      }
      if (event.type === 'response' && event.command === 'set_thinking_level') {
        send({ id: 'prompt', type: 'prompt', message: input.prompt });
        return;
      }
      if (event.type === 'auto_retry_end' && typeof event.finalError === 'string') {
        const match = PROVIDER_WAIT.exec(event.finalError);
        if (match) waitMs = Number(match[1]);
        return;
      }
      if (event.type === 'agent_end' && Array.isArray(event.messages)) {
        const last = event.messages.filter(isAssistantMessage).at(-1);
        if (!last) {
          finish({ error: new Error('omp finished without an assistant message') });
          return;
        }
        const { cost, ...usage } = last.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        finish({
          result: {
            text: textOf(last),
            provider: last.provider ?? input.model.provider,
            modelId: last.model ?? input.model.modelId,
            stopReason: last.stopReason ?? 'unknown',
            ...(last.errorMessage ? { errorMessage: last.errorMessage } : {}),
            ...(waitMs !== undefined ? { waitMs } : {}),
            usage: {
              input: usage.input,
              output: usage.output,
              cacheRead: usage.cacheRead,
              cacheWrite: usage.cacheWrite,
            },
            ...(typeof cost?.total === 'number' ? { costUsd: cost.total } : {}),
            readyMs,
            totalMs: elapsed(),
          },
        });
      }
    });
  });
}
