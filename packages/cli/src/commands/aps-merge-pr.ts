import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ApsInputError, type Row } from '@mmbridge/aps';
import { adoptExitCode } from './aps-adopt.js';
import { type ApsCommandOptions, emit, required } from './aps-shared.js';
import { exitWithError, importAps, importCore } from './helpers.js';

export interface ApsMergePrOptions extends ApsCommandOptions {
  repo?: string;
  done?: boolean;
}

/** The `gh pr view --json` fields `aps merge --pr` relies on. */
export const PR_VIEW_FIELDS = 'state,mergedAt,headRefOid,mergeCommit,baseRefName,url';

export interface PrView {
  state: string;
  mergedAt: string | null;
  headRefOid: string;
  mergeCommit: string | null;
  baseRefName: string;
  url: string;
}

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
// git check-ref-format subset: no leading '-' (argv flag injection), no '..', no whitespace or control chars.
const BRANCH = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]+$/;

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Parses `gh pr view --json ${PR_VIEW_FIELDS}` output; refuses malformed shas and base names. */
export function parsePrView(stdout: string): PrView {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(stdout);
  } catch {
    throw new Error('gh pr view returned invalid JSON');
  }
  if (!raw || typeof raw !== 'object') throw new Error('gh pr view returned invalid JSON');
  const headRefOid = text(raw.headRefOid).toLowerCase();
  if (!SHA.test(headRefOid)) throw new Error(`gh pr view headRefOid is not a sha: ${JSON.stringify(raw.headRefOid)}`);
  const commit = raw.mergeCommit as { oid?: unknown } | null | undefined;
  const mergeCommit = commit && typeof commit === 'object' ? text(commit.oid).toLowerCase() : '';
  if (mergeCommit && !SHA.test(mergeCommit))
    throw new Error(`gh pr view mergeCommit.oid is not a sha: ${JSON.stringify(commit?.oid)}`);
  const baseRefName = text(raw.baseRefName);
  if (!BRANCH.test(baseRefName))
    throw new Error(`gh pr view baseRefName is not a branch: ${JSON.stringify(baseRefName)}`);
  return {
    state: text(raw.state),
    mergedAt: text(raw.mergedAt) || null,
    headRefOid,
    mergeCommit: mergeCommit || null,
    baseRefName,
    url: text(raw.url),
  };
}

/**
 * Squash-acceptance check: the PR is MERGED, its head is exactly the reviewed sha (replaces H03, which a squash
 * commit cannot pass), and it has a merge commit. Returns the merge commit; the caller proves it is on the base.
 */
export function checkPrMerge(pr: number, view: PrView, reviewedSha: string): string {
  if (view.state !== 'MERGED') throw new Error(`APS-H12: PR #${pr} is ${view.state || 'unknown'}, not MERGED`);
  if (view.headRefOid !== reviewedSha)
    throw new Error(`APS-H11: PR head ${view.headRefOid} is not the reviewed sha ${reviewedSha}`);
  if (!view.mergeCommit) throw new Error(`APS-H13: PR #${pr} has no merge commit`);
  return view.mergeCommit;
}

export function mergeRef(pr: number, head: string): string {
  return `merge:${pr}@${head}`;
}

function parsePr(value: string | undefined): number {
  const raw = required(value, 'pr');
  if (!/^[1-9]\d{0,9}$/.test(raw)) throw new ApsInputError('--pr must be a positive pull request number');
  return Number(raw);
}

/** Same project scoping as `aps merge --merged-sha` (issue #15). */
function assertScope(card: Row, cardId: string, scope: string | undefined): void {
  if (scope) {
    if (String(card.project) !== scope)
      throw new ApsInputError(
        `card ${cardId} belongs to project ${card.project}, not ${scope}; run aps merge from ${card.project}'s workspace or pass --project ${card.project} deliberately`,
      );
  } else
    process.stderr.write(
      '[mmbridge] warning: aps merge card lookup is not scoped by project (set aps.project in .mmbridge.config.json or pass --project); a wrong card id can record a stray cross-repo merge row\n',
    );
}

/**
 * `aps merge <card> --pr <n> [--repo owner/name] [--done]`: records a GitHub-merged PR (squash, merge or rebase) for
 * the card's reviewed sha. gh/git run before the ledger write lock is taken. Idempotent on `merged_sha` or the
 * `merge:<pr>@<head>` ref. `--done` then moves merge_wait→done; a refused done guard leaves merge_wait and is reported.
 */
