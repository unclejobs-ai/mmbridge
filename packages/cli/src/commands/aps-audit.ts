import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ApsInputError, type AuditLane, type AuditReport, type VisionVerdict } from '@mmbridge/aps';
import { closePane, confirmPaneEnded } from './aps-herdr.js';
import { applyLedgerRecording, herdrLanes, ledgerLanes, liveRunPids, recentVisionVerdicts } from './aps-lanes.js';
import { DEFAULT_OMP_LIVE_MIN, ompSessionLanes, ompSessionsRoot, recordedSessionFiles } from './aps-omp-lanes.js';
import { probeQuota } from './aps-quota.js';
import { exitWithError, importAps, importCore, jsonOutput } from './helpers.js';

export interface ApsAuditOptions {
  db?: string;
  json?: boolean;
  out?: string;
  quotaJson?: string;
  projectDir?: string;
  herdr?: boolean;
  stallMin?: string;
  /** Minutes before an idle/done open session is IDLE_OPEN. Default 10. */
  idleMin?: string;
  by?: string;
  /** Opt-in: close IDLE_OPEN sessions. Without this flag the audit stays read-only. */
  closeIdle?: boolean;
  ps?: boolean;
  ignorePid?: string;
  /** `--no-omp-sessions` sets false: skip omp subagent transcript discovery (D3). */
  ompSessions?: boolean;
  /** Minutes since the last transcript write for an omp subagent to count as live. Default 10. */
  ompLiveMin?: string;
}

/** Exit code when the audit ran but found violations (distinct from 1 = audit failed). */
export const AUDIT_VIOLATION_EXIT = 4;

export interface IdleCloseRow {
  agent: string;
  pane: string;
  result: string;
}

export interface AuditRun {
  report: AuditReport;
  markdown: string;
  probes: { quotaSource: string | null; ledger: string | null; errors: string[] };
  closed: IdleCloseRow[];
  closeFailed: boolean;
}

function renderAutoClosed(rows: IdleCloseRow[]): string {
  const lines = ['## Auto-closed', ''];
  if (rows.length === 0) lines.push('- none');
  else {
    lines.push('| agent | pane | result |', '| --- | --- | --- |');
    for (const row of rows) {
      const agent = row.agent.replace(/\|/g, '\\|').replace(/[\r\n]/g, ' ');
      const pane = row.pane.replace(/\|/g, '\\|').replace(/[\r\n]/g, ' ');
      const result = row.result.replace(/\|/g, '\\|').replace(/[\r\n]/g, ' ');
      lines.push(`| ${agent} | ${pane} | ${result} |`);
    }
  }
  return `\n\n${lines.join('\n')}`;
}

