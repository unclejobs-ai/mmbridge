import type { DispatchResult, Role, WorkerControl, WorkerEvent } from '@mmbridge/dispatch';
import { render } from 'ink';
import React from 'react';
import { type GateView, createHubStore } from './hub-state.js';
import { countBySeverity } from './utils/format.js';
import { HubView } from './views/HubView.js';

// ─── Re-export domain interfaces for backward compatibility ───────────────────

export type { GateView } from './hub-state.js';

export type {
  DoctorReport,
  ReviewReport,
} from './legacy-types.js';

// ─── Agent Hub: one live pane per model stage ─────────────────────────────────

/** What a hub run reports to the view. Lanes are indexes into the roles passed to renderHub. */
export interface HubSink {
  event: (lane: number, event: WorkerEvent) => void;
  /** The steer/abort handle of the model now running in the lane. */
  control: (lane: number, control: WorkerControl) => void;
  /** The lane's dispatch ended with this result or error. */
  finish: (lane: number, outcome: DispatchResult | Error) => void;
  /** Work outside any lane, e.g. validation; undefined clears it. */
  activity: (label: string | undefined) => void;
  gate: (gate: GateView) => void;
}

/** Runs `run` in a live view with one pane per role; resolves with its result after the user quits. */
export async function renderHub<T>(options: {
  title: string;
  roles: Role[];
  run: (sink: HubSink) => Promise<T>;
}): Promise<T> {
  const store = createHubStore(options.roles, Date.now());
  const sink: HubSink = {
    event: (lane, event) => store.apply(lane, event),
    control: (lane, control) => store.setControl(lane, control),
    finish: (lane, outcome) =>
      store.apply(
        lane,
        outcome instanceof Error
          ? { type: 'failed', at: Date.now(), message: outcome.message }
          : {
              type: 'done',
              at: Date.now(),
              stopReason: outcome.stopReason,
              ...(outcome.errorMessage ? { errorMessage: outcome.errorMessage } : {}),
            },
      ),
    activity: (label) => store.setActivity(label),
    gate: (gate) => store.setGate(gate),
  };
  const outcome = options.run(sink).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  void outcome.then(() => store.settle());

  const isTTY = process.stdout.isTTY;
  if (isTTY) process.stdout.write('\x1B[?1049h\x1B[2J\x1B[H');
  // Each Ink frame erases every line and writes them again; wrapped in synchronized
  // output (CSI ?2026) the terminal paints the frame at once instead of showing the
  // erased screen in between, which is what flickered.
  const write = process.stdout.write;
  if (isTTY) {
    process.stdout.write = function (this: NodeJS.WriteStream, chunk: unknown, ...rest: unknown[]) {
      const framed = typeof chunk === 'string' ? `\x1B[?2026h${chunk}\x1B[?2026l` : chunk;
      return (write as (...args: unknown[]) => boolean).call(this, framed, ...rest);
    } as typeof process.stdout.write;
  }
  try {
    const instance = render(<HubView store={store} title={options.title} />);
    if (!process.stdin.isTTY) void outcome.then(() => instance.unmount());
    await instance.waitUntilExit();
  } finally {
    process.stdout.write = write;
    if (isTTY) process.stdout.write('\x1B[?1049l');
  }
  const settled = await outcome;
  if ('error' in settled) throw settled.error;
  return settled.value;
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
