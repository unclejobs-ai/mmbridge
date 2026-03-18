import type { EmbraceReport } from '@mmbridge/core';

// ─── Catppuccin Mocha ANSI palette ──────────────────────────────────────────

const C = {
  RESET: '\x1b[0m',
  BOLD: '\x1b[1m',
  DIM: '\x1b[2m',
  GREEN: '\x1b[38;2;166;227;161m',
  ACCENT: '\x1b[38;2;180;190;254m',
  CRITICAL: '\x1b[38;2;243;139;168m',
  WARNING: '\x1b[38;2;249;226;175m',
  INFO: '\x1b[38;2;137;220;235m',
  REFACTOR: '\x1b[38;2;250;179;135m',
} as const;

interface PhaseState {
  status: string;
  score?: number;
  threshold?: number;
  detail?: string;
}

function formatGateLabel(score: number, threshold: number): string {
  const passed = score >= threshold;
  const label = passed ? 'PASS' : 'FAIL';
  const color = passed ? C.GREEN : C.CRITICAL;
  return `${color}${label} ${score}/${threshold}${C.RESET}`;
}

function formatStatus(status: string): string {
  switch (status) {
    case 'running':
      return `${C.ACCENT}RUNNING${C.RESET}`;
    case 'completed':
      return `${C.GREEN}DONE${C.RESET}`;
    case 'paused':
      return `${C.WARNING}PAUSED${C.RESET}`;
    case 'failed':
      return `${C.CRITICAL}FAILED${C.RESET}`;
    case 'skipped':
      return `${C.DIM}SKIPPED${C.RESET}`;
    default:
      return `${C.DIM}PENDING${C.RESET}`;
  }
}

export class EmbraceRenderer {
  private readonly phases: Map<string, PhaseState>;

  constructor(private readonly task: string) {
    this.phases = new Map();
  }

  start(): void {
    process.stdout.write(`\n${C.GREEN}${C.BOLD}=== MMBridge Embrace: ${this.task} ===${C.RESET}\n\n`);
  }

  updatePhase(phase: string, status: string, detail?: string): void {
    const existing = this.phases.get(phase);
    this.phases.set(phase, { ...existing, status, detail: detail ?? existing?.detail });

    const statusLabel = formatStatus(status);
    const detailStr = detail ? `  ${C.DIM}${detail}${C.RESET}` : '';
    process.stdout.write(`${C.ACCENT}── Phase: ${phase}${C.RESET}  [${statusLabel}]${detailStr}\n`);
  }

  setGate(phase: string, score: number, threshold: number): void {
    const existing = this.phases.get(phase);
    this.phases.set(phase, { ...existing, status: existing?.status ?? 'completed', score, threshold });

    const gateLabel = formatGateLabel(score, threshold);
    process.stdout.write(`${C.DIM}  Gate: [${C.RESET}${gateLabel}${C.DIM}]${C.RESET}\n`);
  }

  checkpoint(prompt: string, options: string[]): void {
    process.stdout.write(`\n${C.WARNING}${C.BOLD}── Checkpoint ──${C.RESET}\n`);
    process.stdout.write(`  ${prompt}\n`);
    if (options.length > 0) {
      process.stdout.write(`${C.DIM}  Options:${C.RESET}\n`);
      options.forEach((opt, idx) => {
        process.stdout.write(`    ${C.ACCENT}[${idx + 1}]${C.RESET} ${opt}\n`);
      });
    }
    process.stdout.write('\n');
  }

  printReport(report: EmbraceReport): void {
    process.stdout.write(`\n${C.GREEN}${C.BOLD}── Report ──${C.RESET}\n`);

    const scoreColor = report.overallScore >= 70 ? C.GREEN : report.overallScore >= 40 ? C.WARNING : C.CRITICAL;
    process.stdout.write(`  ${C.BOLD}Overall Score:${C.RESET} ${scoreColor}${report.overallScore}/100${C.RESET}\n`);

    if (report.researchSummary) {
      process.stdout.write(`\n  ${C.ACCENT}Research:${C.RESET} ${C.DIM}${report.researchSummary}${C.RESET}\n`);
    }

    if (report.debateOutcome) {
      process.stdout.write(`  ${C.ACCENT}Debate:${C.RESET}   ${C.DIM}${report.debateOutcome}${C.RESET}\n`);
    }

    if (report.reviewFindings.length > 0) {
      const critical = report.reviewFindings.filter((f) => f.severity === 'CRITICAL').length;
      const warning = report.reviewFindings.filter((f) => f.severity === 'WARNING').length;
      const info = report.reviewFindings.filter((f) => f.severity === 'INFO').length;
      process.stdout.write(
        `  ${C.ACCENT}Review:${C.RESET}   ${report.reviewFindings.length} findings` +
          ` (${C.CRITICAL}${critical} critical${C.RESET}` +
          `, ${C.WARNING}${warning} warning${C.RESET}` +
          `, ${C.INFO}${info} info${C.RESET})\n`,
      );
    }

    if (report.securityFindings.length > 0) {
      const p0 = report.securityFindings.filter((f) => f.securitySeverity === 'P0').length;
      const p1 = report.securityFindings.filter((f) => f.securitySeverity === 'P1').length;
      const p2 = report.securityFindings.filter((f) => f.securitySeverity === 'P2').length;
      process.stdout.write(
        `  ${C.ACCENT}Security:${C.RESET} ${report.securityFindings.length} findings` +
          ` (${C.CRITICAL}${p0} P0${C.RESET}` +
          `, ${C.WARNING}${p1} P1${C.RESET}` +
          `, ${C.INFO}${p2} P2${C.RESET})\n`,
      );
    }

    if (report.recommendations.length > 0) {
      process.stdout.write(`\n  ${C.BOLD}Recommendations:${C.RESET}\n`);
      for (const rec of report.recommendations) {
        process.stdout.write(`    ${C.DIM}•${C.RESET} ${rec}\n`);
      }
    }

    process.stdout.write('\n');
  }

  cleanup(): void {
    // No persistent resources to clean up in the renderer
  }
}
