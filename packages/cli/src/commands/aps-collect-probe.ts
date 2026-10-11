import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Row } from '@mmbridge/aps';
import { closePane, confirmPaneEnded, getPane } from './aps-herdr.js';

export interface ProbeOptions {
  ompSessionDir?: string;
}

export interface LaunchInfo {
  detail: Record<string, unknown>;
  at: string;
}

export type ProbeEvidence = Record<string, unknown> & { probe: string };

export function launchInfo(db: DatabaseSync, runId: string): LaunchInfo | null {
  const row = db
    .prepare("SELECT detail_json, at FROM run_events WHERE run_id=? AND status='launched' ORDER BY id DESC LIMIT 1")
    .get(runId);
  if (!row) return null;
  let detail: unknown = null;
  try {
    detail = JSON.parse(String(row.detail_json));
  } catch {}
  return {
    detail: detail && typeof detail === 'object' && !Array.isArray(detail) ? (detail as Record<string, unknown>) : {},
    at: String(row.at),
  };
}

export function probeKind(detail: Record<string, unknown>): 'pane' | 'pid' | 'yield' | null {
  if (typeof detail.pane_id === 'string' && detail.pane_id.length > 0) return 'pane';
  if (typeof detail.pid === 'number' && Number.isInteger(detail.pid)) return 'pid';
  if (typeof detail.omp_id === 'string' && detail.omp_id.length > 0) return 'yield';
  return null;
}

function recordedTerminal(detail: Record<string, unknown>): string | null {
  return typeof detail.terminal_id === 'string' && detail.terminal_id ? detail.terminal_id : null;
}

async function paneEnded(detail: Record<string, unknown>): Promise<ProbeEvidence | null> {
  const pane = String(detail.pane_id);
  const terminal = recordedTerminal(detail);
  const state = await getPane(pane);
  if (state.state === 'present' && (terminal === null || state.pane.terminal_id === terminal)) return null;
  return { ...(await confirmPaneEnded(pane, terminal)), closed_by_collect: false };
}

async function paneClose(detail: Record<string, unknown>): Promise<ProbeEvidence> {
  const pane = String(detail.pane_id);
  const terminal = recordedTerminal(detail);
  const state = await getPane(pane);
  if (state.state === 'present' && (terminal === null || state.pane.terminal_id === terminal)) {
    if (state.pane.agent_status === 'working')
      throw new Error(`APS-H06: agent in pane ${pane} is still working; not closing`);
    await closePane(pane);
    return { ...(await confirmPaneEnded(pane, terminal)), closed_by_collect: true };
  }
  return { ...(await confirmPaneEnded(pane, terminal)), closed_by_collect: false };
}

function pidEnded(packet: string, pid: number): ProbeEvidence | null {
  const path = join(packet, 'exit');
  if (existsSync(path)) return { probe: 'exit-file', path, code: readFileSync(path, 'utf8').trim(), pid };
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return { probe: 'exit-file', path, code: null, pid };
  }
  return null;
}

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function expandGlob(pattern: string): string[] {
  const segments = pattern.split('/').filter((segment) => segment.length > 0);
  let paths = [pattern.startsWith('/') ? '/' : '.'];
  for (const segment of segments) {
    if (!segment.includes('*')) {
      paths = paths.map((path) => join(path, segment));
      continue;
    }
    const rx = new RegExp(`^${segment.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')}$`);
    const next: string[] = [];
    for (const path of paths) {
      let names: string[];
      try {
        names = readdirSync(path);
      } catch {
        continue;
      }
      for (const name of names) if (rx.test(name)) next.push(join(path, name));
    }
    paths = next;
  }
  return paths;
}

function yieldPaths(
  detail: Record<string, unknown>,
  opts: ProbeOptions,
): { dirs: string[]; expected: string; ompId: string } {
  const ompId = String(detail.omp_id);
  if (opts.ompSessionDir)
    return { dirs: [opts.ompSessionDir], expected: join(opts.ompSessionDir, `${ompId}.md`), ompId };
  const sessionRef = typeof detail.session_ref === 'string' ? detail.session_ref : '';
  const expected = sessionRef.endsWith('.jsonl')
    ? `${sessionRef.slice(0, -'.jsonl'.length)}.md`
    : sessionRef || `${ompId}.md`;
  const dirs = [
    ...new Set(
      (sessionRef.includes('*') ? expandGlob(sessionRef) : sessionRef ? [sessionRef] : [])
        .filter(isFile)
        .map((path) => dirname(path)),
    ),
  ];
  return { dirs, expected, ompId };
}

function yieldEnded(launch: LaunchInfo, opts: ProbeOptions): ProbeEvidence | null {
  const { dirs, expected, ompId } = yieldPaths(launch.detail, opts);
  if (dirs.length > 1)
    throw new Error(
      `APS-H08: omp task ${ompId} has no yield output at ${expected} (ambiguous; pass --omp-session-dir)`,
    );
  const dir = dirs.length === 1 ? dirs[0] : undefined;
  const path = dir === undefined ? expected : join(dir, `${ompId}.md`);
  if (dir !== undefined && existsSync(path)) {
    const stat = statSync(path);
    if (stat.mtimeMs >= new Date(launch.at).getTime())
      return { probe: 'omp-yield', path, mtime: stat.mtime.toISOString() };
  }
  return null;
}

export async function sessionEnded(run: Row, launch: LaunchInfo, opts: ProbeOptions): Promise<ProbeEvidence | null> {
  const kind = probeKind(launch.detail);
  if (kind === 'pane') return paneEnded(launch.detail);
  if (kind === 'pid') return pidEnded(String(run.packet_dir), Number(launch.detail.pid));
  if (kind === 'yield') return yieldEnded(launch, opts);
  return null;
}

export async function sessionClose(run: Row, launch: LaunchInfo, opts: ProbeOptions): Promise<ProbeEvidence> {
  const kind = probeKind(launch.detail);
  const runId = String(run.run_id);
  if (kind === 'pane') return paneClose(launch.detail);
  if (kind === 'pid') {
    const evidence = pidEnded(String(run.packet_dir), Number(launch.detail.pid));
    if (!evidence) throw new Error(`APS-H07: process ${Number(launch.detail.pid)} for run ${runId} is still running`);
    return evidence;
  }
  if (kind === 'yield') {
    const evidence = yieldEnded(launch, opts);
    if (!evidence) {
      const { dirs, expected, ompId } = yieldPaths(launch.detail, opts);
      const path = dirs.length === 1 ? join(dirs[0], `${ompId}.md`) : expected;
      throw new Error(`APS-H08: omp task ${ompId} has no yield output at ${path}`);
    }
    return evidence;
  }
  throw new Error(`run ${runId} has no recorded session fields`);
}

export function summarize(evidence: ProbeEvidence): string {
  if (evidence.probe === 'herdr pane get')
    return `herdr pane get exit ${String(evidence.exit)}${evidence.closed_by_collect ? ' (closed by collect)' : ''}`;
  if (evidence.probe === 'exit-file')
    return evidence.code == null ? `pid ${String(evidence.pid)} ended` : `exit file code ${String(evidence.code)}`;
  if (evidence.probe === 'omp-yield') return `yield ${String(evidence.path)}`;
  return String(evidence.probe);
}
