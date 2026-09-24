import type { DispatchResult, Role, WorkerControl, WorkerEventListener } from '@mmbridge/dispatch';
import { render } from 'ink';
import React from 'react';
import { App } from './App.js';
import type { ReplCommandResult } from './App.js';
import { createHubStore, initialLane } from './hub-state.js';
import type { TabId } from './store.js';
import { countBySeverity } from './utils/format.js';
import { HubView } from './views/HubView.js';

// ─── Re-export domain interfaces for backward compatibility ───────────────────

export type {
  DoctorReport,
  ReviewReport,
} from './legacy-types.js';

// ─── TUI entry point ──────────────────────────────────────────────────────────

export async function renderTui(options?: {
  tab?: TabId;
  version?: string;
  onReplCommand?: (command: string) => Promise<ReplCommandResult>;
}): Promise<void> {
  const isTTY = process.stdout.isTTY;

  if (isTTY) {
    process.stdout.write('\x1B[?1049h'); // alternate screen buffer
    process.stdout.write('\x1B[2J\x1B[H'); // clear + cursor home
  }

  try {
    const instance = render(
      <App initialTab={options?.tab} version={options?.version} onReplCommand={options?.onReplCommand} />,
    );
    await instance.waitUntilExit();
  } finally {
    if (isTTY) {
      process.stdout.write('\x1B[?1049l'); // restore original screen
    }
  }
}

// ─── Agent Hub: one live pane per dispatched worker ──────────────────────────

export interface HubLane {
  role: Role;
  /** Starts the dispatch; the hub renders every event it reports and steers/aborts through the control. */
  run: (hooks: {
    onEvent: WorkerEventListener;
    onControl: (control: WorkerControl) => void;
  }) => Promise<DispatchResult>;
}

/** Runs every lane at once in a live view; resolves after the user quits, with each lane's result or error. */
export async function renderHub(options: { title: string; lanes: HubLane[] }): Promise<Array<DispatchResult | Error>> {
  const startedAt = Date.now();
  const store = createHubStore(options.lanes.map((lane) => initialLane(lane.role, startedAt)));
  const results = Promise.all(
    options.lanes.map((lane, index) =>
      lane
        .run({
          onEvent: (event) => store.apply(index, event),
          onControl: (control) => store.setControl(index, control),
        })
        .then(
          (result) => {
            store.apply(index, {
              type: 'done',
              at: Date.now(),
              stopReason: result.stopReason,
              ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
            });
            return result;
          },
          (err: unknown) => {
            const error = err instanceof Error ? err : new Error(String(err));
            store.apply(index, { type: 'failed', at: Date.now(), message: error.message });
            return error;
          },
        ),
    ),
  );

  const isTTY = process.stdout.isTTY;
  if (isTTY) process.stdout.write('\x1B[?1049h\x1B[2J\x1B[H');
  try {
    const instance = render(<HubView store={store} title={options.title} />);
    if (!process.stdin.isTTY) void results.then(() => instance.unmount());
    await instance.waitUntilExit();
  } finally {
    if (isTTY) process.stdout.write('\x1B[?1049l');
  }
  return results;
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
  const recallDetail = report.recalledMemorySummary ?? 'No recalled memory';
  const handoffDetail = report.handoffPath ?? report.handoff?.markdownPath ?? null;

  flowLines.push(`✓ Recall     ${recallDetail}`);
  flowLines.push('│');
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
  if (handoffDetail) {
    flowLines.push('│');
    flowLines.push(`✓ Handoff    ${handoffDetail}`);
  }

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
    '',
    'Recall',
    recallDetail,
    ...(report.recalledMemoryHits && report.recalledMemoryHits.length > 0
      ? report.recalledMemoryHits.slice(0, 5).map((entry) => `- [${entry.type}] ${entry.title}`)
      : []),
    '',
    'Next',
    report.nextPrompt ?? 'No next prompt generated.',
    report.nextCommand ? '' : null,
    report.nextCommand ? report.nextCommand : null,
  ].filter((line): line is string => line != null);

  process.stdout.write(`${lines.join('\n')}\n`);
}
