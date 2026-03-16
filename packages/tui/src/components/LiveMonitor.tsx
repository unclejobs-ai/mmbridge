import type { LiveState } from '@mmbridge/core';
import { Box, Text } from 'ink';
import type React from 'react';
import { colors } from '../theme.js';
import { FullWidthRow } from './FullWidthRow.js';
import { ReviewFlowMap, buildLiveReviewFlow } from './ReviewFlowMap.js';

function ProgressBar({
  progress,
  elapsed,
  width,
}: { progress: number; elapsed: number; width: number }): React.ReactElement {
  const pct = Math.min(100, Math.max(0, progress));
  const filledCount = Math.round((pct / 100) * width);
  const emptyCount = width - filledCount;
  const filled = '█'.repeat(filledCount);
  const empty = '░'.repeat(emptyCount);
  const elapsedStr = `${elapsed.toFixed(1)}s`;

  return (
    <Box flexDirection="row" gap={1}>
      <Text color={colors.accent}>{filled}</Text>
      <Text color={colors.surface0}>{empty}</Text>
      <Text color={colors.textDim}>{pct}%</Text>
      <Text color={colors.overlay1}>{elapsedStr}</Text>
    </Box>
  );
}

function streamLineColor(line: string): string {
  if (line.includes('"status":"failed"') || line.includes('Error:')) return colors.red;
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
  if (line.includes('"type":"item.started"')) {
    return { prefix: 'RUN', rest: line, prefixColor: colors.accent };
  }
  if (line.includes('"type":"item.completed"')) {
    return { prefix: 'DONE', rest: line, prefixColor: colors.green };
  }
  return { prefix: 'INF', rest: line, prefixColor: streamLineColor(line) };
}

function TelemetryCard({
  label,
  value,
  accent = colors.accent,
}: {
  label: string;
  value: string;
  accent?: string;
}): React.ReactElement {
  return (
    <Box flexDirection="column" width={15}>
      <Text color={colors.overlay1}>{label}</Text>
      <Text color={accent} bold>
        {value}
      </Text>
    </Box>
  );
}

interface LiveMonitorProps {
  liveState: LiveState;
  frameIdx: number;
  barWidth?: number;
  streamLines?: number;
}

export function LiveMonitor({
  liveState,
  frameIdx: _frameIdx,
  barWidth = 20,
  streamLines = 7,
}: LiveMonitorProps): React.ReactElement {
  const progress =
    liveState.progress ??
    {
      context: 18,
      review: 46,
      bridge: 70,
      interpret: 84,
      enrich: 96,
    }[liveState.phase] ??
    8;
  const visible = liveState.streamLines.slice(-streamLines);
  const map = buildLiveReviewFlow(liveState);
  const telemetry = liveState.telemetry;
  const activeTools = (liveState.toolStates ?? []).filter((tool) => tool.status === 'running').length;
  const doneTools = (liveState.toolStates ?? []).filter((tool) => tool.status === 'done').length;

  const left = (
    <Box flexDirection="column" paddingX={1} gap={1}>
      <ProgressBar progress={progress} elapsed={liveState.elapsed / 1000} width={barWidth} />
      <ReviewFlowMap {...map} />
    </Box>
  );

  const right = (
    <Box flexDirection="column" paddingX={1} gap={1}>
      <Box flexDirection="column">
        <Text color={colors.overlay1}>LIVE TELEMETRY</Text>
        <Box flexDirection="row" flexWrap="wrap" gap={2}>
          <TelemetryCard
            label="phase"
            value={liveState.phase}
            accent={liveState.phase === 'interpret' ? colors.peach : colors.accent}
          />
          <TelemetryCard label="lanes" value={`${activeTools} run · ${doneTools} done`} accent={colors.green} />
          <TelemetryCard
            label="items"
            value={`${telemetry?.startedItems ?? 0} start · ${telemetry?.completedItems ?? 0} done`}
            accent={colors.sky}
          />
          <TelemetryCard label="agents" value={String(telemetry?.spawnedAgents ?? 0)} accent={colors.mauve} />
          <TelemetryCard label="tool calls" value={String(telemetry?.toolCalls ?? 0)} accent={colors.sky} />
          <TelemetryCard label="cmd exec" value={String(telemetry?.commandExecutions ?? 0)} accent={colors.peach} />
          <TelemetryCard label="messages" value={String(telemetry?.agentMessages ?? 0)} accent={colors.yellow} />
        </Box>
        {liveState.currentDetail ? (
          <Text color={colors.subtext1} wrap="truncate-end">
            {liveState.currentDetail}
          </Text>
        ) : null}
      </Box>

      <Box flexDirection="column" gap={0}>
        <Text color={colors.overlay1}>STREAM</Text>
        {visible.length === 0 ? (
          <Text color={colors.textDim}>waiting for output...</Text>
        ) : (
          visible.map((line, i) => {
            const { prefix, rest, prefixColor } = streamLinePrefix(line);
            return (
              <Box key={`stream-${line.slice(0, 30)}-${i}`} flexDirection="row" gap={1}>
                <Text color={colors.textDim}>│</Text>
                <Text color={prefixColor}>{prefix}</Text>
                <Text color={colors.subtext0} wrap="truncate-end">
                  {rest}
                </Text>
              </Box>
            );
          })
        )}
      </Box>
    </Box>
  );

  return (
    <FullWidthRow leftRatio={0.52}>
      {[<Box key="live-map">{left}</Box>, <Box key="live-telemetry">{right}</Box>]}
    </FullWidthRow>
  );
}
