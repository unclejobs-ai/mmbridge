import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { AuditLane, FailureClass, WorkerSpec } from '@mmbridge/aps';
import { ApsInputError } from '@mmbridge/aps';
import { type ApsDispatchOptions, type DispatchRecord, dispatchCard, dispatchExitCode } from './aps-dispatch.js';
import { herdrLanes, ledgerLanes } from './aps-lanes.js';
import { type QuotaProbe, probeQuota, recordQuotaSamples } from './aps-quota.js';
import { choice, emit, required } from './aps-shared.js';
import { exitWithError, importAps, importCore } from './helpers.js';

export interface AutoDispatchOptions extends ApsDispatchOptions {
  auto?: boolean;
  tier?: string;
  role?: string;
  /** Comma list of registry ids: explicit fallback chain in this order. */
  workers?: string;
  exclude?: string;
  ignoreQuota?: boolean;
  quotaJson?: string;
  workersFile?: string;
  /** Seconds to watch a launched worker for an immediate usage/auth/outage exit. */
  probe?: string;
  /** Pre-fetched quota (foreman probes once per pass); not a CLI flag. */
  quota?: QuotaProbe;
}

export interface AutoAttempt {
  worker: string;
  result: 'launched' | 'fallback' | 'launch-failed' | 'exited';
  run?: string;
  reason?: string;
}

export interface AutoDispatchResult {
  card: string;
  worker: string | null;
  launched: DispatchRecord | null;
  attempts: AutoAttempt[];
  skipped: Array<{ id: string; reason: string }>;
  quotaSource: string | null;
  quotaErrors: string[];
  vendorLoad: Record<string, number>;
}

const MANUAL_FLAGS = ['harness', 'kind', 'workspace', 'model', 'lane', 'layer', 'ompId', 'ompAgent', 'vendor'] as const;
const TAIL_BYTES = 16 * 1024;

function tail(path: string): string {
  if (!existsSync(path)) return '';
  const text = readFileSync(path, 'utf8');
  return text.slice(-TAIL_BYTES);
}

/** Maps a live lane to a registry vendor: exact model (effort stripped) first, then provider. */
export function laneVendors(lanes: AuditLane[], registry: readonly WorkerSpec[]): Record<string, number> {
  const bare = (model: string) => model.replace(/:[a-z]+$/, '');
  const load: Record<string, number> = {};
  for (const lane of lanes) {
    if (lane.status !== 'working') continue;
    const model = lane.model ? bare(lane.model) : null;
    const vendor =
      registry.find((worker) => model !== null && bare(worker.model) === model)?.vendor ??
      registry.find((worker) => lane.provider !== null && worker.provider === lane.provider)?.vendor ??
      lane.provider;
    if (vendor) load[vendor] = (load[vendor] ?? 0) + 1;
  }
  return load;
}

/** Waits up to probeMs for the headless worker to exit; returns the failure class of an early exit. */
async function watchLaunch(
  packet: string,
  probeMs: number,
): Promise<
  { state: 'running' | 'reported' } | { state: 'exited'; code: string; failure: FailureClass | null; excerpt: string }
> {
  const aps = await importAps();
  const deadline = Date.now() + probeMs;
  for (;;) {
    if (existsSync(join(packet, 'report.json'))) return { state: 'reported' };
    if (existsSync(join(packet, 'exit'))) {
      const text = ['out.log', 'err.log', 'out.json', 'dispatch.log']
        .map((file) => tail(join(packet, file)))
        .join('\n');
      const failure = aps.classifyFailure(text);
      const lines = text.split('\n').filter((line) => line.trim());
      return {
        state: 'exited',
        code: readFileSync(join(packet, 'exit'), 'utf8').trim(),
        failure,
        excerpt: (lines.find((line) => aps.classifyFailure(line) !== null) ?? lines.at(-1) ?? '').slice(0, 500),
      };
    }
    if (Date.now() >= deadline) return { state: 'running' };
    await sleep(Math.min(1000, Math.max(0, deadline - Date.now())));
  }
}

