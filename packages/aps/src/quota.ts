/** Where a quota reading came from. omp = `omp usage --json` (MBP harness), codexbar = `codexbar usage --json` (Air). */
export type QuotaSource = 'omp' | 'codexbar';

/** One rate-limit window of one account, normalised across sources. */
export interface QuotaWindow {
  /** omp provider id: openai-codex, anthropic, zai, xai-oauth, opencode-go, google-antigravity, devin, cursor, ... */
  provider: string;
  source: QuotaSource;
  /** Account identifier as reported (already redacted upstream when requested); `#<n>` when absent. */
  account: string;
  /** Human label of the window, e.g. `7 days`, `Claude 5 Hour`. Used as the aggregation key. */
  label: string;
  /** 0..1, clamped. */
  usedFraction: number;
  /** Epoch ms of the next reset, null when unknown. */
  resetsAt: number | null;
  /** Window length in ms, null when unknown. */
  durationMs: number | null;
}

export interface QuotaWindowSummary {
  label: string;
  accounts: number;
  /** Mean used fraction across accounts (pooled capacity). */
  usedFraction: number;
  remainingFraction: number;
  /** Earliest reset across accounts. */
  resetsAt: number | null;
  /** True when every account in the pool is exhausted or projected to run out before its reset. */
  runsOutBeforeReset: boolean;
  /** Projected pool exhaustion (latest account exhaustion), null when not projected to run out. */
  exhaustsAt: number | null;
}

export interface ProviderQuota {
  provider: string;
  source: QuotaSource;
  windows: QuotaWindowSummary[];
  /** Minimum remainingFraction over windows. */
  remainingFraction: number;
  /** No new lanes: some window has < minRemaining left or runs out before reset. */
  blocked: boolean;
  /** First blocking window, human readable; null when not blocked. */
  reason: string | null;
}

export interface AssessQuotaOptions {
  /** Default 0.15 (APS §14 quota rule). */
  minRemaining?: number;
  /** Pace is not projected before this fraction of the window has elapsed. Default 0.02. */
  minElapsed?: number;
}

/** `codexbar usage --json` provider names → omp provider ids. */
export const CODEXBAR_PROVIDERS: Readonly<Record<string, string>> = {
  codex: 'openai-codex',
  claude: 'anthropic',
  zai: 'zai',
  devin: 'devin',
  grok: 'xai-oauth',
  xai: 'xai-oauth',
  opencodego: 'opencode-go',
  antigravity: 'google-antigravity',
  gemini: 'google-antigravity',
  cursor: 'cursor',
};

export function parseOmpUsageReport(_json: unknown): QuotaWindow[] {
  throw new Error('unimplemented: FOREMAN-L3-QUOTA');
}

export function parseCodexbarUsage(_json: unknown): QuotaWindow[] {
  throw new Error('unimplemented: FOREMAN-L3-QUOTA');
}

export function assessQuota(_windows: QuotaWindow[], _now: number, _options: AssessQuotaOptions = {}): ProviderQuota[] {
  throw new Error('unimplemented: FOREMAN-L3-QUOTA');
}
