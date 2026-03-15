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
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
