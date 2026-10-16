import { type Dirent, closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, relative } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { AuditLane } from '@mmbridge/aps';
import { expandGlob } from './aps-collect-probe.js';
import { sessionModel } from './aps-lanes.js';
import { importAps } from './helpers.js';

/** A subagent transcript written to within this many minutes may still be running (APS audit D3). */
export const DEFAULT_OMP_LIVE_MIN = 10;
const TAIL_BYTES = 64 * 1024;
/** Subagent transcripts sit in `<root>/<cwd-slug>/<parent-session>/` and nest one directory per spawning subagent. */
const MAX_SUBAGENT_DEPTH = 4;

export type OmpSessionState = 'working' | 'idle' | 'parked' | 'unknown';

/** Same root as the pointer-mode `session_ref` glob (`ompSessionGlob`). */
export function ompSessionsRoot(): string {
  return join(homedir(), '.omp', 'agent', 'sessions');
}

/** First (`from: 'head'`) or last `bytes` of a file; null when unreadable. */
function readSlice(file: string, bytes: number, from: 'head' | 'tail'): string | null {
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    const size = statSync(file).size;
    const start = from === 'head' ? 0 : Math.max(0, size - bytes);
    const buffer = Buffer.alloc(Math.min(bytes, size - start));
    const read = readSync(fd, buffer, 0, buffer.length, start);
    return buffer.subarray(0, read).toString('utf8');
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/**
 * Turn state from the transcript tail: `session_exit` = parked (idle TTL), an assistant turn that ended
 * (`stop`/`error`/`aborted`) = idle, anything later (tool call, tool result, incoming message) = working.
 */
export function ompSessionState(file: string): OmpSessionState {
  const tail = readSlice(file, TAIL_BYTES, 'tail');
  if (tail === null) return 'unknown';
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry: { type?: unknown; customType?: unknown; message?: { role?: unknown; stopReason?: unknown } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // The first tail line is usually cut mid-record.
    }
    if (entry.type === 'custom' && entry.customType === 'session_exit') return 'parked';
    if (entry.type === 'message' && entry.message?.role === 'assistant') {
      const stop = entry.message.stopReason;
      return stop === 'stop' || stop === 'error' || stop === 'aborted' ? 'idle' : 'working';
    }
    if (entry.type === 'message' || entry.type === 'custom' || entry.type === 'custom_message') return 'working';
  }
  return 'unknown';
}

function sessionCwd(file: string): string | null {
  const head = readSlice(file, 8 * 1024, 'head') ?? '';
  for (const line of head.split('\n').slice(0, 4)) {
    try {
      const entry = JSON.parse(line) as { type?: unknown; cwd?: unknown };
      if (entry.type === 'session' && typeof entry.cwd === 'string') return entry.cwd;
    } catch {}
  }
  return null;
}

function entries(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Every subagent transcript (any `.jsonl` inside a parent session directory) modified at or after `since`.
 * `_`-prefixed names are omp-internal sessions (`__advisor`), not task lanes.
 */
export function recentSubagentSessions(root: string, since: number): Array<{ file: string; mtime: number }> {
  const found: Array<{ file: string; mtime: number }> = [];
  for (const slug of entries(root)) {
    if (!slug.isDirectory()) continue;
    for (const parent of entries(join(root, slug.name))) {
      if (!parent.isDirectory()) continue;
      const pending: Array<[string, number]> = [[join(root, slug.name, parent.name), 1]];
      for (let next = pending.pop(); next; next = pending.pop()) {
        const [dir, depth] = next;
        for (const entry of entries(dir)) {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) {
            if (depth < MAX_SUBAGENT_DEPTH) pending.push([path, depth + 1]);
            continue;
          }
          if (!entry.isFile() || !entry.name.endsWith('.jsonl') || /^[._]/.test(entry.name)) continue;
          try {
            const mtime = statSync(path).mtimeMs;
            if (mtime >= since) found.push({ file: path, mtime });
          } catch {}
        }
      }
    }
  }
  return found.sort((a, b) => a.file.localeCompare(b.file));
}

/** Transcripts owned by a live ledger run: its `session_ref` file, or every match of a pointer-mode glob. */
export function recordedSessionFiles(db: DatabaseSync): Set<string> {
  const files = new Set<string>();
  if (Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0) < 2) return files;
  const rows = db
    .prepare(
      `SELECT session_ref FROM v_run_current
      WHERE status IN ('intent','launched','reported') AND session_ref IS NOT NULL AND session_ref <> ''`,
    )
    .all() as unknown as Array<{ session_ref: string }>;
  for (const { session_ref: ref } of rows) {
    if (ref.includes('*')) for (const path of expandGlob(ref)) files.add(path);
    else if (ref.endsWith('.jsonl')) files.add(ref);
  }
  return files;
}

/**
 * D3: omp task subagents still working (transcript written within `liveMs`, turn not ended) whose transcript
 * no live run owns. They count as working lanes and are reported `recorded: false` (UNRECORDED_LANE).
 */
export async function ompSessionLanes(
  recorded: ReadonlySet<string>,
  now: number,
  liveMs: number,
  root = ompSessionsRoot(),
): Promise<AuditLane[]> {
  const aps = await importAps();
  const lanes: AuditLane[] = [];
  for (const { file, mtime: lastOutputAt } of recentSubagentSessions(root, now - liveMs)) {
    if (recorded.has(file) || ompSessionState(file) !== 'working') continue;
    const model = sessionModel(file);
    const { tier, provider } = aps.classifyModel(model);
    lanes.push({
      id: `omp:${basename(file, '.jsonl')}`,
      source: 'omp',
      harness: 'omp',
      model,
      tier,
      provider,
      status: 'working',
      cwd: sessionCwd(file),
      title: relative(root, file),
      cardKind: null,
      cardKindSource: null,
      lastOutputAt,
      finished: false,
      agentId: null,
      recorded: false,
    });
  }
  return lanes;
}
