import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { colors, toolColor, CHARS, ADAPTER_NAMES } from '../theme.js';
import { Panel } from '../components/Panel.js';
import { StreamPanel } from '../components/StreamPanel.js';
import { ProgressSteps } from '../components/ProgressSteps.js';
import type { StepStatus } from '../components/ProgressSteps.js';
import { useTui, REVIEW_MODES } from '../store.js';

const PROGRESS_BAR_WIDTH = 20;

const PHASE_ORDER = ['context', 'redact', 'review', 'enrich'] as const;
type ReviewPhase = (typeof PHASE_ORDER)[number];

function phaseToIndex(phase: ReviewPhase | 'bridge' | null): number {
  if (phase === 'bridge') return PHASE_ORDER.length;
  if (phase == null) return -1;
  return PHASE_ORDER.indexOf(phase as ReviewPhase);
}

function stepStatus(stepIndex: number, activeIndex: number): StepStatus {
  if (stepIndex < activeIndex) return 'done';
  if (stepIndex === activeIndex) return 'active';
  return 'pending';
}

function buildSteps(phase: ReviewPhase | 'bridge' | null): Array<{ label: string; status: StepStatus }> {
  const activeIndex = phaseToIndex(phase);
  return PHASE_ORDER.map((p, i) => ({
    label: p.charAt(0).toUpperCase() + p.slice(1),
    status: stepStatus(i, activeIndex),
  }));
}

function buildProgressBar(steps: Array<{ status: StepStatus }>): string {
  const doneCount = steps.filter((s) => s.status === 'done').length;
  const total = steps.length;
  const activeCount = steps.filter((s) => s.status === 'active').length;

  const filled = Math.round(
    ((doneCount + activeCount * 0.5) / total) * PROGRESS_BAR_WIDTH,
  );
  const empty = PROGRESS_BAR_WIDTH - filled;

  return (
    CHARS.progressFull.repeat(Math.max(0, filled)) +
    CHARS.progressEmpty.repeat(Math.max(0, empty))
  );
}

type BridgeToolStatus = 'pending' | 'running' | 'done' | 'error';

function bridgeStatusIcon(status: BridgeToolStatus): string {
  switch (status) {
    case 'done': return CHARS.installed;
    case 'error': return CHARS.missing;
    case 'running': return '⟳';
    default: return CHARS.radioOff;
  }
}

function bridgeStatusColor(status: BridgeToolStatus): string {
  switch (status) {
    case 'done': return colors.green;
    case 'error': return colors.red;
    case 'running': return colors.yellow;
    default: return colors.textDim;
  }
}

export function ReviewProgress(): React.ReactElement {
  const [state] = useTui();
  const { review } = state;

  const selectedTool = ADAPTER_NAMES[review.selectedTool] ?? 'kimi';
  const selectedMode = REVIEW_MODES[review.selectedMode] ?? 'review';
  const steps = buildSteps(review.progressPhase);
  const doneCount = steps.filter((s) => s.status === 'done').length;
  const activeCount = steps.filter((s) => s.status === 'active').length;
  const fraction = (doneCount + activeCount * 0.5) / steps.length;
  const progressBar = buildProgressBar(steps);
  const pct = Math.round(fraction * 100);

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1} gap={1} flexGrow={1}>
      {/* Header panel with progress */}
      <Panel title={`REVIEWING ${selectedTool} / ${selectedMode}`} flexGrow={0}>
        <Box flexDirection="row" gap={2} marginTop={1}>
          <Text color={colors.accent}>{progressBar}</Text>
          <Text color={colors.textMuted}>{pct}%</Text>
          {review.elapsed > 0 && (
            <Text color={colors.textDim}>⟳ {review.elapsed.toFixed(1)}s</Text>
          )}
        </Box>
        <ProgressSteps steps={steps} />
      </Panel>

      {/* Current status */}
      <Box flexDirection="row" gap={1} paddingX={1}>
        <Text color={colors.green}><Spinner type="dots" /></Text>
        <Text color={colors.text}>{review.progress || 'Initializing...'}</Text>
      </Box>

      {/* Bridge tool progress (when in bridge mode) */}
      {Object.keys(state.review.bridgeToolProgress).length > 0 && (
        <Panel title="TOOL PROGRESS" flexGrow={0}>
          <Box flexDirection="column" marginTop={1}>
            {Object.entries(state.review.bridgeToolProgress).map(([tool, status]) => {
              const icon = bridgeStatusIcon(status);
              const color = bridgeStatusColor(status);
              return (
                <Box key={tool} flexDirection="row" gap={1}>
                  <Text color={color}>{icon}</Text>
                  <Text color={toolColor(tool)}>{tool.padEnd(8)}</Text>
                  <Text color={color}>{status}</Text>
                </Box>
              );
            })}
          </Box>
        </Panel>
      )}

      {/* Live streaming output */}
      {review.streamBuffer.length > 0 && (
        <StreamPanel lines={review.streamBuffer} maxLines={10} />
      )}
    </Box>
  );
}