export async function autoDispatch(id: string | undefined, options: AutoDispatchOptions): Promise<AutoDispatchResult> {
  const aps = await importAps();
  const core = await importCore();
  const cardId = required(id, 'card');
  const by = required(options.by ?? process.env.APS_AGENT, 'by');
  for (const flag of MANUAL_FLAGS)
    if (options[flag] !== undefined) throw new ApsInputError(`--auto picks the worker; drop --${flag}`);
  const tier = choice(options.tier, 'tier', ['L2', 'L3'], 'L3') as WorkerSpec['tier'];
  const role = choice(options.role, 'role', ['mech', 'review', 'design', 'vision'], 'mech') as WorkerSpec['roles'][0];
  const probeMs = Number(options.probe ?? '60') * 1000;
  if (!Number.isFinite(probeMs) || probeMs < 0) throw new ApsInputError('--probe must be seconds >= 0');
  const registry = options.workersFile
    ? aps.parseWorkerRegistry(JSON.parse(readFileSync(options.workersFile, 'utf8')))
    : aps.DEFAULT_WORKERS;
  const list = (value: string | undefined) =>
    value
      ?.split(',')
      .map((item) => item.trim())
      .filter(Boolean);

  const config = await core.loadConfig(options.projectDir ?? process.cwd());
  const dbPath = aps.resolveApsDbPath({ flag: options.db, configPath: config.aps?.dbPath });
  const now = Date.now();
  const probed = options.quota ?? (await probeQuota(options.quotaJson, now));
  const quota = { ...probed, errors: [...probed.errors] };
  let lanes: AuditLane[] = [];
  try {
    lanes = await herdrLanes();
  } catch (error) {
    quota.errors.push(`herdr lanes: ${error instanceof Error ? error.message : String(error)}`);
  }
  const reader = aps.openApsDbReadOnly(dbPath);
  try {
    if (Number(reader.prepare('PRAGMA user_version').get()?.user_version) >= 2)
      lanes = [...lanes, ...(await ledgerLanes(reader, lanes))];
  } finally {
    reader.close();
  }
  const vendorLoad = laneVendors(lanes, registry);
  const ranked = aps.rankWorkers(registry, {
    tier,
    role,
    quota: quota.quota,
    vendorLoad,
    only: list(options.workers),
    exclude: list(options.exclude),
    ignoreQuota: options.ignoreQuota,
  });
  const result: AutoDispatchResult = {
    card: cardId,
    worker: null,
    launched: null,
    attempts: [],
    skipped: ranked.skipped,
    quotaSource: quota.source,
    quotaErrors: quota.errors,
    vendorLoad,
  };
  const dispatchOptions = (worker: WorkerSpec): ApsDispatchOptions => ({
    ...options,
    harness: worker.harness,
    lane: worker.id,
    layer: worker.tier,
    model: worker.model,
    vendor: worker.vendor,
    ompAgent: worker.agent ?? undefined,
  });
  if (options.dryRun) {
    const first = ranked.candidates[0];
    if (first) {
      result.worker = first.id;
      result.launched = await dispatchCard(cardId, dispatchOptions(first));
    }
    return result;
  }
  if (quota.quota.length) {
    const db = aps.openApsDb(dbPath);
    try {
      aps.transaction(db, () => recordQuotaSamples(db, quota.quota));
    } finally {
      db.close();
    }
  }
  for (const worker of ranked.candidates) {
    let record: DispatchRecord;
    try {
      record = await dispatchCard(cardId, dispatchOptions(worker));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Refusals (card state, worktree, missing binary, guards) are not worker failures: a missing binary skips
      // this worker, every other refusal applies to all workers.
      if (/ is not on PATH$|^omp agent \S+ not found$/.test(message)) {
        result.skipped.push({ id: worker.id, reason: message });
        continue;
      }
      if (dispatchExitCode(error) !== 1) throw error;
      result.attempts.push({ worker: worker.id, result: 'launch-failed', reason: message });
      continue;
    }
    const run = String(record.run);
    const watched = await watchLaunch(String(record.packet), probeMs);
    if (watched.state !== 'exited') {
      result.attempts.push({ worker: worker.id, result: 'launched', run });
      result.worker = worker.id;
      result.launched = record;
      return result;
    }
    if (watched.failure === null) {
      // Unknown early exit: leave the run for collect (it records failed/blocked with evidence).
      result.attempts.push({
        worker: worker.id,
        result: 'exited',
        run,
        reason: `exit ${watched.code}: ${watched.excerpt}`,
      });
      result.worker = worker.id;
      result.launched = record;
      return result;
    }
    const db = aps.openApsDb(dbPath);
    try {
      aps.transaction(db, () => {
        aps.addRunEvent(db, run, 'failed', by, {
          fallback: watched.failure,
          worker: worker.id,
          exit: watched.code,
          excerpt: watched.excerpt,
        });
        aps.closeSession(db, String(record.agent), by, `fallback ${watched.failure}: ${worker.id} → next worker`, true);
      });
    } finally {
      db.close();
    }
    result.attempts.push({
      worker: worker.id,
      result: 'fallback',
      run,
      reason: `${watched.failure}: ${watched.excerpt}`,
    });
  }
  return result;
}

export async function runAutoDispatchCommand(id: string | undefined, options: AutoDispatchOptions): Promise<void> {
  let result: AutoDispatchResult;
  try {
    result = await autoDispatch(id, options);
  } catch (error) {
    exitWithError(error instanceof Error ? error.message : String(error), dispatchExitCode(error));
  }
  const running = result.attempts.at(-1)?.result === 'launched' || (options.dryRun && result.launched !== null);
  if (options.json) emit(result, true);
  else {
    for (const skip of result.skipped) process.stdout.write(`skip ${skip.id}: ${skip.reason}\n`);
    for (const attempt of result.attempts)
      process.stdout.write(
        `${attempt.result} ${attempt.worker}${attempt.run ? ` run ${attempt.run}` : ''}${attempt.reason ? `: ${attempt.reason}` : ''}\n`,
      );
    for (const error of result.quotaErrors) process.stderr.write(`[mmbridge] ${error}\n`);
    if (options.dryRun && result.launched) emit(result.launched, false);
    else if (result.launched) process.stdout.write(`next: ${String(result.launched.next)}\n`);
  }
  if (!running) exitWithError(result.launched ? 'worker exited early; collect the run' : 'no worker launched', 1);
}
