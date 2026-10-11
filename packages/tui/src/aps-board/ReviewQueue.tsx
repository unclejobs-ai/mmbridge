import type { BoardSnapshot } from '@mmbridge/aps';
import { Box, Text } from 'ink';
import React from 'react';
import { colors } from '../theme.js';
import { formatAge, visibleWindow } from './format.js';
import { reviewRows } from './store.js';

export function ReviewQueue({
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
  const rows = reviewRows(snapshot, project);
  const size = Math.max(1, Math.floor((capacity - 4) / 3));
  const window = visibleWindow(rows.length, selectedIndex, size);
  const incomplete = rows.filter((row) => row.state === 'reported').length;
  return (
    <Box flexDirection="column">
      <Text bold color={colors.accent}>
        Review queue · oldest first · independence is by lane name
      </Text>
      <Text color={colors.yellow}>Handoff incomplete {incomplete} · session not closed → aps collect</Text>
      <Text color={colors.green}>Eligible {rows.length - incomplete} · closed_session / inspecting (in review)</Text>
      {rows.length === 0 && <Text color={colors.textMuted}>No review handoffs in this project.</Text>}
      {rows.slice(window.start, window.end).map((row, offset) => {
        const active = window.start + offset === selectedIndex;
        return (
          <Box key={row.cardId} flexDirection="column">
            <Text color={active ? colors.accent : colors.text} wrap="truncate-end">
              {active ? '❯' : ' '} {row.cardId} · {row.title}
            </Text>
            <Text color={row.state === 'reported' ? colors.yellow : colors.green} wrap="truncate-end">
              {'  '}
              {row.state === 'reported'
                ? 'Handoff incomplete'
                : row.state === 'inspecting'
                  ? 'Eligible · in review'
                  : 'Eligible'}
              {' · '}
              {formatAge(row.since, snapshot.readAt)} · attempt {row.attempt} · rework {row.reworkCount}/3
              {row.needsVision ? ' · vision required' : ''}
              {row.needsOwner ? ' · owner required' : ''}
            </Text>
            <Text color={colors.textMuted} wrap="truncate-end">
              {'  '}lane {row.lane} · {row.model ?? 'no model'} · PR {row.prUrl ?? 'none'}
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
