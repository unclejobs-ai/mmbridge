import type { BoardSnapshot } from '@mmbridge/aps';
import { Box, Text } from 'ink';
import React from 'react';
import { colors } from '../theme.js';
import { formatCost, formatTokens, migrationHint, visibleWindow } from './format.js';
import { costLanes, costRows } from './store.js';

export function CostView({
  snapshot,
  project,
  selectedIndex,
  capacity,
}: {
  snapshot: BoardSnapshot;
  project: string | null;
  selectedIndex: number;
  capacity: number;
}) {
  if (!snapshot.runsAvailable || !snapshot.cost) return <Text color={colors.yellow}>{migrationHint}</Text>;
  const rows = costRows(snapshot, project);
  const lanes = costLanes(snapshot, project);
  const selectedLane = rows[selectedIndex]?.lane;
  const laneIndex = Math.max(
    0,
    lanes.findIndex((row) => row.lane === selectedLane),
  );
  const laneWindow = visibleWindow(lanes.length, laneIndex, Math.min(3, Math.max(1, capacity / 5)));
  const quota = snapshot.cost.quota;
  const quotaText =
    quota.length === 0
      ? 'no quota samples'
      : quota.map((row) => `${row.vendor}/${row.account} ${row.metric}=${row.value} @ ${row.at}`).join(' · ');
  const size = Math.max(1, Math.floor((capacity - (laneWindow.end - laneWindow.start) - 6) / 2));
  const window = visibleWindow(rows.length, selectedIndex, size);
  return (
    <Box flexDirection="column">
      <Text bold color={colors.accent}>
        Cost · snapshot window (default 7 days) · ≈$ list-equiv
      </Text>
      <Text color={colors.textMuted}>Lane totals · runs / unknown / not collected · IO / cache-read tokens</Text>
      {lanes.slice(laneWindow.start, laneWindow.end).map((row) => (
        <Text key={row.lane} wrap="truncate-end">
          {row.lane} · {formatCost(row.usdActual)} · runs {row.runs} / {row.runsUnknown} / {row.runsUncollected}
          {' · '}
          {formatTokens(row.ioTokens)} / {formatTokens(row.cacheRead)}
        </Text>
      ))}
      <Text bold color={colors.accent}>
        By card · multiple runs expose rework
      </Text>
      {rows.length === 0 && <Text color={colors.textMuted}>No dispatched runs in this window.</Text>}
      {rows.slice(window.start, window.end).map((row, offset) => (
        <Box key={`${row.cardId}/${row.lane}/${row.harness}/${row.kind}/${row.model}`} flexDirection="column">
          <Text color={window.start + offset === selectedIndex ? colors.accent : colors.text} wrap="truncate-end">
            {window.start + offset === selectedIndex ? '❯' : ' '} {row.cardId} · {row.lane} · {row.harness}
            {row.kind ? `/${row.kind}` : ''} · {row.model}
          </Text>
          <Text color={colors.textMuted} wrap="truncate-end">
            {'  '}
            {formatCost(row.usdActual)} · IO {formatTokens(row.ioTokens)} · cache-read {formatTokens(row.cacheRead)}
            {' · '}runs {row.runs} · unknown {row.runsUnknown} · not collected {row.runsUncollected}
          </Text>
        </Box>
      ))}
      {rows.length > size && (
        <Text dimColor>
          Row {selectedIndex + 1}/{rows.length} · ↑↓ scroll
        </Text>
      )}
      <Text color={colors.textMuted}>Quota (global): {quotaText}</Text>
      <Text color={colors.yellow}>Dispatched runs only; reviewer and manager sessions excluded.</Text>
    </Box>
  );
}
