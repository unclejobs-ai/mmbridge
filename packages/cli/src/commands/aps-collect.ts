import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { ApsInputError, type Row, type UsageByModel } from '@mmbridge/aps';
import { pidAlive } from './aps-adopt.js';
import {
  type LaunchInfo,
  isFile,
  launchInfo,
  probeKind,
  sessionClose,
  sessionEnded,
  summarize,
} from './aps-collect-probe.js';
import { confirmPaneEnded, getPane } from './aps-herdr.js';
import { newestSession } from './aps-lanes.js';
import { patternTranscripts } from './aps-omp-transcripts.js';
import { type ApsCommandOptions, emit, parseDuration, required } from './aps-shared.js';
import { exitWithError, importAps, importCore } from './helpers.js';

export interface ApsCollectOptions extends ApsCommandOptions {
  all?: boolean;
  wait?: string;
  ompSessionDir?: string;
  closeOnly?: boolean;
}

export interface CollectRunOptions {
  abandon?: boolean;
  /** Close the latest launched run of a card that already left working, from its report.json (no report row). */
  closeOnly?: boolean;
  waitMs?: number;
  pollMs?: number;
  ompSessionDir?: string;
  /** Repository that verifies the reported sha when the run worktree is gone (default: cwd). */
  projectDir?: string;
}

