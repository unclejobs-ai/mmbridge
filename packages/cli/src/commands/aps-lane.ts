import { randomUUID } from 'node:crypto';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { ApsInputError } from '@mmbridge/aps';
import { launchInfo, sessionClose } from './aps-collect-probe.js';
import { collectRun } from './aps-collect.js';
import { contract, dispatchExitCode, ompSessionGlob, reportSchema } from './aps-dispatch.js';
import { resolveSessionRef, sessionModel } from './aps-lanes.js';
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
/** How long `lane start` waits for a just-spawned task transcript to name its model when none is given. */
const MODEL_WAIT_MS = 20_000;

function validated(value: unknown, flag: string): string {
  const text = required(value, flag).trim();
  if (!TASK_ID.test(text)) throw new ApsInputError(`--${flag} must match [A-Za-z0-9._@-]{1,64}`);
  return text;
}

function sessionDirFlag(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!isAbsolute(value)) throw new ApsInputError('--omp-session-dir must be an absolute directory');
  return value;
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
 * Records an omp task lane that is already running: reuse the open agent named after the lane (or create it),
 * start the card, and write the pointer-mode run (`launched` with `{omp_id, session_ref}`) plus its packet.
 */
export async function laneStart(id: string | undefined, options: ApsLaneOptions): Promise<Record<string, unknown>> {
  const aps = await importAps();
  const core = await importCore();
  const cardId = required(id, 'card');
  const ompId = validated(options.ompId, 'omp-id');
  const lane = validated(options.lane, 'lane');
  const sessionDir = sessionDirFlag(options.ompSessionDir);
  const sessionRef = sessionDir ? join(sessionDir, `${ompId}.jsonl`) : ompSessionGlob(ompId);
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
    const findAgent = () =>
      ledger
        .prepare(
          "SELECT id,model FROM agents WHERE name=? AND project IS ? AND status<>'closed' ORDER BY started_at DESC, id DESC LIMIT 1",
        )
        .get(lane, project);
    let model = options.model?.trim() || String(findAgent()?.model ?? '');
    for (const deadline = Date.now() + MODEL_WAIT_MS; !model && Date.now() < deadline; await delay(500)) {
      const file = resolveSessionRef(sessionRef);
      model = (file && sessionModel(file)) || '';
    }
    if (!model)
      throw new ApsInputError(`--model is required: no model in ${sessionRef} after ${MODEL_WAIT_MS / 1000}s`);
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
      const existing = findAgent();
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
  const projectDir = resolve(options.projectDir ?? process.cwd());
  const opts = { ompSessionDir: sessionDirFlag(options.ompSessionDir), abandon: Boolean(options.abandon), projectDir };
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
    await sessionClose(run, launch, opts); // APS-H08 when the task has not yielded.
    return await collectRun(db, cardId, by, opts);
  } finally {
    db.close();
  }
}
