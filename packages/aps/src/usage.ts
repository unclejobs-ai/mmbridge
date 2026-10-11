export interface UsageByModel {
  provider: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  costUsd: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function str(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value : 'unknown';
}

/**
 * Sums `message.usage` across an omp session JSONL transcript, grouped by `message.provider`/`message.model`.
 * Lines that are not JSON, not `type:'message'`, or carry no `usage` object are skipped; the parser never throws.
 * Messages with usage but no provider/model group under 'unknown'.
 */
export function parseOmpUsage(jsonlText: string): UsageByModel[] {
  const rows = new Map<string, UsageByModel>();
  for (const line of jsonlText.split('\n')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const entry = asRecord(parsed);
    if (entry === null || entry.type !== 'message') continue;
    const message = asRecord(entry.message);
    const usage = asRecord(message?.usage);
    if (message === null || usage === null) continue;
    const provider = str(message.provider);
    const model = str(message.model);
    const key = `${provider}\u0000${model}`;
    const row = rows.get(key) ?? {
      provider,
      model,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      costUsd: 0,
    };
    row.input += num(usage.input);
    row.output += num(usage.output);
    row.cacheRead += num(usage.cacheRead);
    row.cacheWrite += num(usage.cacheWrite);
    row.totalTokens += num(usage.totalTokens);
    row.costUsd += num(asRecord(usage.cost)?.total);
    rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => `${a.provider}/${a.model}`.localeCompare(`${b.provider}/${b.model}`));
}
