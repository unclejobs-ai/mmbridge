import { type Dirent, closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { AuditLane, VisionVerdict } from '@mmbridge/aps';
import { parseHerdrEnvelope } from './aps-herdr.js';
import { importAps, importCore } from './helpers.js';

/** Devin panes do not expose their model; SWE-2 Max is the configured default (MODEL-ROUTING §0). */
export const DEVIN_DEFAULT_MODEL = 'devin/swe-2-max';
const TAIL_BYTES = 256 * 1024;

interface HerdrAgent {
  pane_id: string;
  agent?: string;
  agent_status?: string;
  cwd?: string;
  terminal_title_stripped?: string;
  agent_session?: { value?: string };
}

interface LedgerRunRow {
  run_id: string;
  card_id: string;
  harness: string;
  model: string;
  worktree: string;
  packet_dir: string;
  status: string;
  pane_id: string | null;
  pid: number | null;
  session_ref: string | null;
  card_kind: string;
}

function mtime(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/** Last model an omp session actually used: last assistant `provider/model`, else last `model_change`. */
export function sessionModel(file: string): string | null {
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    const size = statSync(file).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line.includes('"model')) continue;
      try {
        const event = JSON.parse(line) as { type?: string; model?: unknown; message?: Record<string, unknown> };
        const message = event.message;
        if (message && typeof message.provider === 'string' && typeof message.model === 'string')
          return `${message.provider}/${message.model}`;
        if (event.type === 'model_change' && typeof event.model === 'string') return event.model;
      } catch {
        // The first line of the tail chunk is usually cut mid-record.
      }
    }
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Newest omp session transcript under a headless packet's `--session-dir` (omp nests one level per cwd). */
export function newestSession(dir: string): string | null {
  let best: string | null = null;
  let bestAt = Number.NEGATIVE_INFINITY;
  const pending: Array<[string, number]> = [[dir, 0]];
  for (let next = pending.pop(); next; next = pending.pop()) {
    const [current, depth] = next;
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory() && depth < 2) pending.push([path, depth + 1]);
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const at = mtime(path) ?? Number.NEGATIVE_INFINITY;
      if (at > bestAt) [best, bestAt] = [path, at];
    }
  }
  return best;
}

function pidAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function herdrLanes(): Promise<AuditLane[]> {
  const aps = await importAps();
  const core = await importCore();
  const raw = await core.runCommand('herdr', ['agent', 'list'], { timeoutMs: 15_000 });
  const envelope = parseHerdrEnvelope(raw);
  const agents = (envelope.result as { agents?: HerdrAgent[] } | undefined)?.agents;
  if (!raw.ok || envelope.error !== undefined || !Array.isArray(agents)) throw new Error('herdr agent list failed');
  return agents.map((agent) => {
    const session = agent.agent_session?.value ?? null;
    const model =
      agent.agent === 'devin' ? DEVIN_DEFAULT_MODEL : agent.agent === 'omp' && session ? sessionModel(session) : null;
    const { tier, provider } = aps.classifyModel(model);
    const title = agent.terminal_title_stripped ?? null;
    const status = agent.agent_status;
    const mech = aps.mechanicalTitle(title);
    return {
      id: agent.pane_id,
      source: 'herdr',
      harness: agent.agent ?? 'unknown',
      model,
      tier,
      provider,
      status:
        status === 'working' || status === 'idle' || status === 'done' || status === 'blocked' ? status : 'unknown',
      cwd: agent.cwd ?? null,
      title,
      cardKind: mech ? 'mech' : null,
      cardKindSource: mech ? 'title' : null,
      lastOutputAt: session ? mtime(session) : null,
      finished: status === 'done',
      recorded: null,
    } satisfies AuditLane;
  });
}

