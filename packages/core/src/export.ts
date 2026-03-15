import fs from 'node:fs/promises';
import path from 'node:path';
import type { Finding, ResultIndex } from './types.js';

export interface ExportableReport {
  localSessionId?: string;
  externalSessionId?: string;
  workspace?: string;
  summary: string;
  findings: Finding[];
  resultIndex?: ResultIndex;
  changedFiles?: number;
  copiedFiles?: number;
  followupSupported?: boolean;
}

export async function exportReport(report: ExportableReport, outputPath: string): Promise<void> {
  const lines: string[] = ['# MMBridge Review Report', '', `**Generated:** ${new Date().toISOString()}`];

  if (report.localSessionId) {
    lines.push(`**Session:** ${report.localSessionId}`);
  }
  if (report.changedFiles !== undefined) {
    lines.push(`**Changed files:** ${report.changedFiles}`);
  }
  if (report.followupSupported) {
    lines.push(`**Follow-up:** supported${report.externalSessionId ? ` (${report.externalSessionId})` : ''}`);
  }

  lines.push('', '---', '', '## Summary', '', report.summary);

  if (report.findings.length > 0) {
    lines.push('', '## Findings', '');
    for (const finding of report.findings) {
      const severity = finding.severity ?? 'INFO';
      const location = finding.file ? (finding.line != null ? `${finding.file}:${finding.line}` : finding.file) : '';
      lines.push(`- **[${severity}]** ${location ? `\`${location}\` — ` : ''}${finding.message ?? ''}`);
    }
  }

  lines.push('');

  const resolved = path.resolve(outputPath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, lines.join('\n'), 'utf8');
  process.stderr.write(`[mmbridge] Report exported to ${resolved}\n`);
}
