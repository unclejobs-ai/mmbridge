import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { ApsInputError } from '@mmbridge/aps';
import { launchInfo, sessionClose } from './aps-collect-probe.js';
import { collectRun } from './aps-collect.js';
import { contract, dispatchExitCode, reportSchema } from './aps-dispatch.js';
import { sessionModel } from './aps-lanes.js';
import {
  findTaskTranscripts,
  ompSessionsRoot,
  patternTranscripts,
  sessionDirInsideRoot,
} from './aps-omp-transcripts.js';
import { type ApsCommandOptions, choice, emit, required } from './aps-shared.js';
import { exitWithError, importAps, importCore } from './helpers.js';

export interface ApsLaneOptions extends ApsCommandOptions {
  ompId?: string;
  lane?: string;
  worktree?: string;
  ompSessionDir?: string;
}

/** Same alphabet as `dispatch --omp-id`; a lane name is the worker identity (D6), so it gets the same rule. */
const TASK_ID = /^[A-Za-z0-9._@-]{1,64}$/;
/** How long `lane start` waits for a just-spawned task's transcript (and its model, when none is given). */
const TRANSCRIPT_WAIT_MS = 20_000;

function validated(value: unknown, flag: string): string {
  const text = required(value, flag).trim();
  if (!TASK_ID.test(text)) throw new ApsInputError(`--${flag} must match [A-Za-z0-9._@-]{1,64}`);
  return text;
}

/** `--omp-session-dir` as a real path; it must be an existing directory inside the omp sessions root. */
function sessionDirFlag(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const real = isAbsolute(value) ? sessionDirInsideRoot(value) : null;
  if (!real) throw new ApsInputError(`--omp-session-dir must be an existing directory inside ${ompSessionsRoot()}`);
  return real;
}

export async function runApsLaneCommand(action: string, id: string | undefined, options: ApsLaneOptions) {
  try {
    if (action === 'lane-start') {
      emit(await laneStart(id, options), options.json);
      return;
    }
    const outcome = await laneEnd(id, options);
    if (options.json) emit(outcome, true);
    if (outcome.code !== 0) exitWithError(outcome.message, outcome.code);
    if (!options.json) process.stdout.write(`${outcome.message}\n`);
  } catch (error) {
    exitWithError(error instanceof Error ? error.message : String(error), dispatchExitCode(error));
  }
}

/**
 * Records an omp task lane that is already running: reuse the idle open agent named after the lane (or create it),
 * start the card, and write the run (`launched` with `{omp_id, session_ref, lane}`, `session_ref` = the task's
 * exact transcript) plus its packet.
 */
