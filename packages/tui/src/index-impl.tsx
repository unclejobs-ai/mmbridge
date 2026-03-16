import { render } from 'ink';
import React from 'react';
import { App } from './App.js';
import type { TabId } from './store.js';
import { countBySeverity } from './utils/format.js';

// ─── Re-export domain interfaces for backward compatibility ───────────────────

export type {
  DoctorReport,
  ReviewReport,
} from './legacy-types.js';

// ─── TUI entry point ──────────────────────────────────────────────────────────

export async function renderTui(options?: { tab?: TabId; version?: string }): Promise<void> {
  const isTTY = process.stdout.isTTY;

  if (isTTY) {
    process.stdout.write('\x1B[?1049h'); // alternate screen buffer
    process.stdout.write('\x1B[2J\x1B[H'); // clear + cursor home
  }

  try {
    const instance = render(<App initialTab={options?.tab} version={options?.version} />);
    await instance.waitUntilExit();
  } finally {
    if (isTTY) {
      process.stdout.write('\x1B[?1049l'); // restore original screen
    }
  }
}

// ─── Backward-compatible stubs (replaced blessed renders) ─────────────────────

export async function renderDoctor(report: import('./legacy-types.js').DoctorReport): Promise<void> {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

export async function renderSetupWizard(report: import('./legacy-types.js').DoctorReport): Promise<void> {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

export async function renderReviewConsole(report: import('./legacy-types.js').ReviewReport): Promise<void> {
  const findings = report.findings ?? [];
  const severity = countBySeverity(findings);
  const flowLines: string[] = [];
  const contextDetail =
    report.resultIndex?.filesTouched != null ? `${report.resultIndex.filesTouched} touched file(s)` : 'saved context';
  const toolLabel =
    report.toolResults && report.toolResults.length > 0
      ? `${report.toolResults.length} lane(s)`
      : (report.tool ?? report.mode ?? 'review');
  const toolDetail =
    report.toolResults && report.toolResults.length > 0
      ? report.toolResults
          .slice(0, 3)
          .map((result) => `${result.tool}:${result.error ? 'err' : result.skipped ? 'skip' : result.findingCount}`)
          .join(' · ')
      : `${findings.length} finding(s)`;
  const hasBridge = report.tool === 'bridge' || report.resultIndex?.hasBridge || (report.toolResults?.length ?? 0) > 0;
  const bridgeDetail = report.resultIndex?.bridgeSummary ?? `${findings.length} consensus finding(s)`;
  const interpretDetail = report.interpretation
    ? `${report.interpretation.validated.length} valid · ${report.interpretation.falsePositives.length} false+`
    : null;
  const findingDetail =
    [
      severity.critical > 0 ? `${severity.critical} CRI` : null,
      severity.warning > 0 ? `${severity.warning} WRN` : null,
      severity.info > 0 ? `${severity.info} INF` : null,
      severity.refactor > 0 ? `${severity.refactor} REF` : null,
    ]
      .filter(Boolean)
      .join(' · ') || 'No findings';

  flowLines.push(`✓ Context    ${contextDetail}`);
  flowLines.push('│');
  flowLines.push(`✓ Tools      ${toolLabel} · ${toolDetail}`);
  if (hasBridge) {
    flowLines.push('│');
    flowLines.push(`✓ Bridge     ${bridgeDetail}`);
  }
  if (interpretDetail) {
    flowLines.push('│');
    flowLines.push(`✓ Interpret  ${interpretDetail}`);
  }
  flowLines.push('│');
  flowLines.push(`✓ Findings   ${findingDetail}`);

  const summary = report.summary?.trim() || `${findings.length} finding(s)`;
  const falsePositiveKeys = new Set(
    (report.interpretation?.falsePositives ?? []).map(
      (entry) => `${entry.finding.severity}:${entry.finding.file}:${entry.finding.line ?? ''}:${entry.finding.message}`,
    ),
  );
  const consensusLines = findings.slice(0, 4).map((finding) => {
    const key = `${finding.severity}:${finding.file}:${finding.line ?? ''}:${finding.message}`;
    const sources =
      finding.sources && finding.sources.length > 0 ? finding.sources.join(',') : (report.tool ?? 'review');
    const location = finding.line != null ? `${finding.file}:${finding.line}` : finding.file;
    const status = falsePositiveKeys.has(key) ? 'false+' : report.interpretation ? 'keep' : 'final';
    return `- [${finding.severity}] ${location} [${status}] (${sources})\n  ${finding.message}`;
  });

  const lines = [
    'MMBridge Session',
    report.localSessionId ? `session: #${report.localSessionId}` : null,
    report.externalSessionId ? `external: ${report.externalSessionId}` : null,
    `mode: ${report.mode ?? 'review'}${report.tool ? ` · tool: ${report.tool}` : ''}${report.status ? ` · status: ${report.status}` : ''}`,
    '',
    'Session Map',
    ...flowLines,
    '',
    'Summary',
    summary,
    consensusLines.length > 0 ? '' : null,
    consensusLines.length > 0 ? 'Consensus' : null,
    ...(consensusLines.length > 0 ? consensusLines : []),
  ].filter((line): line is string => line != null);

  process.stdout.write(`${lines.join('\n')}\n`);
}