/** One ledger transaction per lane. A failure is recorded and does not stop the rest. */
async function closeIdleSessions(
  dbPath: string,
  lanes: AuditLane[],
  by: string,
  idleMin: number,
): Promise<{ rows: IdleCloseRow[]; failed: boolean }> {
  const aps = await importAps();
  if (!existsSync(dbPath)) {
    if (lanes.length === 0) return { rows: [], failed: false };
    return {
      failed: true,
      rows: lanes.map((lane) => ({
        agent: lane.agentId ?? '',
        pane: lane.id,
        result: 'failed: ledger missing',
      })),
    };
  }
  const db = aps.openApsDb(dbPath);
  const rows: IdleCloseRow[] = [];
  let failed = false;
  try {
    const manager = aps.getAgent(db, by);
    if (manager.status === 'closed') throw new ApsInputError('--by must name a live manager agent');
    const managerPane = typeof manager.herdr_pane === 'string' && manager.herdr_pane !== '' ? manager.herdr_pane : null;
    for (const lane of lanes) {
      const agent = lane.agentId;
      if (!agent) {
        rows.push({ agent: '', pane: lane.id, result: 'skipped: no open agent' });
        continue;
      }
      if (agent === by || lane.id === managerPane) {
        rows.push({ agent, pane: lane.id, result: 'skipped: acting --by agent' });
        continue;
      }
      try {
        const working = db
          .prepare("SELECT id FROM cards WHERE assignee=? AND state='working' ORDER BY id")
          .all(agent) as unknown as { id: string }[];
        if (working.length > 0) {
          rows.push({
            agent,
            pane: lane.id,
            result: `skipped: working card ${working.map((card) => card.id).join(', ')}`,
          });
          continue;
        }
        // Last check before pane close. A card that becomes working during herdr
        // pane close or confirmPaneEnded still loses the pane; closeSession then
        // refuses and this row is recorded as failed.
        await closePane(lane.id);
        await confirmPaneEnded(lane.id);
        aps.closeSession(db, agent, by, `audit: idle >= ${idleMin}m, auto-closed`, false);
        rows.push({ agent, pane: lane.id, result: 'closed' });
      } catch (error) {
        failed = true;
        rows.push({
          agent,
          pane: lane.id,
          result: `failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  } finally {
    db.close();
  }
  return { rows, failed };
}

/** Herdr lanes + live ledger runs + optional process scan + quota. Read-only unless `--close-idle`. */
export async function runAudit(options: ApsAuditOptions, now = Date.now()): Promise<AuditRun> {
  const ignorePids = parseIgnorePids(options.ignorePid);
  const aps = await importAps();
  const core = await importCore();
  const errors: string[] = [];
  let lanes: AuditLane[] = [];
  if (options.herdr !== false) {
    try {
      lanes = await herdrLanes();
    } catch (error) {
      errors.push(`herdr: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const config = await core.loadConfig(resolve(options.projectDir ?? process.cwd()));
  const dbPath = aps.resolveApsDbPath({ flag: options.db, configPath: config.aps?.dbPath });
  let ledger: string | null = null;
  let visionVerdicts: VisionVerdict[] = [];
  let runPids: number[] = [];
  const ompLiveText = options.ompLiveMin ?? String(DEFAULT_OMP_LIVE_MIN);
  if (!/^[1-9]\d*$/.test(ompLiveText))
    throw new ApsInputError('--omp-live-min must be an integer number of minutes >= 1');
  const ompLiveMs = Number(ompLiveText) * 60_000;
  const scanOmp = options.ompSessions !== false;
  let recordedOmp = new Set<string>();
  if (existsSync(dbPath)) {
    const db = aps.openApsDbReadOnly(dbPath);
    try {
      const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
      if (version >= 2) lanes = [...lanes, ...(await ledgerLanes(db, lanes))];
      else errors.push(`ledger ${dbPath} is schema v${version}: run lanes need v2 (FAC-M12 cutover)`);
      applyLedgerRecording(lanes, db);
      if (version >= 2) runPids = liveRunPids(db);
      visionVerdicts = recentVisionVerdicts(db, now);
      ledger = `${dbPath} (v${version})`;
      if (scanOmp) recordedOmp = recordedSessionFiles(db);
    } finally {
      db.close();
    }
  } else errors.push(`ledger not found at ${dbPath}`);
  let ompProbe = 'skipped';
  if (scanOmp) {
    const root = ompSessionsRoot();
    const omp = await ompSessionLanes(recordedOmp, now, ompLiveMs, root);
    lanes = [...lanes, ...omp];
    ompProbe = `${root} (${omp.length} unrecorded live)`;
  }
  if (options.ps) {
    try {
      lanes = [...lanes, ...aps.lanesFromPs({ ps: await readPs(), runPids, ignorePids, selfPid: process.pid })];
    } catch (error) {
      errors.push(`ps: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const quota = await probeQuota(options.quotaJson, now);
  errors.push(...quota.errors);
  const stallMin = Number(options.stallMin ?? '30');
  const idleText = options.idleMin ?? '10';
  if (!/^[1-9]\d*$/.test(idleText)) {
    throw new ApsInputError('--idle-min must be an integer number of minutes >= 1');
  }
  const idleMin = Number(idleText);
  const report = aps.buildAudit({
    now,
    lanes,
    quota: quota.quota,
    visionVerdicts,
    stallMs: stallMin * 60_000,
    idleMs: idleMin * 60_000,
  });
  let closed: IdleCloseRow[] = [];
  let closeFailed = false;
  if (options.closeIdle) {
    const by = (options.by ?? process.env.APS_AGENT)?.trim();
    if (!by) throw new ApsInputError('--by is required with --close-idle');
    const outcome = await closeIdleSessions(dbPath, report.idleOpen, by, idleMin);
    closed = outcome.rows;
    closeFailed = outcome.failed;
  }
  const footer = [
    '',
    '## Probes',
    '',
    `- quota: ${quota.source ?? 'unavailable'}`,
    `- ledger: ${ledger ?? 'unavailable'}`,
    `- omp sessions: ${ompProbe}`,
    ...errors.map((error) => `- warning: ${error}`),
  ];
  const auto = options.closeIdle ? renderAutoClosed(closed) : '';
  return {
    report,
    markdown: `${aps.renderAuditMarkdown(report).replace(/\n$/, '')}${auto}${footer.join('\n')}\n`,
    probes: { quotaSource: quota.source, ledger, errors },
    closed,
    closeFailed,
  };
}

export async function runApsAuditCommand(options: ApsAuditOptions): Promise<void> {
  let run: AuditRun;
  try {
    run = await runAudit(options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    exitWithError(message, error instanceof ApsInputError ? 2 : 1);
  }
  if (options.out) {
    const out = resolve(options.out);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(`${out}.tmp`, run.markdown);
    renameSync(`${out}.tmp`, out);
  }
  if (options.json) {
    jsonOutput({
      ...run.report,
      probes: run.probes,
      ...(options.closeIdle ? { closed: run.closed } : {}),
    });
  } else process.stdout.write(run.markdown);
  if (run.closeFailed) process.exitCode = 1;
  else if (run.report.violations.length > 0) process.exitCode = AUDIT_VIOLATION_EXIT;
}

function parseIgnorePids(value: string | undefined): number[] {
  if (value === undefined || value.trim() === '') return [];
  const pids: number[] = [];
  for (const part of value.split(',')) {
    const token = part.trim();
    if (token === '') continue;
    if (!/^[1-9]\d*$/.test(token)) throw new Error(`--ignore-pid: invalid pid ${JSON.stringify(token)}`);
    pids.push(Number(token));
  }
  return pids;
}

async function readPs(): Promise<string> {
  const core = await importCore();
  const result = await core.runCommand('ps', ['-axo', 'pid=,ppid=,command='], { timeoutMs: 15_000 });
  if (!result.ok) throw new Error(`ps exited ${result.code}: ${result.stderr.trim() || result.stdout.trim()}`);
  return result.stdout;
}
