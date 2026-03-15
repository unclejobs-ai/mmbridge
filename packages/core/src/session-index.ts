import crypto from 'node:crypto';
import type {
  BuildContextIndexInput,
  BuildResultIndexInput,
  ContextIndex,
  Finding,
  ResultIndex,
  SeverityCounts,
  TopFile,
} from './types.js';
import { classifyFile } from './utils.js';

export function buildContextIndex(input: BuildContextIndexInput): ContextIndex {
  const changedFiles = input.changedFiles ?? [];
  const categoryCounts: Record<string, number> = {};

  for (const f of changedFiles) {
    const cat = classifyFile(f);
    categoryCounts[cat] = (categoryCounts[cat] ?? 0) + 1;
  }

  return {
    workspaceId: input.workspace ?? null,
    projectDir: input.projectDir ?? null,
    projectSlug: input.projectDir ? input.projectDir.replace(/[\\/]/g, '-').replace(/^-/, '') : null,
    mode: input.mode ?? null,
    baseRef: input.baseRef ?? null,
    head: input.head ?? null,
    changedFiles: changedFiles.length,
    copiedFiles: input.copiedFileCount ?? 0,
    categoryCounts,
    changedSample: changedFiles.slice(0, 5),
    redaction: input.redaction ?? null,
  };
}

export function buildResultIndex(input: BuildResultIndexInput): ResultIndex {
  const findings: Finding[] = input.findings ?? [];

  const severityCounts: SeverityCounts = {
    CRITICAL: 0,
    WARNING: 0,
    INFO: 0,
    REFACTOR: 0,
  };
  for (const f of findings) {
    severityCounts[f.severity] = (severityCounts[f.severity] ?? 0) + 1;
  }

  const fileCounts: Record<string, number> = {};
  for (const f of findings) {
    if (f.file) {
      fileCounts[f.file] = (fileCounts[f.file] ?? 0) + 1;
    }
  }

  const topFiles: TopFile[] = Object.entries(fileCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([file, count]) => ({ file, count }));

  const filesTouched = Object.keys(fileCounts).length;

  const outputDigest = input.rawOutput
    ? crypto.createHash('sha256').update(input.rawOutput).digest('hex').slice(0, 12)
    : null;

  return {
    summary: input.summary ?? '',
    parseState: input.parseState ?? 'unknown',
    findingsTotal: findings.length,
    severityCounts,
    filesTouched,
    topFiles,
    filteredCount: input.filteredCount ?? 0,
    promotedCount: input.promotedCount ?? 0,
    followupSupported: input.followupSupported ?? false,
    outputDigest,
    hasBridge: Boolean(input.bridgeSummary),
    bridgeSummary: input.bridgeSummary ?? null,
  };
}
