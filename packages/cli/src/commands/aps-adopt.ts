import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ApsInputError, type WorkerKind } from '@mmbridge/aps';
import { getPane } from './aps-herdr.js';
import { type ApsCommandOptions, choice, emit, required, sha } from './aps-shared.js';
import { exitWithError, importAps, importCore } from './helpers.js';

export interface ApsAdoptOptions extends ApsCommandOptions {
  agent?: string;
  worktree?: string;
  harness?: string;
  pid?: string;
  pane?: string;
  baseSha?: string;
  sessionRef?: string;
}

export function adoptExitCode(error: unknown): 1 | 2 | 3 {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith('APS-')) return 3;
  return error instanceof ApsInputError || /(?:CHECK|NOT NULL|UNIQUE|FOREIGN KEY) constraint failed/.test(message)
    ? 2
    : 1;
}

/** True unless the kernel reports the process is gone. Unknown errors stay "alive" so collect never fails a live lane. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function parsePid(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) throw new ApsInputError('--pid must be a positive integer');
  const pid = Number(value);
  if (!Number.isSafeInteger(pid)) throw new ApsInputError('--pid must be a positive integer');
  return pid;
}

export async function runApsAdoptCommand(
  _action: string,
  id: string | undefined,
  options: ApsAdoptOptions,
): Promise<void> {
  const aps = await importAps();
  let db: DatabaseSync | undefined;
  try {
    const cardId = required(id, 'card');
    const by = required(options.by ?? process.env.APS_AGENT, 'by');
    const agentId = required(options.agent, 'agent');
    const worktree = required(options.worktree, 'worktree');
    const branch = required(options.branch, 'branch');
    const pane = options.pane?.trim() || undefined;
    const sessionRef = options.sessionRef?.trim() || undefined;
    if (options.sessionRef !== undefined && !sessionRef) throw new ApsInputError('--session-ref must be non-empty');
    const pid = options.pid === undefined ? undefined : parsePid(options.pid);
    if (pid === undefined && !pane) throw new ApsInputError('at least one of --pid or --pane is required');
    const harness = (
      options.harness === undefined
        ? pane
          ? 'herdr'
          : 'omp'
        : choice(options.harness, 'harness', ['herdr', 'omp', 'devin', 'grok'])
    ) as 'herdr' | WorkerKind;
    if (harness !== 'herdr' && options.kind !== undefined) throw new ApsInputError('--kind is only valid for herdr');
    const kind =
      harness === 'herdr' ? (choice(options.kind, 'kind', ['omp', 'devin', 'grok'], 'omp') as WorkerKind) : null;
    if (!isAbsolute(worktree) || !existsSync(worktree) || !statSync(worktree).isDirectory())
      throw new ApsInputError('--worktree must be an existing absolute directory');
    if (pid !== undefined && !pidAlive(pid)) throw new ApsInputError(`--pid ${pid} is not alive`);
    if (pane) {
      const state = await getPane(pane);
      if (state.state !== 'present') throw new ApsInputError(`--pane ${pane} is not present`);
    }
    const core = await importCore();
    const git = async (args: string[]) => core.runCommand('git', ['-C', worktree, ...args]);
    const inside = await git(['rev-parse', '--is-inside-work-tree']);
    if (!inside.ok || inside.stdout.trim() !== 'true')
      throw new ApsInputError('--worktree must be an existing absolute git worktree');
    const head = await git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (!head.ok || head.stdout.trim() !== branch)
      throw new ApsInputError('--branch must match the checked-out worktree branch');
    let baseSha = options.baseSha === undefined ? undefined : sha(options.baseSha, 'base-sha');
    if (!baseSha) {
      const origin = await git(['merge-base', 'HEAD', 'origin/main']);
      const main = origin.ok ? null : await git(['merge-base', 'HEAD', 'main']);
      const resolved = (origin.ok ? origin.stdout : (main?.stdout ?? '')).trim();
      if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(resolved))
        throw new ApsInputError('cannot resolve base sha: git merge-base HEAD origin/main (or main) failed');
      baseSha = resolved;
    }
    const config = await core.loadConfig(resolve(options.projectDir ?? process.cwd()));
    const dbPath = aps.resolveApsDbPath({ flag: options.db, configPath: config.aps?.dbPath });
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 5000');
    aps.doctor(db);
    const agent = aps.getAgent(db, agentId);
    if (agent.status === 'closed') throw new ApsInputError(`agent ${agentId} is closed`);
    const manager = aps.getAgent(db, by);
    if (manager.status === 'closed') throw new ApsInputError('--by must name a live manager agent');
    aps.getCard(db, cardId);
    if (aps.getLiveRun(db, cardId)) throw new Error('APS-N01: card already has a live run');
    const model = (options.model ?? String(agent.model)).trim();
    if (!model) throw new ApsInputError('--model is required');
    db.close();
    db = undefined;
    db = aps.openApsDb(dbPath);
    const ledger = db;
    aps.doctor(ledger);
    const facts = await aps.commandTransaction(ledger, async () => {
      if (aps.getLiveRun(ledger, cardId)) throw new Error('APS-N01: card already has a live run');
      let card = aps.getCard(ledger, cardId);
      if (card.state === 'issued') aps.startCard(ledger, cardId, agentId);
      card = aps.getCard(ledger, cardId);
      if (card.state !== 'working' || String(card.assignee) !== agentId)
        throw new ApsInputError(`card ${cardId} is assigned to ${card.assignee ?? 'nobody'}, not ${agentId}`);
      const attempt = Number(card.attempt);
      const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
      let run = `${cardId}-a${attempt}-adopt-${stamp}`;
      if (ledger.prepare('SELECT 1 FROM worker_runs WHERE id=?').get(run)) run += `-${randomUUID().slice(0, 8)}`;
      const packet = join(dirname(dbPath), 'dispatch', run);
      const detail: Record<string, unknown> = { adopted: true };
      if (pid !== undefined) detail.pid = pid;
      if (pane !== undefined) detail.pane_id = pane;
      if (sessionRef !== undefined) detail.session_ref = sessionRef;
      aps.createRun(ledger, {
        id: run,
        card_id: cardId,
        attempt,
        agent_id: agentId,
        harness,
        kind,
        model,
        worktree,
        branch,
        base_sha: baseSha,
        packet_dir: packet,
        created_by: by,
      });
      aps.addRunEvent(ledger, run, 'launched', by, detail);
      const recorded = {
        run,
        card: cardId,
        attempt,
        agent: agentId,
        harness,
        kind,
        model,
        worktree,
        branch,
        base_sha: baseSha,
        packet_dir: packet,
        created_by: by,
        ...detail,
      };
      mkdirSync(packet, { recursive: true });
      writeFileSync(join(packet, 'adopt.json'), `${JSON.stringify(recorded, null, 2)}\n`);
      return recorded;
    });
    emit(facts, options.json);
  } catch (error) {
    exitWithError(error instanceof Error ? error.message : String(error), adoptExitCode(error));
  } finally {
    db?.close();
  }
}
