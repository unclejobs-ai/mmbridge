import { closeSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { basename, relative } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { AuditLane } from '@mmbridge/aps';
import { sessionModel } from './aps-lanes.js';
import { ompSessionsRoot, patternTranscripts, subagentTranscripts } from './aps-omp-transcripts.js';
import { importAps } from './helpers.js';

/** A subagent transcript written to within this many minutes may still be running (APS audit D3). */
export const DEFAULT_OMP_LIVE_MIN = 10;
const TAIL_BYTES = 64 * 1024;

export type OmpSessionState = 'working' | 'idle' | 'parked' | 'unknown';

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

/** Task transcripts (see `subagentTranscripts`) modified at or after `since`. */
export function recentSubagentSessions(root: string, since: number): Array<{ file: string; mtime: number }> {
  const found: Array<{ file: string; mtime: number }> = [];
  for (const file of subagentTranscripts(root)) {
    try {
      const mtime = statSync(file).mtimeMs;
      if (mtime >= since) found.push({ file, mtime });
    } catch {}
  }
  return found;
}

/**
 * Real paths of the transcripts tied to a live ledger run: its exact `session_ref`, or the single match of a
 * pointer-mode pattern. An ambiguous pattern ties no file, so its candidates stay visible as unrecorded.
 */
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
    const matches = ref.includes('*') ? patternTranscripts(ref) : ref.endsWith('.jsonl') ? [ref] : [];
    if (matches.length !== 1) continue;
    try {
      files.add(realpathSync(matches[0]));
    } catch {}
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
    if (ompSessionState(file) !== 'working') continue;
    let real = file;
    try {
      real = realpathSync(file);
    } catch {}
    if (recorded.has(real)) continue;
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
