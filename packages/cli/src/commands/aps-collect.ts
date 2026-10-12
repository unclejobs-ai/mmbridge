import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { ApsInputError, type Row, type UsageByModel } from '@mmbridge/aps';
import { pidAlive } from './aps-adopt.js';
import {
  type LaunchInfo,
  expandGlob,
  isFile,
  launchInfo,
  probeKind,
  sessionClose,
  sessionEnded,
  summarize,
} from './aps-collect-probe.js';
import { getPane } from './aps-herdr.js';
import { newestSession } from './aps-lanes.js';
import { type ApsCommandOptions, emit, parseDuration, required } from './aps-shared.js';
import { exitWithError, importAps, importCore } from './helpers.js';

export interface ApsCollectOptions extends ApsCommandOptions {
  all?: boolean;
  wait?: string;
  ompSessionDir?: string;
}

export interface CollectRunOptions {
  abandon?: boolean;
  waitMs?: number;
  pollMs?: number;
  ompSessionDir?: string;
}

export interface CollectOutcome {
  card: string;
  run: string | null;
  outcome: 'pending' | 'running' | 'reported' | 'blocked' | 'abandoned';
  code: 0 | 1 | 2 | 3;
  message: string;
  report?: unknown;
  evidence?: unknown;
}

interface WorkerReport {
  run: string;
  card: string;
  attempt: number;
  status: 'DONE' | 'DONE_WITH_CONCERNS' | 'BLOCKED';
  sha: string;
  branch: string;
  pr: string | null;
  files: unknown;
  evidence: unknown;
  risks?: string;
  blocked?: string;
}

type Aps = Awaited<ReturnType<typeof importAps>>;

const DEFAULT_POLL_MS = 5_000;
const ADOPTED_NO_REPORT = 'adopted lane ended without report; record aps report';

/** Adopted lanes stay running while any recorded pid is alive or pane is present. */
async function adoptedLaneRunning(detail: Record<string, unknown>): Promise<boolean> {
  const paneId = typeof detail.pane_id === 'string' && detail.pane_id.length > 0 ? detail.pane_id : null;
  const pid = typeof detail.pid === 'number' && Number.isInteger(detail.pid) ? detail.pid : null;
  if (paneId && (await getPane(paneId)).state === 'present') return true;
  return pid !== null && pidAlive(pid);
}

