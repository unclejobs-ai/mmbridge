import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { ApsInputError, type WorkerRole, type WorkerTier } from '@mmbridge/aps';
import { collectRun } from './aps-collect.js';
import { type AutoDispatchOptions, autoDispatch } from './aps-dispatch-auto.js';
import { dispatchExitCode } from './aps-dispatch.js';
import { probeQuota } from './aps-quota.js';
import { emit, parseDuration, required } from './aps-shared.js';
import { exitWithError, importAps, importCore } from './helpers.js';

export interface ForemanOptions extends Omit<AutoDispatchOptions, 'workers'> {
  repo?: string;
  max?: string;
  wait?: string;
  workers?: string;
  /** Timeout for one acceptance command, seconds. */
  acTimeout?: string;
}

export type ForemanResult =
  | 'dispatched'
  | 'running'
  | 'exited'
  | 'no-worker'
  | 'inspecting'
  | 'revise'
  | 'blocked'
  | 'NEEDS_CARD_FIX'
  | 'ESCALATE_L1'
  | 'skipped'
  | 'waiting';

export interface ForemanLine {
  card: string;
  worker: string;
  result: ForemanResult;
  sha: string;
  ac: string;
  rework: number;
  note: string;
}

interface AcceptanceItem {
  id: string;
  text: string;
  command?: string;
  expect?: string;
}

interface ChildRow {
  id: string;
  kind: string;
  size: string;
  state: string;
  scope: string;
  acceptance_json: string;
  rework_count: number;
  sha: string | null;
}

/** Card kind → registry placement (APS §14): mechanical work to L3, judgment to L2. */
const PLACEMENT: Record<string, { tier: WorkerTier; role: WorkerRole }> = {
  mech: { tier: 'L3', role: 'mech' },
  research: { tier: 'L3', role: 'mech' },
  review: { tier: 'L2', role: 'review' },
  design: { tier: 'L2', role: 'design' },
  vision: { tier: 'L2', role: 'vision' },
};

/** §14 rework rule: 1 failure → reissue, 2 → the L2 fixes the card, 3+ → L1 redesign (W03 blocks a 4th). */
export function reworkGate(rework: number): 'dispatch' | 'NEEDS_CARD_FIX' | 'ESCALATE_L1' {
  return rework >= 3 ? 'ESCALATE_L1' : rework === 2 ? 'NEEDS_CARD_FIX' : 'dispatch';
}

