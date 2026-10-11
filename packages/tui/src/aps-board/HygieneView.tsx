import type { BoardSnapshot } from '@mmbridge/aps';
import { Box, Text } from 'ink';
import React from 'react';
import { colors } from '../theme.js';
import { formatAge, visibleWindow } from './format.js';
import { hygieneRows } from './store.js';

export function HygieneView({
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
  const rows = hygieneRows(snapshot, project);
  const size = Math.max(1, Math.floor((capacity - 3) / 3));
  const window = visibleWindow(rows.length, selectedIndex, size);
  return (
    <Box flexDirection="column">
      <Text bold color={colors.accent}>
        Session hygiene · ledger sessions ↔ live herdr panes
      </Text>
      <Text color={colors.textMuted}>
        Shells (global): {snapshot.herdr.shells} · commands are suggestions, never executed
      </Text>
      {rows.length === 0 && <Text color={colors.textMuted}>No session hygiene rows in this project.</Text>}
      {rows.slice(window.start, window.end).map((row, offset) => {
        const active = window.start + offset === selectedIndex;
        const severity = ['CLOSE-NOW', 'LEAK', 'GHOST', 'STUCK-INTENT'].includes(row.classification);
        return (
          <Box key={`${row.agentId}/${row.runId}/${row.paneId}/${window.start + offset}`} flexDirection="column">
            <Text color={active ? colors.accent : severity ? colors.red : colors.text} wrap="truncate-end">
              {active ? '❯' : ' '} {row.classification} · {row.lane} · {row.cardId ?? 'no card'} · pane{' '}
              {row.paneId ?? 'none'}
            </Text>
            <Text color={colors.textMuted} wrap="truncate-end">
              {'  '}
              {row.ledger?.layer ?? 'untracked'} · ledger {row.ledger?.agentStatus ?? 'none'} · run{' '}
              {row.ledger?.runStatus ?? 'none'}
              {' · '}
              {formatAge(row.ledger?.runSince ?? row.ledger?.startedAt ?? null, snapshot.readAt)}
              {' · '}herdr {row.pane?.agentStatus ?? 'unavailable'} · terminal{' '}
              {row.pane?.terminalId ?? row.ledger?.terminalId ?? 'none'}
            </Text>
            <Text color={row.classification === '?' ? colors.yellow : colors.textMuted} wrap="truncate-end">
              {'  '}
              {row.classification === '?'
                ? 'Pane observations unavailable; no LEAK/GHOST inference from stale data.'
                : (row.action ?? 'Info only; no action needed.')}
            </Text>
          </Box>
        );
      })}
      {rows.length > size && (
        <Text dimColor>
          Row {selectedIndex + 1}/{rows.length} · ↑↓ scroll
        </Text>
      )}
    </Box>
  );
}
