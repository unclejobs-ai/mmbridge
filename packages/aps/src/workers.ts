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

/** Order = MODEL-ROUTING §0 preference and fallback order within a tier. */
export const DEFAULT_WORKERS: readonly WorkerSpec[] = [];

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

export function parseWorkerRegistry(_json: unknown): WorkerSpec[] {
  throw new Error('unimplemented: FOREMAN-L3-WORKERS');
}

export function rankWorkers(_registry: readonly WorkerSpec[], _input: RankInput): RankResult {
  throw new Error('unimplemented: FOREMAN-L3-WORKERS');
}

export function classifyFailure(_text: string): FailureClass | null {
  throw new Error('unimplemented: FOREMAN-L3-WORKERS');
}
