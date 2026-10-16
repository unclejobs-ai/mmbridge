/**
 * omp post hook: records spawned task lanes in the APS ledger (opt-in; see README.md).
 *
 * On every successful `task` tool result, each spawned task whose assignment carries an `APS-CARD: <card>` line gets
 * `mmbridge aps lane start <card> --omp-id <task id> --lane <name> --omp-session-dir <parent session dir>`.
 * Fail-silent: it never changes the tool result, never throws, and logs to APS_HOOK_LOG.
 * Node built-ins only and erasable type syntax only, so omp can load it as plain TypeScript.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

interface TaskItem {
  index?: number;
  id?: string;
  task?: string;
  assignment?: string;
}

interface ToolResultEvent {
  toolName?: string;
  isError?: boolean;
  input?: { task?: string; tasks?: Array<{ task?: string }> };
  details?: { progress?: TaskItem[]; results?: TaskItem[] };
}

interface HookContext {
  sessionManager?: { getSessionFile?: () => string | undefined };
}

interface HookApi {
  on(event: 'tool_result', handler: (event: ToolResultEvent, ctx: HookContext) => void): void;
}

const CARD_LINE = /^[ \t]*APS-CARD:[ \t]*([A-Za-z0-9][A-Za-z0-9._-]*)[ \t]*$/m;
const LANE_LINE = /^[ \t]*APS-LANE:[ \t]*([A-Za-z0-9._@-]{1,64})[ \t]*$/m;
const WORKTREE_LINE = /^[ \t]*APS-WORKTREE:[ \t]*(\/\S*)[ \t]*$/m;
const TASK_ID = /^[A-Za-z0-9._@-]{1,64}$/;

export interface LaneStart {
  card: string;
  ompId: string;
  lane: string;
  worktree?: string;
}

/** Lane starts requested by one `task` tool result: tasks without an `APS-CARD:` line are left alone. */
export function laneStarts(event: ToolResultEvent): LaneStart[] {
  const items = event.details?.progress?.length ? event.details.progress : (event.details?.results ?? []);
  const starts: LaneStart[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const ompId = item.id;
    if (typeof ompId !== 'string' || !TASK_ID.test(ompId) || seen.has(ompId)) continue;
    const text =
      item.assignment ??
      item.task ??
      (typeof item.index === 'number' ? event.input?.tasks?.[item.index]?.task : undefined) ??
      event.input?.task ??
      '';
    const card = CARD_LINE.exec(text)?.[1];
    if (!card) continue;
    seen.add(ompId);
    const worktree = WORKTREE_LINE.exec(text)?.[1];
    starts.push({
      card,
      ompId,
      lane: LANE_LINE.exec(text)?.[1] ?? ompId,
      ...(worktree && isAbsolute(worktree) ? { worktree } : {}),
    });
  }
  return starts;
}

function command(): string[] {
  const configured = process.env.APS_HOOK_CMD;
  if (!configured) return ['mmbridge'];
  const argv: unknown = JSON.parse(configured);
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((part) => typeof part === 'string'))
    throw new Error('APS_HOOK_CMD must be a JSON array of strings');
  return argv;
}

export default function apsTaskHook(pi: HookApi): void {
  pi.on('tool_result', (event, ctx) => {
    if (event.toolName !== 'task' || event.isError) return;
    const log = process.env.APS_HOOK_LOG || join(homedir(), 'ss-work', 'squads', 'Reports', 'aps-omp-hook.log');
    try {
      const starts = laneStarts(event);
      if (starts.length === 0) return;
      const sessionFile = ctx.sessionManager?.getSessionFile?.();
      const sessionDir = sessionFile?.endsWith('.jsonl') ? sessionFile.slice(0, -'.jsonl'.length) : undefined;
      const [bin, ...prefix] = command();
      mkdirSync(dirname(log), { recursive: true });
      for (const start of starts) {
        const argv = [
          ...prefix,
          'aps',
          'lane',
          'start',
          start.card,
          '--omp-id',
          start.ompId,
          '--lane',
          start.lane,
          '--json',
          ...(sessionDir ? ['--omp-session-dir', sessionDir] : []),
          ...(start.worktree ? ['--worktree', start.worktree] : []),
          ...(process.env.APS_HOOK_DB ? ['--db', process.env.APS_HOOK_DB] : []),
        ];
        appendFileSync(log, `${new Date().toISOString()} spawn ${JSON.stringify([bin, ...argv])}\n`);
        const fd = openSync(log, 'a');
        try {
          const child = spawn(bin, argv, { detached: true, stdio: ['ignore', fd, fd], timeout: 30_000 });
          child.on('error', () => {});
          child.unref();
        } finally {
          closeSync(fd);
        }
      }
    } catch {
      // Fail-silent by contract: the ledger is optional for the session that runs this hook.
    }
  });
}
