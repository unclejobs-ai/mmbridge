import type { BoardSnapshot } from '@mmbridge/aps';
import { Box, Text } from 'ink';
import React from 'react';
import { colors } from '../theme.js';
import { fitCell, formatAge, visibleWindow } from './format.js';
import { groupLaneGrid, laneCards } from './store.js';

const columns = [
  ['issued', '발행'],
  ['working', '작업'],
  ['reported', '완료보고'],
  ['closed_session', '종료'],
  ['inspecting', '검수'],
  ['revise', '수정요청'],
  ['accepted', '수락'],
  ['merge_wait', '머지대기'],
  ['done', '완료'],
  ['rejected', '반려'],
] as const;

export function LaneBoard({
  snapshot,
  project,
  selectedIndex,
  width,
  capacity,
}: {
  snapshot: BoardSnapshot;
  project: string | null;
  selectedIndex: number;
  width: number;
  capacity: number;
}) {
  const grid = groupLaneGrid(snapshot.lanes, project);
  const cards = laneCards(snapshot, project);
  const selected = cards[selectedIndex];
  const groupIndex = Math.max(
    0,
    grid.findIndex(
      (row) =>
        row.project === selected?.project &&
        row.lane === selected?.lane &&
        (row.lane !== '(unassigned)' || row.layer === selected.layerOwner),
    ),
  );
  const wide = width >= 110;
  const labelWidth = 24;
  const cellWidth = Math.max(8, Math.floor((width - labelWidth) / columns.length));
  const laneCapacity = Math.max(1, Math.min(4, Math.floor(capacity / (wide ? 3 : 6))));
  const lanesWindow = visibleWindow(grid.length, groupIndex, laneCapacity);
  const cardCapacity = Math.max(1, capacity - laneCapacity * (wide ? 1 : 4) - (wide ? 4 : 3));
  const cardWindow = visibleWindow(cards.length, selectedIndex, cardCapacity);
  return (
    <Box flexDirection="column">
      <Text bold color={colors.accent}>
        Lane board · today’s 완료/반려 · count / oldest age
      </Text>
      {wide && (
        <Text color={colors.textMuted}>
          {fitCell('Project / lane / layer', labelWidth)}
          {columns.map(([, label]) => fitCell(label, cellWidth)).join('')}
        </Text>
      )}
      {grid.length === 0 && <Text color={colors.textMuted}>No cards in this project. Press p to change project.</Text>}
      {grid.slice(lanesWindow.start, lanesWindow.end).map((lane) => {
        const label = `${lane.project}/${lane.lane} ${lane.layer}`;
        const values = columns.map(([state, label]) => {
          const cell = lane.cells.find((row) => row.state === state);
          const value = cell ? `${cell.n}/${formatAge(cell.oldestSince, snapshot.readAt)}` : '—';
          return wide ? fitCell(value, cellWidth) : `${label} ${value}`;
        });
        return (
          <Box key={lane.key} flexDirection="column">
            <Text color={lane === grid[groupIndex] ? colors.text : colors.textMuted}>
              {wide ? `${fitCell(label, labelWidth)}${values.join('')}` : label}
            </Text>
            {!wide && <Text color={colors.textMuted}>{values.slice(0, 5).join(' · ')}</Text>}
            {!wide && <Text color={colors.textMuted}>{values.slice(5).join(' · ')}</Text>}
          </Box>
        );
      })}
      {grid.length > laneCapacity && (
        <Text dimColor>
          Lane {lanesWindow.start + 1}–{lanesWindow.end}/{grid.length} · follows selected card
        </Text>
      )}
      <Text bold color={colors.accent}>
        Cards · ↑↓ select · Enter detail ({cards.length})
      </Text>
      {cards.slice(cardWindow.start, cardWindow.end).map((card, offset) => {
        const active = cardWindow.start + offset === selectedIndex;
        return (
          <Text key={card.cardId} color={active ? colors.accent : colors.text} wrap="truncate-end">
            {active ? '❯' : ' '} {card.cardId} · {card.kanbanKo} {formatAge(card.since, snapshot.readAt)} · {card.lane}{' '}
            · {card.title}
          </Text>
        );
      })}
      {cards.length > cardCapacity && (
        <Text dimColor>
          Card {selectedIndex + 1}/{cards.length}
        </Text>
      )}
    </Box>
  );
}
