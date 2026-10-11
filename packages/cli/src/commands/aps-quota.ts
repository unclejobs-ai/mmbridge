import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type { ProviderQuota, QuotaWindow } from '@mmbridge/aps';
import { importAps, importCore } from './helpers.js';

export interface QuotaProbe {
  windows: QuotaWindow[];
  quota: ProviderQuota[];
  /** Where the windows came from: a file path, `omp`, or `codexbar`. */
  source: string | null;
  errors: string[];
}

/**
 * `--quota-json` file (object = `omp usage --json`, array = `codexbar usage --json`), else live
 * `omp usage --json` with `codexbar usage --json` as the fallback probe (Air has no omp usage).
 */
export async function probeQuota(file: string | undefined, now: number): Promise<QuotaProbe> {
  const aps = await importAps();
  const parse = (json: unknown) => (Array.isArray(json) ? aps.parseCodexbarUsage(json) : aps.parseOmpUsageReport(json));
  const result = (windows: QuotaWindow[], source: string | null, errors: string[]): QuotaProbe => ({
    windows,
    quota: aps.assessQuota(windows, now),
    source,
    errors,
  });
  if (file) return result(parse(JSON.parse(readFileSync(file, 'utf8'))), file, []);
  const core = await importCore();
  const errors: string[] = [];
  for (const binary of ['omp', 'codexbar']) {
    const run = await core.runCommand(binary, ['usage', '--json'], { timeoutMs: 60_000 });
    if (!run.ok) {
      errors.push(`${binary} usage --json exited ${run.code}: ${run.stderr.trim().split('\n').at(-1) ?? ''}`);
      continue;
    }
    try {
      return result(parse(JSON.parse(run.stdout)), binary, errors);
    } catch (error) {
      errors.push(`${binary} usage --json: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return result([], null, errors);
}

/** One quota_samples row per pooled window: vendor = omp provider, account = `pool`, metric = window label. */
export function recordQuotaSamples(db: DatabaseSync, quota: ProviderQuota[]): number {
  const insert = db.prepare("INSERT INTO quota_samples (vendor, account, metric, value) VALUES (?, 'pool', ?, ?)");
  let rows = 0;
  for (const provider of quota)
    for (const window of provider.windows) {
      insert.run(provider.provider, window.label, window.usedFraction);
      rows += 1;
    }
  return rows;
}
