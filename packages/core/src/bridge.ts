import { enrichFindings, sortFindings } from './report.js';
import type { BridgeOptions, BridgeResult, Finding, Severity } from './types.js';

const DEFAULT_PROFILE = 'standard';

const CONSENSUS_THRESHOLD: Record<string, number> = {
  standard: 2,
  strict: 1,
  relaxed: 3,
};

export function runBridge(options: BridgeOptions = {}): BridgeResult {
  const profile = options.profile ?? DEFAULT_PROFILE;
  const results = options.results ?? [];
  const projectContext = options.projectContext;

  const nonSkipped = results.filter((r) => !r.skipped);
  const totalInputs = nonSkipped.length;

  if (totalInputs === 0) {
    return {
      profile,
      totalInputs: 0,
      consensusFindings: 0,
      counts: {},
      findings: [],
      summary: 'No inputs to bridge.',
    };
  }

  const threshold = CONSENSUS_THRESHOLD[profile] ?? 2;

  // Aggregate findings by dedup key across all inputs
  const findingMap = new Map<string, { finding: Finding; count: number; sources: string[] }>();

  for (const result of nonSkipped) {
    const tool = result.tool;
    for (const finding of result.findings ?? []) {
      const key = `${finding.severity}:${finding.file}:${finding.line ?? ''}:${finding.message}`;
      const existing = findingMap.get(key);
      if (existing) {
        existing.count++;
        existing.sources.push(tool);
      } else {
        findingMap.set(key, {
          finding: { ...finding, sources: [tool] },
          count: 1,
          sources: [tool],
        });
      }
    }
  }

  // Apply consensus filter
  const consensusFindings: Finding[] = [];
  const counts: Record<string, number> = {};

  for (const { finding, count, sources } of findingMap.values()) {
    counts[finding.severity] = (counts[finding.severity] ?? 0) + 1;
    if (count >= threshold || finding.severity === 'CRITICAL') {
      consensusFindings.push({ ...finding, sources });
    }
  }

  const changedFiles = projectContext
    ? (Array.isArray((projectContext as { baseDiffCount?: unknown }).baseDiffCount) ? [] : [])
    : [];

  const { findings: enriched, filteredCount, promotedCount } = enrichFindings(consensusFindings, changedFiles);
  const sorted = sortFindings(enriched);

  const critCount = sorted.filter((f) => f.severity === 'CRITICAL').length;
  const warnCount = sorted.filter((f) => f.severity === 'WARNING').length;

  const summary = [
    `Bridge (${profile}): ${sorted.length} consensus finding(s) from ${totalInputs} input(s)`,
    critCount > 0 ? `${critCount} CRITICAL` : '',
    warnCount > 0 ? `${warnCount} WARNING` : '',
    filteredCount > 0 ? `${filteredCount} out-of-scope filtered` : '',
    promotedCount > 0 ? `${promotedCount} promoted` : '',
  ]
    .filter(Boolean)
    .join(', ');

  return {
    profile,
    totalInputs,
    consensusFindings: sorted.length,
    counts,
    findings: sorted,
    summary,
  };
}

export function mergeBridgeFindings(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  return findings.filter((f) => {
    const key = `${f.severity}:${f.file}:${f.line ?? ''}:${f.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
