import React from 'react';
import { Box, Text } from 'ink';
import { colors, CHARS } from '../theme.js';
import { FullWidthRow } from './FullWidthRow.js';
import type { LiveState } from '@mmbridge/core';

// ─── Phase step display ───────────────────────────────────────────────────────

const PHASES = ['context', 'redact', 'review', 'enrich'] as const;
type Phase = typeof PHASES[number];

const SPINNER_FRAMES = ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'];

function phaseIcon(phaseName: Phase, currentPhase: string, frameIdx: number): string {
  const phaseOrder = PHASES.indexOf(phaseName);
  const currentOrder = PHASES.indexOf(currentPhase as Phase);
  if (currentOrder === -1) {
    // phase is done or unknown — treat all as done
    return CHARS.installed;
  }
  if (phaseOrder < currentOrder) return CHARS.installed;
  if (phaseOrder === currentOrder) return SPINNER_FRAMES[frameIdx % SPINNER_FRAMES.length] ?? '⣾';
  return CHARS.radioOff;
}

function phaseColor(phaseName: Phase, currentPhase: string): string {
  const phaseOrder = PHASES.indexOf(phaseName);
  const currentOrder = PHASES.indexOf(currentPhase as Phase);
  if (currentOrder === -1) return colors.green;
  if (phaseOrder < currentOrder) return colors.green;
  if (phaseOrder === currentOrder) return colors.yellow;
  return colors.textDim;
}

// ─── Progress bar ─────────────────────────────────────────────────────────────

function ProgressBar({ progress, elapsed, width }: { progress: number; elapsed: number; width: number }): React.ReactElement {
  const pct = Math.min(100, Math.max(0, progress));
  const filledCount = Math.round((pct / 100) * width);
  const emptyCount = width - filledCount;
  const filled = CHARS.progressFull.repeat(filledCount);
  const empty = CHARS.progressEmpty.repeat(emptyCount);
  const elapsedStr = elapsed.toFixed(1) + 's';

  return (
    <Box flexDirection="row" gap={1}>
      <Text color={colors.accent}>{filled}</Text>
      <Text color={colors.surface0}>{empty}</Text>
      <Text color={colors.textDim}>{pct}%</Text>
      <Text color={colors.overlay1}>{elapsedStr}</Text>
    </Box>
  );
}

// ─── Stream line severity coloring ────────────────────────────────────────────

function streamLineColor(line: string): string {
  if (line.startsWith('CRI')) return colors.red;
  if (line.startsWith('WRN')) return colors.yellow;
  return colors.textDim;
}

function streamLinePrefix(line: string): { prefix: string; rest: string; prefixColor: string } {
  if (line.startsWith('CRI ') || line.startsWith('WRN ') || line.startsWith('INF ')) {
    const prefix = line.slice(0, 3);
    const rest = line.slice(4);
    return { prefix, rest, prefixColor: streamLineColor(line) };
  }
  return { prefix: 'INF', rest: line, prefixColor: colors.textDim };
}

// ─── LiveMonitor ──────────────────────────────────────────────────────────────

interface LiveMonitorProps {
  liveState: LiveState;
  frameIdx: number;
  barWidth?: number;
  streamLines?: number;
}

export function LiveMonitor({ liveState, frameIdx, barWidth = 20, streamLines = 7 }: LiveMonitorProps): React.ReactElement {
  const progress = liveState.progress ?? 0;
  const visible = liveState.streamLines.slice(-streamLines);

  const left = (
    <Box flexDirection="column" paddingX={1} gap={0}>
      <Box flexDirection="row" gap={1}>
        <Text color={colors.overlay1}>REVIEW</Text>
        <Text color={colors.text} bold>{liveState.tool}</Text>
        <Text color={colors.textDim}>·</Text>
        <Text color={colors.subtext0}>{liveState.mode}</Text>
      </Box>
      <ProgressBar progress={progress} elapsed={liveState.elapsed} width={barWidth} />
      {PHASES.map((phaseName) => {
        const icon = phaseIcon(phaseName, liveState.phase, frameIdx);
        const col = phaseColor(phaseName, liveState.phase);
        return (
          <Box key={phaseName} flexDirection="row" gap={1}>
            <Text color={col}>{icon}</Text>
            <Text color={col}>{phaseName.padEnd(8)}</Text>
          </Box>
        );
      })}
    </Box>
  );

  const right = (
    <Box flexDirection="column" paddingX={1} gap={0}>
      <Text color={colors.overlay1}>STREAM</Text>
      {visible.length === 0 ? (
        <Text color={colors.textDim}>waiting for output...</Text>
      ) : (
        visible.map((line, i) => {
          const { prefix, rest, prefixColor } = streamLinePrefix(line);
          return (
            <Box key={i} flexDirection="row" gap={1}>
              <Text color={colors.textDim}>│</Text>
              <Text color={prefixColor}>{prefix}</Text>
              <Text color={colors.subtext0}>{rest}</Text>
            </Box>
          );
        })
      )}
    </Box>
  );

  return <FullWidthRow leftRatio={0.45}>{[left, right]}</FullWidthRow>;
}