/** Path-like tokens of a card scope (`packages/aps/src/`, `README.md`); empty when the scope is prose only. */
export function scopePaths(scope: string): string[] {
  return [...scope.matchAll(/[A-Za-z0-9_.@-]*[/.][A-Za-z0-9_./@*-]*/g)]
    .map((match) => match[0].replace(/\*+$/, '').replace(/^\.\//, ''))
    .filter((token) => token.length > 1 && /[A-Za-z]/.test(token) && !/^\.+$/.test(token));
}

export function outOfScope(files: string[], scope: string): string[] {
  const paths = scopePaths(scope);
  if (paths.length === 0) return [];
  return files.filter(
    (file) => !paths.some((path) => file === path || file.startsWith(path.endsWith('/') ? path : `${path}/`)),
  );
}

/** Runs one acceptance item in the worktree: exit 0, plus `expect` text unless expect is just "exit 0". */
export function checkAcceptance(item: AcceptanceItem, cwd: string, timeoutMs: number): { ok: boolean; detail: string } {
  if (!item.command) return { ok: true, detail: `${item.id}: no command (L2 judges)` };
  const run = spawnSync('sh', ['-c', item.command], { cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 << 20 });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  const expect = item.expect?.trim() ?? '';
  const wantText = expect !== '' && !/^exit 0$/i.test(expect);
  const ok = run.status === 0 && (!wantText || output.includes(expect));
  const last = output.trim().split('\n').at(-1) ?? '';
  return {
    ok,
    detail: ok
      ? `${item.id}: pass`
      : `${item.id}: ${run.error ? run.error.message : `exit ${run.status}`}${wantText && !output.includes(expect) ? `, missing "${expect}"` : ''}; last: ${last.slice(0, 200)}`,
  };
}

function git(cwd: string, args: string[]): string {
  const run = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (run.status !== 0) throw new ApsInputError(`git ${args.join(' ')} failed: ${run.stderr.trim()}`);
  return run.stdout.trim();
}

/** Per-card worktree beside the repo: `<repo>.foreman/<card>` on branch `foreman/<card>` from the repo HEAD. */
export function ensureWorktree(repo: string, card: string): string {
  const path = join(dirname(repo), `${basename(repo)}.foreman`, card);
  if (existsSync(path)) return path;
  mkdirSync(dirname(path), { recursive: true });
  git(repo, ['worktree', 'add', '-b', `foreman/${card}`, path, 'HEAD']);
  return path;
}

/** First pass on a closed_session card: acceptance commands + diff scope. Fail → revise review; pass → inspecting. */
async function inspect(db: DatabaseSync, child: ChildRow, by: string, acTimeoutMs: number): Promise<ForemanLine> {
  const aps = await importAps();
  const run = db
    .prepare(
      `SELECT r.worktree, r.base_sha, a.name AS worker FROM worker_runs r JOIN agents a ON a.id=r.agent_id
       WHERE r.card_id=? AND r.role='work' AND r.attempt=(SELECT attempt FROM cards WHERE id=?) ORDER BY r.at DESC, r.id DESC LIMIT 1`,
    )
    .get(child.id, child.id) as { worktree: string; base_sha: string; worker: string } | undefined;
  const items = JSON.parse(child.acceptance_json) as AcceptanceItem[];
  const sha = child.sha ?? '';
  const line = { card: child.id, worker: run?.worker ?? '-', sha: sha.slice(0, 7), rework: Number(child.rework_count) };
  if (!run || !sha) {
    return { ...line, result: 'skipped', ac: `-/${items.length}`, note: 'no dispatch run or reported sha to inspect' };
  }
  if (git(run.worktree, ['rev-parse', 'HEAD']) !== sha)
    return { ...line, result: 'skipped', ac: `-/${items.length}`, note: `worktree HEAD is not reported sha ${sha}` };
  const results = items.map((item) => checkAcceptance(item, run.worktree, acTimeoutMs));
  const passed = results.filter((result) => result.ok).length;
  const files = git(run.worktree, ['diff', '--name-only', `${run.base_sha}..${sha}`])
    .split('\n')
    .filter(Boolean);
  const stray = outOfScope(files, child.scope);
  const defects = [
    ...results
      .filter((result) => !result.ok)
      .map((result) => ({ severity: 'major', category: 'test', text: result.detail })),
    ...stray.map((file) => ({
      severity: 'major',
      category: 'correctness',
      text: `out of card scope: ${file}`,
      ref: file,
    })),
  ];
  const ac = `${passed}/${items.length}`;
  if (defects.length) {
    aps.recordReview(db, child.id, by, { verdict: 'revise', items_json: JSON.stringify(defects) });
    return {
      ...line,
      rework: line.rework + 1,
      result: 'revise',
      ac,
      note: defects.map((defect) => defect.text).join('; '),
    };
  }
  aps.transaction(db, () => aps.moveCard(db, child.id, 'inspecting', by, 'foreman first pass: acceptance + scope ok'));
  return { ...line, result: 'inspecting', ac, note: 'first pass ok; L2 review (exact SHA) next' };
}

/** One foreman pass over the children of a parent card: collect → first-pass inspect → dispatch up to --max. */
export async function foremanPass(parent: string, options: ForemanOptions): Promise<ForemanLine[]> {
  const aps = await importAps();
  const core = await importCore();
  const by = required(options.by ?? process.env.APS_AGENT, 'by');
  const repo = required(options.repo, 'repo');
  if (!isAbsolute(repo) || !existsSync(join(repo, '.git')))
    throw new ApsInputError('--repo must be an absolute git repo');
  const max = Number(options.max ?? '6');
  if (!Number.isInteger(max) || max < 1) throw new ApsInputError('--max must be a positive integer');
  const acTimeoutMs = Number(options.acTimeout ?? '600') * 1000;
  const config = await core.loadConfig(resolve(options.projectDir ?? process.cwd()));
  const dbPath = aps.resolveApsDbPath({ flag: options.db, configPath: config.aps?.dbPath });
  const lines: ForemanLine[] = [];
  const db = aps.openApsDb(dbPath);
  const dispatchable: ChildRow[] = [];
  let live = 0;
  try {
    aps.doctor(db);
    aps.getCard(db, parent);
    const children = () =>
      db
        .prepare(
          `SELECT c.id,c.kind,c.size,c.state,c.scope,c.acceptance_json,v.rework_count,v.sha
           FROM cards c JOIN v_card_current v ON v.card_id=c.id WHERE c.parent_card=? ORDER BY c.id`,
        )
        .all(parent) as unknown as ChildRow[];
    for (const child of children()) {
      if (!aps.getLiveRun(db, child.id)) continue;
      const outcome = await collectRun(db, child.id, by, { waitMs: 0 });
      if (outcome.outcome === 'blocked' || outcome.outcome === 'abandoned')
        lines.push({
          card: child.id,
          worker: '-',
          result: 'blocked',
          sha: '-',
          ac: '-',
          rework: Number(child.rework_count),
          note: outcome.message,
        });
    }
    for (const child of children()) {
      if (child.state === 'closed_session') lines.push(await inspect(db, child, by, acTimeoutMs));
    }
    const fresh = children();
    for (const child of fresh) {
      const run = aps.getLiveRun(db, child.id);
      if (run) {
        live += 1;
        const worker = db.prepare('SELECT name FROM agents WHERE id=?').get(String(run.agent_id))?.name;
        lines.push({
          card: child.id,
          worker: String(worker ?? '-'),
          result: 'running',
          sha: '-',
          ac: '-',
          rework: Number(child.rework_count),
          note: String(run.run_id),
        });
      } else if (child.state === 'issued' || child.state === 'revise') dispatchable.push(child);
    }
  } finally {
    db.close();
  }
  const quota = dispatchable.length ? await probeQuota(options.quotaJson, Date.now()) : undefined;
  for (const child of dispatchable) {
    const base = { card: child.id, worker: '-', sha: '-', ac: '-', rework: Number(child.rework_count) };
    const gate = reworkGate(base.rework);
    if (gate !== 'dispatch') {
      lines.push({ ...base, result: gate, note: `${base.rework} failed attempts` });
      continue;
    }
    const placement = PLACEMENT[child.kind] ?? PLACEMENT.mech;
    if (placement.tier === 'L3' && child.size === 'L') {
      lines.push({ ...base, result: 'NEEDS_CARD_FIX', note: 'size L cannot go to L3 (APS-W02); split the card' });
      continue;
    }
    if (live >= max) {
      lines.push({ ...base, result: 'waiting', note: `--max ${max} lanes live` });
      continue;
    }
    try {
      const worktree = ensureWorktree(repo, child.id);
      const result = await autoDispatch(child.id, {
        ...options,
        by,
        worktree,
        tier: placement.tier,
        role: placement.role,
        quota,
      });
      const last = result.attempts.at(-1);
      const fallbacks = result.attempts
        .filter((attempt) => attempt.result === 'fallback')
        .map((attempt) => attempt.worker);
      if (last?.result === 'launched') live += 1;
      lines.push({
        ...base,
        worker: result.worker ?? '-',
        result: last?.result === 'launched' ? 'dispatched' : last?.result === 'exited' ? 'exited' : 'no-worker',
        note: [
          fallbacks.length ? `fallback from ${fallbacks.join(',')}` : '',
          last?.run ?? '',
          last && last.result !== 'launched' ? (last.reason ?? '') : '',
          result.skipped.length && !result.worker
            ? result.skipped.map((skip) => `${skip.id}: ${skip.reason}`).join('; ')
            : '',
        ]
          .filter(Boolean)
          .join(' '),
      });
    } catch (error) {
      if (dispatchExitCode(error) === 1) throw error;
      lines.push({ ...base, result: 'skipped', note: error instanceof Error ? error.message : String(error) });
    }
  }
  return lines;
}

export async function runForemanCommand(parent: string | undefined, options: ForemanOptions): Promise<void> {
  try {
    const card = required(parent, 'parent-card');
    const deadline = Date.now() + parseDuration(options.wait, 'wait');
    let lines = await foremanPass(card, options);
    while (Date.now() < deadline && lines.some((line) => line.result === 'running' || line.result === 'dispatched')) {
      await sleep(Math.min(30_000, Math.max(0, deadline - Date.now())));
      lines = await foremanPass(card, options);
    }
    if (options.json) emit(lines, true);
    else
      for (const line of lines)
        process.stdout.write(
          `${line.card} ${line.worker} ${line.result} ${line.sha} ac ${line.ac} rework ${line.rework}${line.note ? ` — ${line.note}` : ''}\n`,
        );
  } catch (error) {
    exitWithError(error instanceof Error ? error.message : String(error), dispatchExitCode(error));
  }
}