export interface CollectOutcome {
  card: string;
  run: string | null;
  outcome: 'pending' | 'running' | 'reported' | 'closed' | 'blocked' | 'abandoned';
  code: 0 | 1 | 2 | 3;
  message: string;
  report?: unknown;
  evidence?: unknown;
  /** Acceptance ids the CLI dropped from the recorded evidence because they are not on the card. */
  droppedAc?: string[];
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
/** Merged lanes delete their branch; the card ledger records no merge target, so the remote default branch is it. */
const MERGE_TARGET = 'origin/main';

interface CommitCheck {
  repo: string;
  ref: string;
  fallback: boolean;
}

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

/** A deterministic packet refusal, unlike filesystem and git failures. */
class ReportInputError extends ApsInputError {}

function readReport(path: string): WorkerReport {
  const content = readFileSync(path, 'utf8');
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new ReportInputError(`invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ReportInputError(`${path} must contain a JSON object`);
  const report = value as Record<string, unknown>;
  if (typeof report.status !== 'string' || !['DONE', 'DONE_WITH_CONCERNS', 'BLOCKED'].includes(report.status))
    throw new ReportInputError(`${path} status must be DONE|DONE_WITH_CONCERNS|BLOCKED`);
  if (typeof report.sha !== 'string') throw new ReportInputError(`${path} sha must be a string`);
  if (typeof report.branch !== 'string' || !report.branch.trim())
    throw new ReportInputError(`${path} branch must be a non-empty string`);
  return report as unknown as WorkerReport;
}

async function verifyCommit(run: Row, report: WorkerReport, projectDir: string | undefined): Promise<CommitCheck> {
  const core = await importCore();
  const git = (repo: string, args: string[]) => core.runCommand('git', ['-C', repo, ...args], { timeoutMs: 15_000 });
  const worktree = String(run.worktree);
  const fallback = !existsSync(worktree) || !(await git(worktree, ['rev-parse', '--git-dir'])).ok;
  const repo = fallback ? resolve(projectDir ?? process.cwd()) : worktree;
  const refused = () =>
    new Error(
      `APS-H09: reported sha ${report.sha} is not a commit on ${report.branch} in ${repo}${fallback ? ` (run worktree ${worktree} is missing)` : ''}`,
    );
  if (report.branch !== String(run.branch)) throw refused();
  if (!(await git(repo, ['cat-file', '-e', `${report.sha}^{commit}`])).ok) throw refused();
  // The project repo may hold the branch locally, only on origin, or not at all once the merged lane was deleted.
  let refs = [report.branch];
  if (fallback) {
    refs = [];
    for (const ref of [`refs/heads/${report.branch}`, `refs/remotes/origin/${report.branch}`])
      if ((await git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).ok) refs.push(ref);
    if (refs.length === 0) refs.push(`refs/remotes/${MERGE_TARGET}`);
  }
  for (const ref of refs)
    if ((await git(repo, ['merge-base', '--is-ancestor', report.sha, ref])).ok) return { repo, ref, fallback };
  throw refused();
}

/**
 * `closeSession`, except an agent row that is already closed stays untouched (APS-A02: closed is final);
 * its cards still move the same way: working→issued under abandon, reported→closed_session.
 */
function closeRunSession(aps: Aps, db: DatabaseSync, agentId: string, by: string, note: string, abandon: boolean) {
  if (aps.getAgent(db, agentId).status !== 'closed') {
    aps.closeSession(db, agentId, by, note, abandon);
    return;
  }
  const cards = db
    .prepare("SELECT id,state FROM cards WHERE assignee=? AND state IN ('working','reported') ORDER BY id")
    .all(agentId);
  if (!abandon && cards.some((card) => card.state === 'working'))
    throw new ApsInputError(`agent ${agentId} has working cards; use --abandon to return them`);
  for (const card of cards)
    aps.moveCard(db, String(card.id), card.state === 'working' ? 'issued' : 'closed_session', by, note);
}

function transcriptPath(run: Row, launch: LaunchInfo, opts: CollectRunOptions): { file?: string; ambiguous: boolean } {
  const detail = launch.detail;
  const candidates: string[] = [];
  let ambiguous = false;
  if (opts.ompSessionDir && typeof detail.omp_id === 'string')
    candidates.push(join(opts.ompSessionDir, `${detail.omp_id}.jsonl`));
  const ref = typeof detail.session_ref === 'string' ? detail.session_ref : '';
  if (ref.includes('*')) {
    const matches = patternTranscripts(ref).filter(isFile);
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
      const commit = await verifyCommit(
        run,
        { sha: String(stored.sha), branch: String(stored.branch) } as WorkerReport,
        opts.projectDir,
      );
      await aps.commandTransaction(db, async () => {
        aps.addRunEvent(db, runId, reportStatus === 'BLOCKED' ? 'blocked' : 'reported', by, {
          adopted: true,
          report: 'ledger',
          commit,
        });
      });
      const evidence = { ...(await sessionClose(run, launch, opts)), commit };
      const summary = summarize(evidence);
      const abandon = reportStatus === 'BLOCKED';
      await aps.commandTransaction(db, async () => {
        closeRunSession(aps, db, String(run.agent_id), by, `collect ${runId}: ${summary}`, abandon);
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
  let reportStatus = 'DONE';
  let report: unknown;
  let commit: CommitCheck | undefined;
  let droppedAc: string[] = [];

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
              closeRunSession(aps, db, String(run.agent_id), by, `collect ${runId}: ${summary}`, true);
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
    // A report the ledger deterministically refuses (P05–P08, R02/R03, or an invalid/mismatched
    // report.json) must not wedge the lane: with --abandon and a proven session end the run is
    // abandoned and the card returns to issued (issue #15 recovery path). Environmental failures
    // (H09, git timeouts, …) are rethrown: they are not the report's fault and may clear on retry.
    try {
      const worker = readReport(reportPath);
      if (worker.run !== runId || worker.card !== cardId || worker.attempt !== Number(run.attempt))
        throw new ReportInputError(`report.json does not match live run ${runId}`);
      if (worker.status === 'DONE_WITH_CONCERNS' && (typeof worker.risks !== 'string' || !worker.risks.trim()))
        throw new ApsInputError(
          `APS-P08: DONE_WITH_CONCERNS requires non-empty risks — add "risks" to ${reportPath} describing every ok:false item, then re-run collect (or pass --abandon once the session ended)`,
        );
      commit = await verifyCommit(run, worker, opts.projectDir);
      reportStatus = worker.status;
      report = worker;
      const evidenceJson = aps.stripUnknownEvidence(db, cardId, JSON.stringify(worker.evidence ?? null));
      if (evidenceJson.refused.length > 0)
        process.stderr.write(
          `[mmbridge] collect ${runId}: evidence marks unknown acceptance id(s) ${evidenceJson.refused.join(', ')} as ok:false; not dropping them — add them to the card acceptance or resolve the failure\n`,
        );
      else if (evidenceJson.dropped.length > 0)
        process.stderr.write(
          `[mmbridge] collect ${runId}: warning: evidence references acceptance ids not on card ${cardId} (${evidenceJson.dropped.join(', ')}); recorded without them\n`,
        );
      await aps.commandTransaction(db, async () => {
        aps.recordReport(db, cardId, {
          by_agent: String(run.agent_id),
          recorded_by: by,
          sha: worker.sha,
          branch: worker.branch,
          pr_url: worker.pr ?? null,
          files_json: JSON.stringify(worker.files ?? null),
          evidence_json: evidenceJson.json,
          risks:
            typeof worker.risks === 'string' ? worker.risks : typeof worker.blocked === 'string' ? worker.blocked : '',
          status: worker.status,
          body_md: readOptional(join(packet, 'report.md')),
        });
        aps.addLink(db, cardId, by, 'handoff', join(packet, 'report.md'));
        if (typeof worker.pr === 'string' && worker.pr) aps.addLink(db, cardId, by, 'pr', worker.pr);
        aps.addRunEvent(db, runId, worker.status === 'BLOCKED' ? 'blocked' : 'reported', by, {
          report: reportPath,
          commit,
          ...(evidenceJson.dropped.length > 0 ? { dropped_ac: evidenceJson.dropped } : {}),
        });
      });
      droppedAc = evidenceJson.dropped;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const reportRefused = error instanceof ReportInputError || /^APS-(?:P0[5-8]|R0[2-3]):/.test(message);
      if (!opts.abandon || !reportRefused) throw error;
      const ended = await sessionEnded(run, launch, opts);
      if (!ended) throw error;
      const summary = summarize(ended);
      await aps.commandTransaction(db, async () => {
        aps.addRunEvent(db, runId, 'abandoned', by, { evidence: ended, report_rejected: message });
        closeRunSession(aps, db, String(run.agent_id), by, `collect ${runId}: ${summary}`, true);
      });
      return {
        card: cardId,
        run: runId,
        outcome: 'abandoned',
        code: 0,
        message: `collect ${runId}: abandoned (${summary}; report rejected: ${message})`,
        evidence: ended,
      };
    }
  } else {
    const stored = db
      .prepare('SELECT status FROM reports WHERE card_id=? AND attempt=? ORDER BY id DESC LIMIT 1')
      .get(cardId, Number(run.attempt));
    reportStatus = stored ? String(stored.status) : 'DONE';
    report = stored;
  }

  const evidence = { ...(await sessionClose(run, launch, opts)), ...(commit ? { commit } : {}) };
  const summary = summarize(evidence);
  const abandon = reportStatus === 'BLOCKED';
  await aps.commandTransaction(db, async () => {
    closeRunSession(aps, db, String(run.agent_id), by, `collect ${runId}: ${summary}`, abandon);
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
    ...(droppedAc.length > 0 ? { droppedAc } : {}),
  };
}

/**
 * `--close-only`: once the card left working, APS-P01 bars `recordReport`, so the latest launched run is closed from
 * its packet report.json without a report row or a card move: launched→reported→closed (a BLOCKED report ends at
 * `blocked`). A closed agent stays untouched; an open one is closed (H01 first) only when it has no working cards.
 */
async function closeOnlyRun(aps: Aps, db: DatabaseSync, cardId: string, by: string): Promise<CollectOutcome> {
  if (aps.getAgent(db, by).status === 'closed') throw new ApsInputError('--by must name a live manager agent');
  const cardState = String(aps.getCard(db, cardId).state);
  if (cardState === 'working')
    throw new ApsInputError(`card ${cardId} is still working; collect it without --close-only`);
  const run = db
    .prepare(
      "SELECT * FROM v_run_current WHERE card_id=? AND status='launched' ORDER BY since DESC, run_id DESC LIMIT 1",
    )
    .get(cardId);
  if (!run) return { card: cardId, run: null, outcome: 'pending', code: 2, message: 'no launched run' };
  const runId = String(run.run_id);
  const reportPath = join(String(run.packet_dir), 'report.json');
  if (!existsSync(reportPath))
    throw new ApsInputError(`run ${runId} has no ${reportPath}; use --abandon once the session ended`);
  const worker = readReport(reportPath);
  if (worker.run !== runId || worker.card !== cardId || worker.attempt !== Number(run.attempt))
    throw new ApsInputError(`report.json does not match launched run ${runId}`);
  const agentId = String(run.agent_id);
  const agent = aps.getAgent(db, agentId);
  const working = db.prepare("SELECT count(*) AS n FROM cards WHERE assignee=? AND state='working'").get(agentId);
  const closeAgent = agent.status !== 'closed' && Number(working?.n) === 0;
  const pane = closeAgent && agent.herdr_pane ? await confirmPaneEnded(String(agent.herdr_pane)) : undefined;
  const evidence = {
    close_only: true,
    report: reportPath,
    report_status: worker.status,
    sha: worker.sha,
    branch: worker.branch,
    card_state: cardState,
    agent: agent.status === 'closed' ? 'already_closed' : closeAgent ? 'closed' : 'open_with_working_cards',
    ...(pane ? { pane } : {}),
  };
  const blocked = worker.status === 'BLOCKED';
  await aps.commandTransaction(db, async () => {
    if (blocked) aps.addRunEvent(db, runId, 'blocked', by, { report: reportPath, evidence });
    else {
      aps.addRunEvent(db, runId, 'reported', by, { report: reportPath, close_only: true });
      aps.addRunEvent(db, runId, 'closed', by, { evidence });
    }
    if (closeAgent) aps.closeSession(db, agentId, by, `collect --close-only ${runId}`, false);
  });
  return {
    card: cardId,
    run: runId,
    outcome: blocked ? 'blocked' : 'closed',
    code: 0,
    message: `collect ${runId}: ${blocked ? 'blocked' : 'closed'} without a report row (card ${cardState})`,
    evidence,
  };
}

/**
 * `no live run` alone hid the real state (issue #15: closed_session cards with a lane report were
 * indistinguishable from a typo). Say where the card is and what the next command is.
 */
function noLiveRunMessage(aps: Aps, db: DatabaseSync, cardId: string): string {
  const card = aps.getCard(db, cardId);
  const state = String(card.state);
  const base = `no live run; card ${cardId} is ${state}`;
  if (state === 'working')
    return `${base} without a live dispatched run — record the lane's report with aps report (or aps dispatch it)`;
  const reported = db
    .prepare('SELECT 1 FROM reports WHERE card_id=? AND attempt=? LIMIT 1')
    .get(cardId, Number(card.attempt));
  if (state === 'reported')
    return `${base} without a live dispatched run (manual lane) — close the session: mmbridge aps close-session ${card.assignee ?? '<assignee>'} --note '<why the pane is gone>'`;
  if (reported)
    return `${base} with its attempt-${card.attempt} report already recorded; nothing to collect (next: mmbridge aps review ${cardId})`;
  return `${base} without a recorded report; nothing to collect`;
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
    if (opts.closeOnly) return await closeOnlyRun(aps, db, cardId, by);
    run = aps.getLiveRun(db, cardId);
    if (!run)
      return { card: cardId, run: null, outcome: 'pending', code: 2, message: noLiveRunMessage(aps, db, cardId) };
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
    if (options.closeOnly && (options.all || options.abandon || options.wait !== undefined))
      throw new ApsInputError('--close-only takes one card and no --all, --abandon or --wait');
    const cardId = options.all ? undefined : required(id, 'card');
    const waitMs = options.wait === undefined ? undefined : parseDuration(options.wait, 'wait');
    const core = await importCore();
    const projectDir = resolve(options.projectDir ?? process.cwd());
    const config = await core.loadConfig(projectDir);
    db = aps.openApsDb(aps.resolveApsDbPath({ flag: options.db, configPath: config.aps?.dbPath }));
    const ledger = db;
    aps.doctor(ledger);
    for (const warning of aps.escalateFeedback(ledger)) process.stderr.write(`[mmbridge] ${warning}\n`);
    const opts: CollectRunOptions = {
      abandon: Boolean(options.abandon),
      closeOnly: Boolean(options.closeOnly),
      waitMs,
      ompSessionDir: options.ompSessionDir,
      projectDir,
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
