import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { type Attempt, type DispatchResult, dispatch } from './dispatch.js';
import { DEFAULT_MMBRIDGE_HOME } from './roles.js';

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;
const VALIDATE_TIMEOUT_MS = 10 * 60 * 1000;
const OUTPUT_TAIL_CHARS = 4000;
const SEVERITIES = new Set(['critical', 'major', 'minor']);

const REVIEW_INSTRUCTIONS = `Review the diff below against the task. Respond with ONLY a JSON object and no other text:
{"verdict":"pass"|"block","findings":[{"severity":"critical"|"major"|"minor","file":"<path>","message":"<what is wrong>"}]}
Use "block" if any finding is critical or major. Use an empty findings array if you found nothing.`;

export interface Finding {
  severity: 'critical' | 'major' | 'minor';
  file?: string;
  message: string;
}

export interface Review {
  verdict: 'pass' | 'block';
  findings: Finding[];
  /** `provider/model` that reviewed — always a different provider from the worker's. */
  model: string;
  attempts: Attempt[];
}

export interface Validation {
  command: string;
  exitCode: number;
  outputTail: string;
}

export interface ImplementInput {
  task: string;
  projectDir: string;
  /** Shell command run in the worktree after review, e.g. `pnpm install --frozen-lockfile && pnpm test`. */
  validate?: string;
  mmbridgeHome?: string;
  ompConfigPath?: string;
  binary?: string;
  timeoutMs?: number;
}

export interface ImplementResult {
  gate: 'pass' | 'block';
  /** Why the gate blocked; empty when it passed. */
  reasons: string[];
  /** The worker's isolated checkout. Changes are staged there, not committed, and never touch the main checkout. */
  worktree: string;
  branch: string;
  /** Shell command that removes the worktree and deletes the branch — run it after merging or discarding. */
  cleanup: string;
  baseRef: string;
  diff: string;
  worker?: DispatchResult;
  review?: Review;
  validate?: Validation;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: MAX_BUFFER });
  return stdout;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFinding(value: unknown): value is Finding {
  return (
    isRecord(value) &&
    typeof value.severity === 'string' &&
    SEVERITIES.has(value.severity) &&
    typeof value.message === 'string' &&
    (value.file === undefined || typeof value.file === 'string')
  );
}

/** Extracts the reviewer's JSON verdict, tolerating prose around it. Undefined when it doesn't match the schema. */
function parseReview(text: string): Pick<Review, 'verdict' | 'findings'> | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || (parsed.verdict !== 'pass' && parsed.verdict !== 'block')) return undefined;
  if (!Array.isArray(parsed.findings) || !parsed.findings.every(isFinding)) return undefined;
  return { verdict: parsed.verdict, findings: parsed.findings };
}

async function runValidate(cwd: string, command: string): Promise<Validation> {
  try {
    const { stdout, stderr } = await execFileAsync('sh', ['-c', command], {
      cwd,
      timeout: VALIDATE_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
    return { command, exitCode: 0, outputTail: `${stdout}${stderr}`.slice(-OUTPUT_TAIL_CHARS) };
  } catch (err) {
    if (!isRecord(err) || typeof err.code !== 'number') throw err;
    const output = `${String(err.stdout ?? '')}${String(err.stderr ?? '')}`;
    return { command, exitCode: err.code, outputTail: output.slice(-OUTPUT_TAIL_CHARS) };
  }
}

/**
 * The implement → review → validate gate: a worker edits an isolated git worktree, a reviewer from a
 * different provider judges the diff as schema-checked JSON, and an optional command validates it.
 */
export async function implement(input: ImplementInput): Promise<ImplementResult> {
  const home = input.mmbridgeHome ?? DEFAULT_MMBRIDGE_HOME;
  const root = (await git(input.projectDir, ['rev-parse', '--show-toplevel'])).trim();
  const baseRef = (await git(root, ['rev-parse', 'HEAD'])).trim();
  const id = `${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`;
  const branch = `mmbridge/worker-${id}`;
  const worktree = join(home, 'worktrees', `${basename(root)}-${id}`);
  await mkdir(dirname(worktree), { recursive: true });
  await git(root, ['worktree', 'add', '-q', '-b', branch, worktree, baseRef]);

  const shared = {
    mmbridgeHome: home,
    ...(input.ompConfigPath ? { ompConfigPath: input.ompConfigPath } : {}),
    ...(input.binary ? { binary: input.binary } : {}),
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
  };
  const cleanup = `git -C ${shellQuote(root)} worktree remove --force ${shellQuote(worktree)} && git -C ${shellQuote(root)} branch -D ${shellQuote(branch)}`;
  const result: ImplementResult = { gate: 'block', reasons: [], worktree, branch, cleanup, baseRef, diff: '' };

  try {
    result.worker = await dispatch({ role: 'worker', task: input.task, cwd: worktree, tools: true, ...shared });
  } catch (err) {
    result.reasons.push(`worker failed: ${errorText(err)}`);
    return result;
  }
  if (result.worker.stopReason === 'error') {
    result.reasons.push(`worker failed: ${result.worker.errorMessage ?? 'unknown error'}`);
    return result;
  }

  await git(worktree, ['add', '-A']);
  result.diff = await git(worktree, ['diff', '--cached', baseRef]);
  if (result.diff.trim() === '') {
    result.reasons.push('worker made no changes');
    return result;
  }

  let reviewer: DispatchResult;
  try {
    reviewer = await dispatch({
      role: 'reviewer',
      task: `${REVIEW_INSTRUCTIONS}\n\nTask:\n${input.task}\n\nDiff:\n${result.diff}`,
      cwd: worktree,
      excludeProviders: [result.worker.provider],
      ...shared,
    });
  } catch (err) {
    result.reasons.push(`review failed: ${errorText(err)}`);
    return result;
  }
  const verdict = reviewer.stopReason === 'error' ? undefined : parseReview(reviewer.text);
  if (reviewer.stopReason === 'error') {
    result.reasons.push(`review failed: ${reviewer.errorMessage ?? 'unknown error'}`);
  } else if (!verdict) {
    result.reasons.push('review output is not valid review JSON');
  } else {
    result.review = { ...verdict, model: `${reviewer.provider}/${reviewer.modelId}`, attempts: reviewer.attempts };
    const serious = verdict.findings.filter((f) => f.severity !== 'minor');
    if (verdict.verdict === 'block' || serious.length > 0) {
      result.reasons.push(`reviewer blocked: ${serious.map((f) => f.message).join('; ') || 'no reason given'}`);
    }
  }

  if (input.validate) {
    result.validate = await runValidate(worktree, input.validate);
    if (result.validate.exitCode !== 0) result.reasons.push(`validate failed (exit ${result.validate.exitCode})`);
  }
  if (result.reasons.length === 0) result.gate = 'pass';
  return result;
}