/** Live ledger runs (intent/launched). A run hosted in a listed herdr pane enriches that lane instead. */
export async function ledgerLanes(db: DatabaseSync, herdr: AuditLane[]): Promise<AuditLane[]> {
  const aps = await importAps();
  const rows = db
    .prepare(
      `SELECT r.run_id,r.card_id,r.harness,r.model,r.worktree,r.packet_dir,r.status,r.pane_id,r.pid,r.session_ref,
      c.kind AS card_kind FROM v_run_current r JOIN cards c ON c.id=r.card_id WHERE r.status IN ('intent','launched')`,
    )
    .all() as unknown as LedgerRunRow[];
  const lanes: AuditLane[] = [];
  for (const row of rows) {
    const pane = row.pane_id ? herdr.find((lane) => lane.id === row.pane_id) : undefined;
    if (pane) {
      pane.cardKind = row.card_kind;
      pane.cardKindSource = 'ledger';
      pane.title = `${row.card_id} ${pane.title ?? ''}`.trim();
      continue;
    }
    const session = row.harness === 'omp' && row.session_ref ? newestSession(row.session_ref) : null;
    const model = (session && sessionModel(session)) || (row.harness === 'devin' ? `devin/${row.model}` : row.model);
    const { tier, provider } = aps.classifyModel(model);
    const exited = existsSync(join(row.packet_dir, 'exit'));
    const reported = existsSync(join(row.packet_dir, 'report.json'));
    const outputs = [session, join(row.packet_dir, 'out.log'), join(row.packet_dir, 'out.json')]
      .map((path) => (path ? mtime(path) : null))
      .filter((at): at is number => at !== null);
    const alive = row.status === 'launched' && !exited && (row.pid === null || pidAlive(Number(row.pid)));
    lanes.push({
      id: row.run_id,
      source: 'ledger',
      harness: row.harness,
      model,
      tier,
      provider,
      status: reported || exited ? 'done' : alive ? 'working' : 'unknown',
      cwd: row.worktree,
      title: row.card_id,
      cardKind: row.card_kind,
      cardKindSource: 'ledger',
      lastOutputAt: outputs.length ? Math.max(...outputs) : null,
      finished: reported || exited,
      recorded: true,
    });
  }
  return lanes;
}

/** Vision verdicts recorded in the last 24 h with the auditor's model and layer. */
export function recentVisionVerdicts(db: DatabaseSync, now: number): VisionVerdict[] {
  return db
    .prepare(
      `SELECT v.card_id AS card, coalesce(a.model,'') AS auditorModel, a.layer AS auditorLayer
      FROM vision_audits v JOIN agents a ON a.id=v.auditor WHERE v.at >= ?`,
    )
    .all(new Date(now - 86_400_000).toISOString()) as unknown as VisionVerdict[];
}

/** Live run pids (`v_run_current.pid`) for intent/launched/reported. Empty below schema v2. */
export function liveRunPids(db: DatabaseSync): number[] {
  if (Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0) < 2) return [];
  const rows = db
    .prepare(`SELECT pid FROM v_run_current WHERE status IN ('intent','launched','reported') AND pid IS NOT NULL`)
    .all() as unknown as Array<{ pid: number | string }>;
  const pids: number[] = [];
  for (const row of rows) {
    const pid = Number(row.pid);
    if (Number.isInteger(pid) && pid > 0) pids.push(pid);
  }
  return pids;
}

/**
 * Herdr panes are recorded when a non-closed agent `herdr_pane` or a live run `pane_id` matches.
 * Ledger lanes are always recorded. Process lanes are left as constructed. No-op below schema v1.
 */
export function applyLedgerRecording(lanes: AuditLane[], db: DatabaseSync): void {
  const version = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
  if (version < 1) return;
  const agentPanes = paneSet(
    db
      .prepare(
        `SELECT herdr_pane AS id FROM agents
        WHERE status <> 'closed' AND herdr_pane IS NOT NULL AND trim(herdr_pane) <> ''`,
      )
      .all() as unknown as Array<{ id: unknown }>,
  );
  const runPanes =
    version < 2
      ? new Set<string>()
      : paneSet(
          db
            .prepare(
              `SELECT pane_id AS id FROM v_run_current
              WHERE status IN ('intent','launched','reported') AND pane_id IS NOT NULL AND pane_id <> ''`,
            )
            .all() as unknown as Array<{ id: unknown }>,
        );
  for (const lane of lanes) {
    if (lane.source === 'ledger') lane.recorded = true;
    else if (lane.source === 'herdr') lane.recorded = agentPanes.has(lane.id) || runPanes.has(lane.id);
  }
}

function paneSet(rows: Array<{ id: unknown }>): Set<string> {
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.id === null || row.id === undefined) continue;
    const id = String(row.id);
    if (id !== '') ids.add(id);
  }
  return ids;
}
