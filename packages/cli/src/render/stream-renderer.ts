import type { Finding, LiveState } from '@mmbridge/core';
import { clearLiveState, writeLiveState } from '@mmbridge/core';

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

const SEVERITY_ICON: Record<string, string> = {
  CRITICAL: '◆',
  WARNING: '▲',
  INFO: '●',
  REFACTOR: '◇',
};

const SEVERITY_COLOR: Record<string, string> = {
  CRITICAL: C.CRITICAL,
  WARNING: C.WARNING,
  INFO: C.INFO,
  REFACTOR: C.REFACTOR,
};

// ─── StreamRenderer ──────────────────────────────────────────────────────────

export class StreamRenderer {
  private readonly tool: string;
  private readonly mode: string;
  private readonly startedAt: Date;
  private currentPhase = '';
  private streamLines: string[] = [];
  private events: Array<{ time: string; message: string }> = [];
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(tool: string, mode: string) {
    this.tool = tool;
    this.mode = mode;
    this.startedAt = new Date();
  }

  start(): void {
    process.stdout.write(`${C.GREEN}${C.BOLD}● mmbridge${C.RESET} ${C.DIM}${this.tool} / ${this.mode}${C.RESET}\n`);
    this.scheduleLiveStateWrite();
  }

  phase(name: string, detail: string): void {
    this.currentPhase = name;
    const elapsed = this.elapsedStr();
    process.stdout.write(
      `${C.DIM}├─${C.RESET} ${C.ACCENT}${name}${C.RESET}  ${C.DIM}${detail} (${elapsed})${C.RESET}\n`,
    );
    this.events.push({ time: new Date().toISOString(), message: `${name}: ${detail}` });
    this.scheduleLiveStateWrite();
  }

  streamLine(text: string): void {
    if (!text.trim()) return;
    process.stdout.write(`${C.DIM}│  ${text}${C.RESET}\n`);
    this.streamLines.push(text);
    if (this.streamLines.length > 20) {
      this.streamLines = this.streamLines.slice(-20);
    }
    this.scheduleLiveStateWrite();
  }

  done(sessionId: string): void {
    const elapsed = this.elapsedStr();
    process.stdout.write(
      `${C.DIM}└─${C.RESET} ${C.GREEN}done${C.RESET}  ${C.DIM}${elapsed} · session #${sessionId}${C.RESET}\n`,
    );
  }

  printFindings(findings: Finding[]): void {
    if (findings.length === 0) {
      process.stdout.write(`\n${C.DIM}No findings.${C.RESET}\n`);
      return;
    }

    process.stdout.write('\n');
    for (const f of findings) {
      const color = SEVERITY_COLOR[f.severity] ?? C.RESET;
      const icon = SEVERITY_ICON[f.severity] ?? '●';
      const loc = f.line != null ? `:${f.line}` : '';
      process.stdout.write(`  ${color}${icon} [${f.severity}]${C.RESET} ${C.DIM}${f.file}${loc}${C.RESET}\n`);
      process.stdout.write(`    ${f.message}\n`);
    }
  }

  printSummary(findings: Finding[], elapsed: string): void {
    const counts: Record<string, number> = {
      CRITICAL: 0,
      WARNING: 0,
      INFO: 0,
      REFACTOR: 0,
    };
    for (const f of findings) {
      counts[f.severity] = (counts[f.severity] ?? 0) + 1;
    }

    const parts: string[] = [];
    if (counts.CRITICAL > 0) {
      parts.push(`${C.CRITICAL}◆${counts.CRITICAL}${C.RESET}`);
    }
    if (counts.WARNING > 0) {
      parts.push(`${C.WARNING}▲${counts.WARNING}${C.RESET}`);
    }
    if (counts.INFO > 0) {
      parts.push(`${C.INFO}●${counts.INFO}${C.RESET}`);
    }
    if (counts.REFACTOR > 0) {
      parts.push(`${C.REFACTOR}◇${counts.REFACTOR}${C.RESET}`);
    }

    const countStr = parts.length > 0 ? parts.join(' ') : `${C.DIM}0${C.RESET}`;
    const total = findings.length;

    process.stdout.write(`\n${countStr} ${C.DIM}│ ${total} finding${total !== 1 ? 's' : ''} │ ${elapsed}${C.RESET}\n`);
  }

  cleanup(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    clearLiveState().catch(() => {});
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private elapsedStr(): string {
    const ms = Date.now() - this.startedAt.getTime();
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }

  private buildLiveState(): LiveState {
    return {
      active: true,
      tool: this.tool,
      mode: this.mode,
      phase: this.currentPhase,
      elapsed: Date.now() - this.startedAt.getTime(),
      startedAt: this.startedAt.toISOString(),
      streamLines: [...this.streamLines],
      events: [...this.events],
    };
  }

  private scheduleLiveStateWrite(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      writeLiveState(this.buildLiveState()).catch(() => {});
    }, 200);
  }
}
