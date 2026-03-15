import { render } from 'ink';
import React from 'react';
import { App } from './App.js';
import type { TabId } from './store.js';

// ─── Re-export domain interfaces for backward compatibility ───────────────────

export type {
  DoctorReport,
  ReviewReport,
} from './legacy-types.js';

// ─── TUI entry point ──────────────────────────────────────────────────────────

export function renderTui(options?: { tab?: TabId; version?: string }): void {
  // Enter alternate screen buffer (like vim/htop) — prevents leftover content
  process.stdout.write('\x1B[?1049h');
  process.stdout.write('\x1B[2J\x1B[H'); // clear + cursor home

  const instance = render(<App initialTab={options?.tab} version={options?.version} />);

  // Restore original screen buffer on exit
  instance.waitUntilExit().then(() => {
    process.stdout.write('\x1B[?1049l');
  });
}

// ─── Backward-compatible stubs (replaced blessed renders) ─────────────────────

export async function renderDoctor(report: import('./legacy-types.js').DoctorReport): Promise<void> {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

export async function renderSetupWizard(report: import('./legacy-types.js').DoctorReport): Promise<void> {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

export async function renderReviewConsole(report: import('./legacy-types.js').ReviewReport): Promise<void> {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