export async function runApsMergePrCommand(
  _action: string,
  id: string | undefined,
  options: ApsMergePrOptions,
): Promise<void> {
  const aps = await importAps();
  let db: DatabaseSync | undefined;
  try {
    const cardId = required(id, 'card');
    const by = required(options.by ?? process.env.APS_AGENT, 'by');
    const pr = parsePr(options.pr);
    if (options.mergedSha || options.appliedRef)
      throw new ApsInputError('--pr cannot be combined with --merged-sha or --applied-ref');
    if (options.gate) throw new ApsInputError('--gate is not supported with --pr (the PR was already merged)');
    const repo = options.repo === undefined ? undefined : options.repo.trim();
    if (repo !== undefined && !REPO.test(repo)) throw new ApsInputError('--repo must look like owner/name');
    const projectDir = resolve(options.projectDir ?? process.cwd());
    const core = await importCore();
    const config = await core.loadConfig(projectDir);
    const dbPath = aps.resolveApsDbPath({ flag: options.db, configPath: config.aps?.dbPath });

    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 5000');
    aps.doctor(db);
    const card = aps.getCard(db, cardId);
    assertScope(card, cardId, options.project ?? config.aps?.project);
    const reviewed = card.sha === null ? '' : String(card.sha);
    if (!reviewed) throw new ApsInputError(`card ${cardId} has no reported sha`);
    db.close();
    db = undefined;

    const ghArgs = ['pr', 'view', String(pr), ...(repo ? ['-R', repo] : []), '--json', PR_VIEW_FIELDS];
    const gh = await core.runCommand('gh', ghArgs, { cwd: projectDir, timeoutMs: 60_000 });
    if (!gh.ok) throw new Error(`gh ${ghArgs.join(' ')} failed: ${gh.stderr.trim() || `exit ${gh.code}`}`);
    const view = parsePrView(gh.stdout);
    const merged = checkPrMerge(pr, view, reviewed);
    const base = view.baseRefName;
    const git = (args: string[]) => core.runCommand('git', args, { cwd: projectDir, timeoutMs: 60_000 });
    const fetched = await git(['fetch', '-q', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`]);
    if (!fetched.ok)
      throw new Error(
        `APS-H13: cannot verify merge commit ${merged} on origin/${base}: git fetch origin ${base} failed (${fetched.stderr.trim() || `exit ${fetched.code}`})`,
      );
    const target = await git(['rev-parse', '--verify', `refs/remotes/origin/${base}^{commit}`]);
    const targetSha = target.stdout.trim();
    const landed = target.ok ? await git(['merge-base', '--is-ancestor', merged, targetSha]) : null;
    if (!landed?.ok) throw new Error(`APS-H13: merge commit ${merged} is not on origin/${base}`);
    const ref = mergeRef(pr, view.headRefOid);
    const verify = `${ref} gh pr view ${ghArgs.slice(2).join(' ')} (state MERGED, headRefOid ${view.headRefOid}) && git merge-base --is-ancestor ${merged} origin/${base}=${targetSha}`;

    db = aps.openApsDb(dbPath);
    const ledger = db;
    aps.doctor(ledger);
    const result = await aps.commandTransaction(ledger, async () => {
      const current = aps.getCard(ledger, cardId);
      if (String(current.sha) !== view.headRefOid)
        throw new Error(`APS-H11: PR head ${view.headRefOid} is not the reviewed sha ${current.sha}`);
      const existing = ledger
        .prepare('SELECT id FROM merges WHERE card_id=? AND (merged_sha=? OR applied_ref=?) ORDER BY id LIMIT 1')
        .get(cardId, merged, ref);
      const mergeId = existing
        ? Number(existing.id)
        : aps.insertRow(ledger, 'merges', {
            card_id: cardId,
            sha: view.headRefOid,
            merged_sha: merged,
            applied_ref: ref,
            target: base,
            verified_by: by,
            verify_command: verify,
          });
      let doneBlocked: string | null = null;
      if (options.done) {
        const state = String(aps.getCard(ledger, cardId).state);
        if (state === 'merge_wait') {
          try {
            aps.moveCard(ledger, cardId, 'done', by);
          } catch (error) {
            // A RAISE(ABORT) guard undoes only the refused transition; the merge row stays in this transaction.
            const message = error instanceof Error ? error.message : String(error);
            if (!message.startsWith('APS-')) throw error;
            doneBlocked = message;
          }
        } else if (state !== 'done') doneBlocked = `card ${cardId} is ${state}, not merge_wait`;
      }
      return {
        card: cardId,
        pr,
        url: view.url,
        merge_id: mergeId,
        recorded: !existing,
        sha: view.headRefOid,
        merged_sha: merged,
        applied_ref: ref,
        target: base,
        state: String(aps.getCard(ledger, cardId).state),
        done_blocked: doneBlocked,
      };
    });
    if (result.done_blocked) process.stderr.write(`[mmbridge] done blocked: ${result.done_blocked}\n`);
    emit(
      options.json
        ? result
        : `${cardId} merge ${result.merge_id} ${result.recorded ? 'recorded' : 'already recorded'} ${ref} → ${merged} on ${base}; state ${result.state}`,
      options.json,
    );
  } catch (error) {
    exitWithError(error instanceof Error ? error.message : String(error), adoptExitCode(error));
  } finally {
    db?.close();
  }
}