function readOptional(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function readReport(path: string): WorkerReport {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new ApsInputError(`invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ApsInputError(`${path} must contain a JSON object`);
  const report = value as Record<string, unknown>;
  if (typeof report.status !== 'string' || !['DONE', 'DONE_WITH_CONCERNS', 'BLOCKED'].includes(report.status))
    throw new ApsInputError(`${path} status must be DONE|DONE_WITH_CONCERNS|BLOCKED`);
  if (typeof report.sha !== 'string') throw new ApsInputError(`${path} sha must be a string`);
  if (typeof report.branch !== 'string' || !report.branch.trim())
    throw new ApsInputError(`${path} branch must be a non-empty string`);
  return report as unknown as WorkerReport;
}

async function verifyCommit(run: Row, report: WorkerReport): Promise<void> {
  const core = await importCore();
  const worktree = String(run.worktree);
  const commit = await core.runCommand('git', ['-C', worktree, 'cat-file', '-e', `${report.sha}^{commit}`], {
    timeoutMs: 15_000,
  });
  const ancestor = commit.ok
    ? await core.runCommand('git', ['-C', worktree, 'merge-base', '--is-ancestor', report.sha, report.branch], {
        timeoutMs: 15_000,
      })
    : null;
  if (!commit.ok || !ancestor?.ok || report.branch !== String(run.branch))
    throw new Error(`APS-H09: reported sha ${report.sha} is not a commit on ${report.branch} in ${worktree}`);
}

function transcriptPath(run: Row, launch: LaunchInfo, opts: CollectRunOptions): { file?: string; ambiguous: boolean } {
  const detail = launch.detail;
  const candidates: string[] = [];
  let ambiguous = false;
  if (opts.ompSessionDir && typeof detail.omp_id === 'string')
    candidates.push(join(opts.ompSessionDir, `${detail.omp_id}.jsonl`));
  const ref = typeof detail.session_ref === 'string' ? detail.session_ref : '';
  if (ref.includes('*')) {
    const matches = expandGlob(ref).filter(isFile);
    if (matches.length === 1) candidates.push(matches[0]);
    else if (matches.length > 1) ambiguous = true;
  } else if (ref && typeof detail.pid === 'number') {
    // Headless omp: session_ref is the run's --session-dir; omp nests one directory per cwd.
    const newest = newestSession(ref);
    if (newest) candidates.push(newest);
  } else if (ref) candidates.push(ref);
  return { file: candidates.find(isFile), ambiguous };
}

async function recordUsage(aps: Aps, db: DatabaseSync, run: Row, launch: LaunchInfo, opts: CollectRunOptions) {
  const runId = String(run.run_id);
  const isOmp = run.harness === 'omp' || run.kind === 'omp';
  let file: string | undefined;
  let ambiguous = false;
  let rows: UsageByModel[] = [];
  if (isOmp) {
    ({ file, ambiguous } = transcriptPath(run, launch, opts));
    if (file) {
      try {
        rows = aps.parseOmpUsage(readFileSync(file, 'utf8'));
      } catch {
        file = undefined;
      }
    }
  }
  await aps.commandTransaction(db, async () => {
    if (file && rows.length > 0) {
      for (const row of rows)
        aps.addUsage(db, {
          run_id: runId,
          source: 'omp-jsonl',
          source_ref: file,
          basis: 'actual',
          provider: row.provider,
          model: row.model,
          input_tokens: row.input,
          output_tokens: row.output,
          cache_read_tokens: row.cacheRead,
          cache_write_tokens: row.cacheWrite,
          cost_usd: row.costUsd,
        });
    } else {
      aps.addUsage(db, { run_id: runId, source: 'none', source_ref: runId, basis: 'unknown' });
    }
  });
  if (!isOmp) return;
  if (!file)
    process.stderr.write(
      `[mmbridge] collect ${runId}: ${ambiguous ? 'omp transcript is ambiguous (pass --omp-session-dir)' : 'no readable omp transcript'}; usage recorded as unknown\n`,
    );
  else if (rows.length === 0)
    process.stderr.write(
      `[mmbridge] collect ${runId}: transcript ${file} has no usage rows; usage recorded as unknown\n`,
    );
}

async function collectLiveRun(
  aps: Aps,
  db: DatabaseSync,
  run: Row,
  by: string,
  opts: CollectRunOptions,
): Promise<CollectOutcome> {
  const cardId = String(run.card_id);
  const runId = String(run.run_id);
  const packet = String(run.packet_dir);
  const status = run.status == null ? 'intent' : String(run.status);
  const manager = aps.getAgent(db, by);
  if (manager.status === 'closed') throw new ApsInputError('--by must name a live manager agent');
  if (status === 'intent') return { card: cardId, run: runId, outcome: 'pending', code: 0, message: 'pending' };
  const launch = launchInfo(db, runId);
  if (!launch || !probeKind(launch.detail)) throw new Error(`run ${runId} has no recorded session fields`);
  const reportPath = join(packet, 'report.json');
  if (launch.detail.adopted === true && (await adoptedLaneRunning(launch.detail)))
    return { card: cardId, run: runId, outcome: 'running', code: 0, message: 'running' };
  if (launch.detail.adopted === true && status === 'launched') {
    const stored = db
      .prepare('SELECT * FROM reports WHERE card_id=? AND attempt=? ORDER BY id DESC LIMIT 1')
      .get(cardId, Number(run.attempt));
    if (stored) {
      const reportStatus = String(stored.status);
      await verifyCommit(run, { sha: String(stored.sha), branch: String(stored.branch) } as WorkerReport);
      await aps.commandTransaction(db, async () => {
        aps.addRunEvent(db, runId, reportStatus === 'BLOCKED' ? 'blocked' : 'reported', by, {
          adopted: true,
          report: 'ledger',
        });
      });
      const evidence = await sessionClose(run, launch, opts);
      const summary = summarize(evidence);
      const abandon = reportStatus === 'BLOCKED';
      await aps.commandTransaction(db, async () => {
        aps.closeSession(db, String(run.agent_id), by, `collect ${runId}: ${summary}`, abandon);
        if (!abandon) aps.addRunEvent(db, runId, 'closed', by, { evidence });
      });
      await recordUsage(aps, db, run, launch, opts);
      return {
        card: cardId,
        run: runId,
        outcome: abandon ? 'blocked' : 'reported',
        code: 0,
        message: `collect ${runId}: ${abandon ? 'blocked; card returned to issued' : 'closed_session'}`,
        report: stored,
        evidence,
      };
    }
    if (!existsSync(reportPath)) {
      await aps.commandTransaction(db, async () => {
        aps.addRunEvent(db, runId, 'blocked', by, { adopted: true, message: ADOPTED_NO_REPORT });
      });
      return { card: cardId, run: runId, outcome: 'blocked', code: 0, message: ADOPTED_NO_REPORT };
    }
  }
  let reportStatus: string;
  let report: unknown;

  if (status === 'launched') {
    if (!existsSync(reportPath)) {
      const deadline = Date.now() + (opts.waitMs ?? 0);
      for (;;) {
        const evidence = await sessionEnded(run, launch, opts);
        if (evidence) {
          const summary = summarize(evidence);
          if (opts.abandon) {
            await aps.commandTransaction(db, async () => {
              aps.addRunEvent(db, runId, 'abandoned', by, { evidence });
              aps.closeSession(db, String(run.agent_id), by, `collect ${runId}: ${summary}`, true);
            });
            return {
              card: cardId,
              run: runId,
              outcome: 'abandoned',
              code: 0,
              message: `collect ${runId}: abandoned (${summary})`,
              evidence,
            };
          }
          return {
            card: cardId,
            run: runId,
            outcome: 'pending',
            code: 3,
            message: `APS-H10: session ended without report.json (${summary})`,
            evidence,
          };
        }
        if (!opts.waitMs || Date.now() >= deadline)
          return { card: cardId, run: runId, outcome: 'pending', code: 0, message: 'pending' };
        await delay(Math.min(opts.pollMs ?? DEFAULT_POLL_MS, deadline - Date.now()));
        if (existsSync(reportPath)) break;
      }
    }
    const worker = readReport(reportPath);
    if (worker.run !== runId || worker.card !== cardId || worker.attempt !== Number(run.attempt))
      throw new ApsInputError(`report.json does not match live run ${runId}`);
    await verifyCommit(run, worker);
    reportStatus = worker.status;
    report = worker;
    await aps.commandTransaction(db, async () => {
      aps.recordReport(db, cardId, {
        by_agent: String(run.agent_id),
        recorded_by: by,
        sha: worker.sha,
        branch: worker.branch,
        pr_url: worker.pr ?? null,
        files_json: JSON.stringify(worker.files ?? null),
        evidence_json: JSON.stringify(worker.evidence ?? null),
        risks:
          typeof worker.risks === 'string' ? worker.risks : typeof worker.blocked === 'string' ? worker.blocked : '',
        status: worker.status,
        body_md: readOptional(join(packet, 'report.md')),
      });
      aps.addLink(db, cardId, by, 'handoff', join(packet, 'report.md'));
      if (typeof worker.pr === 'string' && worker.pr) aps.addLink(db, cardId, by, 'pr', worker.pr);
      aps.addRunEvent(db, runId, worker.status === 'BLOCKED' ? 'blocked' : 'reported', by, { report: reportPath });
    });
  } else {
    const stored = db
      .prepare('SELECT status FROM reports WHERE card_id=? AND attempt=? ORDER BY id DESC LIMIT 1')
      .get(cardId, Number(run.attempt));
    reportStatus = stored ? String(stored.status) : 'DONE';
    report = stored;
  }

  const evidence = await sessionClose(run, launch, opts);
  const summary = summarize(evidence);
  const abandon = reportStatus === 'BLOCKED';
  await aps.commandTransaction(db, async () => {
    aps.closeSession(db, String(run.agent_id), by, `collect ${runId}: ${summary}`, abandon);
    if (!abandon) aps.addRunEvent(db, runId, 'closed', by, { evidence });
  });
  await recordUsage(aps, db, run, launch, opts);
  return {
    card: cardId,
    run: runId,
    outcome: abandon ? 'blocked' : 'reported',
    code: 0,
    message: `collect ${runId}: ${abandon ? 'blocked; card returned to issued' : 'closed_session'}`,
    report,
    evidence,
  };
}

export async function collectRun(
  db: DatabaseSync,
  cardId: string,
  by: string,
  opts: CollectRunOptions = {},
): Promise<CollectOutcome> {
  const aps = await importAps();
  let run: Row | undefined;
  try {
    run = aps.getLiveRun(db, cardId);
    if (!run) return { card: cardId, run: null, outcome: 'pending', code: 2, message: 'no live run' };
    return await collectLiveRun(aps, db, run, by, opts);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code: 1 | 2 | 3 = message.startsWith('APS-')
      ? 3
      : error instanceof ApsInputError || /constraint failed/i.test(message)
        ? 2
        : 1;
    return { card: cardId, run: run ? String(run.run_id) : null, outcome: 'pending', code, message };
  }
}

export async function runApsCollectCommand(
  _action: string,
  id: string | undefined,
  options: ApsCollectOptions,
): Promise<void> {
  const aps = await importAps();
  let db: DatabaseSync | undefined;
  try {
    const by = required(options.by ?? process.env.APS_AGENT, 'by');
    if (options.all && id !== undefined) throw new ApsInputError('pass either a card or --all, not both');
    const cardId = options.all ? undefined : required(id, 'card');
    const waitMs = options.wait === undefined ? undefined : parseDuration(options.wait, 'wait');
    const core = await importCore();
    const config = await core.loadConfig(resolve(options.projectDir ?? process.cwd()));
    db = aps.openApsDb(aps.resolveApsDbPath({ flag: options.db, configPath: config.aps?.dbPath }));
    const ledger = db;
    aps.doctor(ledger);
    for (const warning of aps.escalateFeedback(ledger)) process.stderr.write(`[mmbridge] ${warning}\n`);
    const opts: CollectRunOptions = {
      abandon: Boolean(options.abandon),
      waitMs,
      ompSessionDir: options.ompSessionDir,
    };
    if (options.all) {
      const rows = db
        .prepare("SELECT card_id FROM v_run_current WHERE status IN ('launched','reported') ORDER BY since, run_id")
        .all();
      const outcomes: CollectOutcome[] = [];
      for (const row of rows) outcomes.push(await collectRun(ledger, String(row.card_id), by, opts));
      if (options.json)
        emit(
          outcomes.map((outcome) => (outcome.outcome === 'pending' ? { ...outcome, pending: true } : outcome)),
          true,
        );
      else
        for (const outcome of outcomes)
          process.stdout.write(`${outcome.card} ${outcome.outcome}: ${outcome.message}\n`);
      let worst = 0;
      let failed = 0;
      for (const outcome of outcomes) {
        if (outcome.code > worst) worst = outcome.code;
        if (outcome.code !== 0) {
          failed += 1;
          process.stderr.write(`[mmbridge] ${outcome.card}: ${outcome.message}\n`);
        }
      }
      if (worst !== 0) exitWithError(`collect --all: ${failed} of ${outcomes.length} runs failed`, worst);
      return;
    }
    const outcome = await collectRun(ledger, cardId as string, by, opts);
    if (options.json) emit({ ...outcome, ...(outcome.outcome === 'pending' ? { pending: true } : {}) }, true);
    if (outcome.code === 0) {
      if (!options.json) process.stdout.write(`${outcome.message}\n`);
      return;
    }
    exitWithError(outcome.message, outcome.code);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = message.startsWith('APS-')
      ? 3
      : error instanceof ApsInputError || /(?:CHECK|NOT NULL|UNIQUE|FOREIGN KEY) constraint failed/.test(message)
        ? 2
        : 1;
    db?.close();
    db = undefined;
    exitWithError(message, code);
  } finally {
    db?.close();
  }
}
