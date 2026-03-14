import React from 'react';
import { render } from 'ink';
import { App } from './App.js';

// ─── Re-export domain interfaces for backward compatibility ───────────────────

export type {
  DashboardModel,
  DashboardSession,
  DashboardData,
  DashboardPayload,
  SummaryRow,
  DoctorReport,
  ReviewReport,
} from './legacy-types.js';

// ─── TUI entry point ──────────────────────────────────────────────────────────

export function renderTui(): void {
  render(<App />);
}

// ─── Backward-compatible stubs (replaced blessed renders) ─────────────────────

export async function renderDoctor(report: import('./legacy-types.js').DoctorReport): Promise<void> {
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}

export async function renderSetupWizard(report: import('./legacy-types.js').DoctorReport): Promise<void> {
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}

export async function renderReviewConsole(report: import('./legacy-types.js').ReviewReport): Promise<void> {
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}

export async function renderDashboard(payload: import('./legacy-types.js').DashboardPayload): Promise<void> {
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
}
