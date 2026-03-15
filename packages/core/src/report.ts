import type { EnrichResult, Finding, Severity } from './types.js';

const SEVERITY_ORDER: Record<Severity, number> = {
  CRITICAL: 0,
  WARNING: 1,
  INFO: 2,
  REFACTOR: 3,
};

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const severityDiff = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (severityDiff !== 0) return severityDiff;
    return a.file.localeCompare(b.file);
  });
}

export function deduplicateFindings(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  return findings.filter((f) => {
    const key = `${f.severity}:${f.file}:${f.line ?? ''}:${f.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function filterScopeFindings(findings: Finding[], changedFiles: string[]): Finding[] {
  if (changedFiles.length === 0) return findings;
  const fileSet = new Set(changedFiles);
  return findings.filter((f) => !f.file || fileSet.has(f.file) || f.scopeHint === 'global');
}

export function promoteLowConfidence(findings: Finding[]): { findings: Finding[]; promotedCount: number } {
  let promotedCount = 0;
  const promoted = findings.map((f) => {
    if (f.confidence === 'medium' && f.severity === 'INFO') {
      promotedCount++;
      return { ...f, severity: 'WARNING' as Severity };
    }
    return f;
  });
  return { findings: promoted, promotedCount };
}

export function enrichFindings(findings: Finding[], changedFiles: string[]): EnrichResult {
  const deduped = deduplicateFindings(findings);
  const scoped = filterScopeFindings(deduped, changedFiles);
  const filteredCount = deduped.length - scoped.length;
  const { findings: promoted, promotedCount } = promoteLowConfidence(scoped);
  const sorted = sortFindings(promoted);

  const critCount = sorted.filter((f) => f.severity === 'CRITICAL').length;
  const warnCount = sorted.filter((f) => f.severity === 'WARNING').length;

  const summary = [
    `${sorted.length} finding(s)`,
    critCount > 0 ? `${critCount} CRITICAL` : '',
    warnCount > 0 ? `${warnCount} WARNING` : '',
  ]
    .filter(Boolean)
    .join(', ');

  return { findings: sorted, filteredCount, promotedCount, summary };
}

export function formatFindingsText(findings: Finding[]): string {
  if (findings.length === 0) return 'No findings.';
  return findings
    .map((f) => {
      const loc = f.line != null ? `:${f.line}` : '';
      return `[${f.severity}] ${f.file}${loc} — ${f.message}`;
    })
    .join('\n');
}
