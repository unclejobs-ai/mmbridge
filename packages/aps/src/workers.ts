import { ApsInputError } from './ledger.js';
import type { ProviderQuota } from './quota.js';

/** Harnesses the run ledger accepts (0002 worker_runs.harness CHECK). */
export type WorkerHarness = 'omp' | 'devin' | 'grok';
export type WorkerTier = 'L2' | 'L3';
/** mech = implement a card; review/design = L2 judgment; vision = screenshot/taste verdict. */
export type WorkerRole = 'mech' | 'review' | 'design' | 'vision';

export interface WorkerSpec {
  /** Stable registry id, `[a-z0-9-]+`. Also the dispatch lane name. */
  id: string;
  tier: WorkerTier;
  /** Ledger agents.vendor, `[a-z0-9-]+` (heijunka key). */
  vendor: string;
  /** Quota key: omp provider id (see quota.ts). */
  provider: string;
  harness: WorkerHarness;
  /** Model passed to the harness (`--model`). */
  model: string;
  /** omp agent definition name (`~/.omp/agent/agents/<agent>.md`) appended as system prompt; null for none. */
  agent: string | null;
  roles: WorkerRole[];
}

const worker = (
  id: string,
  tier: WorkerTier,
  vendor: string,
  provider: string,
  harness: WorkerHarness,
  model: string,
  agent: string | null,
  roles: WorkerRole[],
): WorkerSpec =>
  // Frozen so callers cannot mutate the shared defaults; WorkerSpec keeps a mutable type for parsed registries.
  Object.freeze({ id, tier, vendor, provider, harness, model, agent, roles: Object.freeze(roles) as WorkerRole[] });

/**
 * 10/17 routing (orchestration-protocol §5). Order = preference and fallback order within a tier.
 * `agent` names the omp definition in `~/.omp/agent/agents/`; its `model` line matches `model` here.
 * L3 holds the only auto-dispatched mech workers. L2 never takes mech: Opus/Sol/Astra do not get mech cards.
 */
export const DEFAULT_WORKERS: readonly WorkerSpec[] = Object.freeze([
  worker('glm', 'L3', 'zai', 'zai', 'omp', 'zai/glm-5.3:high', 'w-glm', ['mech']),
  worker('cursor-grok', 'L3', 'cursor', 'cursor', 'omp', 'cursor/grok-4.7-500k-fast:high', 'w-cursor-grok', ['mech']),
  worker('glmflash', 'L3', 'zai', 'zai', 'omp', 'zai/glm-5.3-flash:high', 'w-glmflash', ['mech']),
  // Code review: GPT Codex, so the reviewer is a different model family from the Opus author.
  worker('sol', 'L2', 'openai', 'openai-codex', 'omp', 'openai-codex/gpt-6.1-sol:high', 'w-sol', ['review']),
  worker('astra', 'L2', 'openai', 'openai-codex', 'omp', 'openai-codex/gpt-6-astra:high', 'w-astra', ['review']),
  // UI implementation/design runs on Opus high or above; the DESIGN_OK visual verdict on Opus xhigh.
  worker('opus-high', 'L2', 'anthropic', 'anthropic', 'omp', 'anthropic/claude-opus-5-5:high', 'w-opus-high', [
    'design',
  ]),
  worker('opus-xhigh', 'L2', 'anthropic', 'anthropic', 'omp', 'anthropic/claude-opus-5-5:xhigh', 'w-opus-xhigh', [
    'vision',
  ]),
]);

export interface RankInput {
  tier: WorkerTier;
  role: WorkerRole;
  quota: ProviderQuota[];
  /** Live lanes per vendor right now (heijunka). Missing vendor = 0. */
  vendorLoad: Record<string, number>;
  /** Explicit chain of worker ids: keeps this order, skips vendor spread. */
  only?: string[];
  exclude?: string[];
  /** Ignore quota blocks (forced fallback demos, operator override). */
  ignoreQuota?: boolean;
}

export interface RankResult {
  candidates: WorkerSpec[];
  skipped: Array<{ id: string; reason: string }>;
}

export type FailureClass = 'usage-limit' | 'auth' | 'outage';

const ID_VENDOR_REGEX = /^[a-z0-9-]+$/;
const ALLOWED_TIERS: Record<string, true> = { L2: true, L3: true };
const ALLOWED_HARNESSES: Record<string, true> = { omp: true, devin: true, grok: true };
const ALLOWED_ROLES: Record<string, true> = { mech: true, review: true, design: true, vision: true };