export async function laneStart(id: string | undefined, options: ApsLaneOptions): Promise<Record<string, unknown>> {
  const aps = await importAps();
  const core = await importCore();
  const cardId = required(id, 'card');
  const ompId = validated(options.ompId, 'omp-id');
  const lane = validated(options.lane, 'lane');
  const sessionDir = sessionDirFlag(options.ompSessionDir);
  const layer = choice(options.layer, 'layer', ['L2', 'L3'], 'L3');
  const projectDir = resolve(options.projectDir ?? process.cwd());
  const worktree = options.worktree === undefined ? projectDir : options.worktree;
  if (!isAbsolute(worktree) || !statSync(worktree, { throwIfNoEntry: false })?.isDirectory())
    throw new ApsInputError('--worktree must be an existing absolute directory');
  const git = async (args: string[]) => {
    const result = await core.runCommand('git', ['-C', worktree, ...args], { timeoutMs: 15_000 });
    return result.ok ? result.stdout.trim() : null;
  };
  if ((await git(['rev-parse', '--is-inside-work-tree'])) !== 'true')
    throw new ApsInputError(`${worktree} is not a git worktree`);
  const currentBranch = await git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const branch = options.branch ?? currentBranch;
  if (!branch) throw new ApsInputError('--branch is required: the worktree HEAD is detached');
  if (branch !== currentBranch) throw new ApsInputError('--branch must match the checked-out worktree branch');
  // The lane is already running, so its base is the worktree HEAD at record time (same as dispatch).
  const baseSha = await git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  if (!baseSha) throw new ApsInputError(`cannot resolve HEAD in ${worktree}`);

  const config = await core.loadConfig(projectDir);
  const dbPath = aps.resolveApsDbPath({ flag: options.db, configPath: config.aps?.dbPath });
  let db: DatabaseSync | undefined;
  try {
    db = aps.openApsDb(dbPath);
    const ledger = db;
    aps.doctor(ledger);
    const card = aps.getCard(ledger, cardId);
    const project = card.project;
    // Checked before the model wait so refusals are immediate; repeated inside the transaction.
    if (aps.getLiveRun(ledger, cardId)) throw new Error('APS-N01: card already has a live run');
    if (card.state !== 'issued' && card.state !== 'revise')
      throw new ApsInputError(`card ${cardId} must be issued or revise`);
    // A lane name is one worker: reuse its open agent only while that agent holds no other live card, so ending
    // or abandoning this card can never close or return someone else's work.
    const laneAgent = () => {
      const agent = ledger
        .prepare(
          "SELECT id,model FROM agents WHERE name=? AND project IS ? AND status<>'closed' ORDER BY started_at DESC, id DESC LIMIT 1",
        )
        .get(lane, project);
      if (!agent) return undefined;
      const busy = ledger
        .prepare("SELECT id,state FROM cards WHERE assignee=? AND state IN ('working','reported') ORDER BY id LIMIT 1")
        .get(agent.id);
      if (busy)
        throw new ApsInputError(
          `lane ${lane} is busy: agent ${String(agent.id)} holds ${String(busy.id)} (${String(busy.state)}); end that lane first or pick another --lane`,
        );
      return agent;
    };
    let model = options.model?.trim() || String(laneAgent()?.model ?? '');
    // The task was just spawned: wait for exactly one transcript to exist (and name its model if needed).
    let transcripts: string[] = [];
    for (const deadline = Date.now() + TRANSCRIPT_WAIT_MS; ; await delay(500)) {
      transcripts = findTaskTranscripts(ompId, sessionDir);
      if (transcripts.length > 1) break;
      if (transcripts.length === 1 && !model) model = sessionModel(transcripts[0]) ?? '';
      if ((transcripts.length === 1 && model) || Date.now() >= deadline) break;
    }
    const where = sessionDir ?? ompSessionsRoot();
    if (transcripts.length === 0)
      throw new ApsInputError(`no omp transcript ${ompId}.jsonl under ${where} after ${TRANSCRIPT_WAIT_MS / 1000}s`);
    if (transcripts.length > 1)
      throw new ApsInputError(
        `omp task ${ompId} is ambiguous under ${where}: ${transcripts.join(', ')}; pass --omp-session-dir`,
      );
    const sessionRef = transcripts[0];
    if (!model)
      throw new ApsInputError(`--model is required: no model in ${sessionRef} after ${TRANSCRIPT_WAIT_MS / 1000}s`);
    const provider = model.includes('/')
      ? model
          .split('/')[0]
          .toLowerCase()
          .replace(/[^a-z0-9-]+/g, '-')
      : '';
    return await aps.commandTransaction(ledger, async () => {
      if (aps.getLiveRun(ledger, cardId)) throw new Error('APS-N01: card already has a live run');
      const state = String(aps.getCard(ledger, cardId).state);
      if (state !== 'issued' && state !== 'revise') throw new ApsInputError(`card ${cardId} must be issued or revise`);
      const existing = laneAgent();
      const agent = existing
        ? String(existing.id)
        : aps.newAgent(ledger, {
            name: lane,
            layer,
            model,
            vendor: options.vendor ?? (provider || 'unknown'),
            project,
          });
      // A task lane records itself unless a manager session is named.
      const by = (options.by ?? process.env.APS_AGENT)?.trim() || agent;
      if (aps.getAgent(ledger, by).status === 'closed') throw new ApsInputError(`--by ${by} is a closed session`);
      aps.startCard(ledger, cardId, agent);
      const attempt = Number(aps.getCard(ledger, cardId).attempt);
      const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
      let run = `${cardId}-a${attempt}-lane-${stamp}`;
      if (ledger.prepare('SELECT 1 FROM worker_runs WHERE id=?').get(run)) run += `-${randomUUID().slice(0, 8)}`;
      const packet = join(dirname(dbPath), 'dispatch', run);
      aps.createRun(ledger, {
        id: run,
        card_id: cardId,
        attempt,
        agent_id: agent,
        harness: 'omp',
        kind: null,
        model,
        worktree,
        branch,
        base_sha: baseSha,
        packet_dir: packet,
        created_by: by,
      });
      const launch = { omp_id: ompId, session_ref: sessionRef };
      aps.addRunEvent(ledger, run, 'launched', by, { ...launch, lane });
      const metadata = { run, card: cardId, attempt, worktree, branch, base_sha: baseSha, harness: 'omp', model, lane };
      mkdirSync(packet, { recursive: true });
      writeFileSync(
        join(packet, 'card.md'),
        aps.renderCardPrompt(ledger, cardId) + contract(run, cardId, attempt, packet, branch),
      );
      writeFileSync(
        join(packet, 'report.schema.json'),
        `${JSON.stringify(reportSchema(run, cardId, attempt, branch), null, 2)}\n`,
      );
      writeFileSync(
        join(packet, 'dispatch.json'),
        `${JSON.stringify({ ...metadata, agent, by, ...launch }, null, 2)}\n`,
      );
      return {
        ...metadata,
        agent,
        reused_agent: existing !== undefined,
        by,
        packet,
        ...launch,
        ompPrompt: `Read ${join(packet, 'card.md')} and follow it exactly. Hand off by writing ${join(packet, 'report.json')} and ${join(packet, 'report.md')}. Yield when report.json is written.`,
        next: `mmbridge aps lane end ${cardId} --omp-id ${ompId} --by <manager>`,
      };
    });
  } finally {
    db?.close();
  }
}

