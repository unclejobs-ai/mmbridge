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
  /** Pace is not projected below this used fraction: a few % early in a window is noise, not a burn. Default 0.1. */
  minUsed?: number;
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

const CODEXBAR_SLOTS = ['primary', 'secondary', 'tertiary'] as const;

/**
 * Normalises `omp usage --json` into one QuotaWindow per reported limit.
 * Limits without a finite `amount.usedFraction` are skipped; the parser never throws.
 */
export function parseOmpUsageReport(json: unknown): QuotaWindow[] {
  const reports = asRecord(json)?.reports;
  if (!Array.isArray(reports)) return [];
  const windows: QuotaWindow[] = [];
  for (const [index, rawReport] of reports.entries()) {
    const report = asRecord(rawReport);
    if (report === null) continue;
    const provider = nonEmptyString(report.provider);
    if (provider === null) continue;
    const metadata = asRecord(report.metadata);
    const account = nonEmptyString(metadata?.accountId) ?? nonEmptyString(metadata?.email) ?? `#${index}`;
    const limits = Array.isArray(report.limits) ? report.limits : [];
    for (const rawLimit of limits) {
      const limit = asRecord(rawLimit);
      const usedFraction = finiteNumber(asRecord(limit?.amount)?.usedFraction);
      if (limit === null || usedFraction === null) continue;
      const window = asRecord(limit.window);
      windows.push({
        provider,
        source: 'omp',
        account,
        label: nonEmptyString(limit.label) ?? 'unknown',
        usedFraction: clamp01(usedFraction),
        resetsAt: finiteNumber(window?.resetsAt),
        durationMs: finiteNumber(window?.durationMs),
      });
    }
  }
  return windows;
}

/**
 * Normalises `codexbar usage --json`. Providers not in CODEXBAR_PROVIDERS are skipped, as are
 * window slots that are null or carry a non-finite `usedPercent`. The parser never throws.
 */
export function parseCodexbarUsage(json: unknown): QuotaWindow[] {
  if (!Array.isArray(json)) return [];
  const windows: QuotaWindow[] = [];
  for (const [index, rawItem] of json.entries()) {
    const item = asRecord(rawItem);
    if (item === null) continue;
    const provider =
      typeof item.provider === 'string' && Object.hasOwn(CODEXBAR_PROVIDERS, item.provider)
        ? CODEXBAR_PROVIDERS[item.provider]
        : undefined;
    if (provider === undefined) continue;
    const usage = asRecord(item.usage);
    if (usage === null) continue;
    const account = nonEmptyString(usage.accountEmail) ?? `#${index}`;
    for (const slot of CODEXBAR_SLOTS) {
      const window = asRecord(usage[slot]);
      if (window === null) continue;
      const usedPercent = finiteNumber(window.usedPercent);
      if (usedPercent === null) continue;
      const windowMinutes = finiteNumber(window.windowMinutes);
      const resetsAt = typeof window.resetsAt === 'string' ? Date.parse(window.resetsAt) : Number.NaN;
      windows.push({
        provider,
        source: 'codexbar',
        account,
        label: windowMinutes !== null ? `${windowMinutes}m` : slot,
        usedFraction: clamp01(usedPercent / 100),
        resetsAt: Number.isFinite(resetsAt) ? resetsAt : null,
        durationMs: windowMinutes !== null ? windowMinutes * 60_000 : null,
      });
    }
  }
  return windows;
}

/** Projected exhaustion epoch ms for one window, or null when it cannot be paced or lasts to reset. */
function exhaustsAtOf(window: QuotaWindow, now: number, minElapsed: number, minUsed: number): number | null {
  const { usedFraction, resetsAt, durationMs } = window;
  if (usedFraction >= 1) return now;
  if (resetsAt === null || durationMs === null || durationMs <= 0 || usedFraction < minUsed || usedFraction <= 0)
    return null;
  const elapsed = clamp01(1 - (resetsAt - now) / durationMs);
  if (elapsed < minElapsed) return null;
  const exhaustsAt = now + ((1 - usedFraction) * elapsed * durationMs) / usedFraction;
  return exhaustsAt < resetsAt ? exhaustsAt : null;
}

/**
 * Pools windows per provider and per label, then marks a provider blocked when a window has
 * < minRemaining left or every account in it is projected to run out before reset.
 * When a provider appears from both probes only the omp windows are kept.
 */
export function assessQuota(windows: QuotaWindow[], now: number, options: AssessQuotaOptions = {}): ProviderQuota[] {
  const minRemaining = options.minRemaining ?? 0.15;
  const minElapsed = options.minElapsed ?? 0.02;
  const minUsed = options.minUsed ?? 0.1;

  const byProvider = new Map<string, QuotaWindow[]>();
  for (const window of windows) {
    const group = byProvider.get(window.provider);
    if (group === undefined) byProvider.set(window.provider, [window]);
    else group.push(window);
  }

  const quotas: ProviderQuota[] = [];
  for (const [provider, group] of byProvider) {
    // omp holds the dispatching credentials; when both probes saw a provider, codexbar adds nothing.
    const kept = group.some((window) => window.source === 'omp')
      ? group.filter((window) => window.source === 'omp')
      : group;

    const byLabel = new Map<string, QuotaWindow[]>();
    for (const window of kept) {
      const labelGroup = byLabel.get(window.label);
      if (labelGroup === undefined) byLabel.set(window.label, [window]);
      else labelGroup.push(window);
    }

    const summaries: QuotaWindowSummary[] = [];
    for (const [label, labelGroup] of byLabel) {
      const usedFraction = labelGroup.reduce((sum, window) => sum + window.usedFraction, 0) / labelGroup.length;
      let resetsAt: number | null = null;
      let exhaustsAt: number | null = null;
      let runsOutBeforeReset = true;
      for (const window of labelGroup) {
        if (window.resetsAt !== null && (resetsAt === null || window.resetsAt < resetsAt)) {
          resetsAt = window.resetsAt;
        }
        const projected = exhaustsAtOf(window, now, minElapsed, minUsed);
        if (projected === null) {
          runsOutBeforeReset = false;
        } else if (exhaustsAt === null || projected > exhaustsAt) {
          exhaustsAt = projected;
        }
      }
      if (!runsOutBeforeReset) exhaustsAt = null;
      summaries.push({
        label,
        accounts: labelGroup.length,
        usedFraction,
        remainingFraction: 1 - usedFraction,
        resetsAt,
        runsOutBeforeReset,
        exhaustsAt,
      });
    }

    let remainingFraction = Number.POSITIVE_INFINITY;
    let reason: string | null = null;
    for (const summary of summaries) {
      if (summary.remainingFraction < remainingFraction) remainingFraction = summary.remainingFraction;
      if (reason !== null) continue;
      if (summary.remainingFraction < minRemaining) {
        reason = `${summary.label}: ${Math.round(summary.remainingFraction * 100)}% left`;
      } else if (summary.runsOutBeforeReset) {
        const exhaustsIso = summary.exhaustsAt !== null ? new Date(summary.exhaustsAt).toISOString() : 'unknown';
        const resetsIso = summary.resetsAt !== null ? new Date(summary.resetsAt).toISOString() : 'unknown';
        reason = `${summary.label}: pace runs out ${exhaustsIso} before reset ${resetsIso}`;
      }
    }

    quotas.push({
      provider,
      source: kept[0].source,
      windows: summaries,
      remainingFraction,
      blocked: reason !== null,
      reason,
    });
  }
  return quotas.sort((a, b) => a.provider.localeCompare(b.provider));
}