export function parseWorkerRegistry(json: unknown): WorkerSpec[] {
  let list: unknown[] | null = null;
  if (Array.isArray(json)) {
    list = json;
  } else if (typeof json === 'object' && json !== null && 'workers' in json) {
    const rawWorkers = json.workers;
    if (Array.isArray(rawWorkers)) {
      list = rawWorkers;
    }
  }

  if (list === null) {
    throw new ApsInputError('worker registry: root: expected array or {workers:[...]}');
  }

  const seenIds = new Set<string>();
  const result: WorkerSpec[] = [];

  for (let i = 0; i < list.length; i++) {
    const entry = list[i];
    let loc = String(i);
    if (typeof entry === 'object' && entry !== null && 'id' in entry && typeof entry.id === 'string' && entry.id) {
      loc = entry.id;
    }

    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new ApsInputError(`worker registry: ${loc}: expected object`);
    }

    if (!('id' in entry) || typeof entry.id !== 'string' || !ID_VENDOR_REGEX.test(entry.id)) {
      throw new ApsInputError(`worker registry: ${loc}: invalid id`);
    }

    const id = entry.id;
    if (seenIds.has(id)) {
      throw new ApsInputError(`worker registry: ${id}: duplicate id`);
    }
    seenIds.add(id);

    if (!('vendor' in entry) || typeof entry.vendor !== 'string' || !ID_VENDOR_REGEX.test(entry.vendor)) {
      throw new ApsInputError(`worker registry: ${id}: invalid vendor`);
    }
    const vendor = entry.vendor;

    if (!('tier' in entry) || typeof entry.tier !== 'string' || !(entry.tier in ALLOWED_TIERS)) {
      throw new ApsInputError(`worker registry: ${id}: invalid tier`);
    }
    const tier = entry.tier as WorkerTier;

    if (!('harness' in entry) || typeof entry.harness !== 'string' || !(entry.harness in ALLOWED_HARNESSES)) {
      throw new ApsInputError(`worker registry: ${id}: invalid harness`);
    }
    const harness = entry.harness as WorkerHarness;

    if (!('model' in entry) || typeof entry.model !== 'string' || entry.model.trim() === '') {
      throw new ApsInputError(`worker registry: ${id}: empty model`);
    }
    const model = entry.model;

    if (!('provider' in entry) || typeof entry.provider !== 'string' || entry.provider.trim() === '') {
      throw new ApsInputError(`worker registry: ${id}: empty provider`);
    }
    const provider = entry.provider;

    if (!('agent' in entry) || (entry.agent !== null && typeof entry.agent !== 'string')) {
      throw new ApsInputError(`worker registry: ${id}: invalid agent`);
    }
    const agent = entry.agent;

    if (!('roles' in entry) || !Array.isArray(entry.roles) || entry.roles.length === 0) {
      throw new ApsInputError(`worker registry: ${id}: roles must be a non-empty array`);
    }

    const roles: WorkerRole[] = [];
    for (const r of entry.roles) {
      if (typeof r !== 'string' || !(r in ALLOWED_ROLES)) {
        throw new ApsInputError(`worker registry: ${id}: invalid role ${String(r)}`);
      }
      roles.push(r as WorkerRole);
    }

    result.push({
      id,
      tier,
      vendor,
      provider,
      harness,
      model,
      agent,
      roles,
    });
  }

  return result;
}

export function rankWorkers(registry: readonly WorkerSpec[], input: RankInput): RankResult {
  const skipped: Array<{ id: string; reason: string }> = [];
  const quotaMap = new Map<string, ProviderQuota>();
  for (const q of input.quota ?? []) {
    quotaMap.set(q.provider, q);
  }

  const excludeSet = new Set(input.exclude ?? []);

  let orderedCandidates: WorkerSpec[] = [];

  if (input.only) {
    const regMap = new Map<string, WorkerSpec>();
    for (const w of registry) {
      regMap.set(w.id, w);
    }

    for (const id of input.only) {
      const worker = regMap.get(id);
      if (!worker || worker.tier !== input.tier || !worker.roles.includes(input.role)) {
        skipped.push({ id, reason: `not a ${input.tier} ${input.role} worker` });
        continue;
      }
      orderedCandidates.push(worker);
    }
  } else {
    const matching = registry.filter((w) => w.tier === input.tier && w.roles.includes(input.role));
    // Stable sort by vendorLoad[vendor] ?? 0 ascending, then registry order.
    // In JS/V8 Array.prototype.sort is stable.
    orderedCandidates = [...matching].sort((a, b) => {
      const loadA = input.vendorLoad[a.vendor] ?? 0;
      const loadB = input.vendorLoad[b.vendor] ?? 0;
      return loadA - loadB;
    });
  }

  const candidates: WorkerSpec[] = [];

  for (const worker of orderedCandidates) {
    if (excludeSet.has(worker.id)) {
      skipped.push({ id: worker.id, reason: 'excluded' });
      continue;
    }

    const quota = quotaMap.get(worker.provider);
    if (quota && quota.blocked === true && !input.ignoreQuota) {
      skipped.push({ id: worker.id, reason: `quota: ${quota.reason}` });
      continue;
    }

    candidates.push(worker);
  }

  return { candidates, skipped };
}

const USAGE_LIMIT_REGEX =
  /usage limit|rate[ -]?limit|quota (?:exceeded|exhausted)|limit reached|exceeded your|insufficient (?:credits|quota|balance)|out of credits|too many requests|\b429\b/i;
const AUTH_REGEX =
  /unauthori[sz]ed|\b401\b|\b403\b|forbidden|(?:token|oauth|session|credential)s? (?:has )?expired|not logged in|please (?:log ?in|login|re-?authenticate)|invalid api key|authentication (?:failed|required)|untrusted workspace/i;
const OUTAGE_REGEX =
  /\b50[0234]\b|overloaded|service unavailable|bad gateway|internal server error|econnreset|etimedout|enotfound|econnrefused|socket hang up|network error/i;

export function classifyFailure(text: string): FailureClass | null {
  if (USAGE_LIMIT_REGEX.test(text)) return 'usage-limit';
  if (AUTH_REGEX.test(text)) return 'auth';
  if (OUTAGE_REGEX.test(text)) return 'outage';
  return null;
}