/** Collects the card's live pointer run for `omp_id`: refuses until the task yielded, then report + close. */
export async function laneEnd(id: string | undefined, options: ApsLaneOptions) {
  const aps = await importAps();
  const core = await importCore();
  const cardId = required(id, 'card');
  const ompId = validated(options.ompId, 'omp-id');
  const by = required(options.by ?? process.env.APS_AGENT, 'by');
  const flagDir = sessionDirFlag(options.ompSessionDir);
  const projectDir = resolve(options.projectDir ?? process.cwd());
  const config = await core.loadConfig(projectDir);
  const db = aps.openApsDb(aps.resolveApsDbPath({ flag: options.db, configPath: config.aps?.dbPath }));
  try {
    aps.doctor(db);
    const run = aps.getLiveRun(db, cardId);
    if (!run) throw new ApsInputError(`card ${cardId} has no live run`);
    const runId = String(run.run_id);
    const launch = launchInfo(db, runId);
    if (!launch || launch.detail.omp_id !== ompId)
      throw new ApsInputError(`live run ${runId} of ${cardId} is not omp task ${ompId}`);
    // collect closes the lane agent before its `closed` event; that event must come from someone still open.
    if (by === String(run.agent_id)) throw new ApsInputError('--by must be a manager session, not the lane agent');
    // The yield output must sit next to the transcript recorded at launch, never in a directory picked now.
    const ref = typeof launch.detail.session_ref === 'string' ? launch.detail.session_ref : '';
    const realDir = (file: string) => {
      try {
        return realpathSync(dirname(file));
      } catch {
        return null;
      }
    };
    if (flagDir !== undefined) {
      const recorded = ref.includes('*') ? patternTranscripts(ref) : ref ? [ref] : [];
      if (!recorded.some((file) => realDir(file) === flagDir))
        throw new ApsInputError(`--omp-session-dir ${flagDir} does not hold the transcript recorded for run ${runId}`);
    }
    // Exact session_ref (lane start): collect derives `<transcript>.md` itself. Pattern (dispatch): the flag narrows.
    const opts = {
      ompSessionDir: ref.includes('*') ? flagDir : undefined,
      abandon: Boolean(options.abandon),
      projectDir,
    };
    await sessionClose(run, launch, opts); // APS-H08 when the task has not yielded.
    return await collectRun(db, cardId, by, opts);
  } finally {
    db.close();
  }
}
