import { Box, Text, useApp, useInput, useStdout } from 'ink';
import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { colors } from '../theme.js';
import { CardDetail, cardDetailLines } from './CardDetail.js';
import { CostView } from './CostView.js';
import { HygieneView } from './HygieneView.js';
import { LaneBoard } from './LaneBoard.js';
import { ReviewQueue } from './ReviewQueue.js';
import { wrapLines } from './format.js';
import { boardKeyAction } from './keymap.js';
import { boardHeader, boardSelections, hygieneCounts, nextCardCommand } from './store.js';
import type { BoardStore } from './store.js';

/** Operate surface: inherited terminal palette, dense kanban, global hygiene always visible. */
export function AppBoard({
  store,
  onRefresh,
  onQuit,
}: {
  store: BoardStore;
  onRefresh: () => void | Promise<void>;
  onQuit: () => void | Promise<void>;
}) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const { stdout } = useStdout();
  const { exit } = useApp();
  const [size, setSize] = useState({ width: stdout.columns || 120, height: stdout.rows || 30 });
  useEffect(() => {
    const resize = () => setSize({ width: stdout.columns || 120, height: stdout.rows || 30 });
    stdout.on('resize', resize);
    return () => {
      stdout.off('resize', resize);
    };
  }, [stdout]);
  const snapshot = state.snapshot;
  const width = Math.max(2, size.width - 2);
  const capacity = Math.max(3, size.height - 12);
  const card = snapshot?.cards.find((row) => row.cardId === state.detailCardId);
  useInput((input, key) => {
    const action = boardKeyAction(input, key);
    if (!action) return;
    if (action.type === 'quit') {
      Promise.resolve()
        .then(onQuit)
        .then(
          () => exit(),
          (error: unknown) => {
            exit(error instanceof Error ? error : new Error(String(error)));
          },
        );
    } else if (action.type === 'refresh') {
      Promise.resolve()
        .then(onRefresh)
        .catch((error: unknown) => store.setStatus(`Refresh failed: ${String(error)}`));
    } else {
      if (action.type === 'move' && card && snapshot && !state.help) {
        const length = wrapLines(cardDetailLines(card, snapshot.runsAvailable, snapshot.readAt), width).length;
        const offset = Math.max(0, Math.min(state.detailOffset + action.delta, length - capacity));
        store.dispatch({ ...action, delta: offset - state.detailOffset });
      } else store.dispatch(action);
    }
  });
  const header = snapshot ? boardHeader(snapshot, state.project) : null;
  const hygiene = snapshot ? hygieneCounts(snapshot.hygiene) : null;
  const rows = boardSelections(state);
  const command = card ? nextCardCommand(card) : rows[state.selectedIndex]?.command;
  const props = snapshot ? { snapshot, project: state.project, selectedIndex: state.selectedIndex, capacity } : null;
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color={colors.accent}>
        APS board · {state.project ?? 'all projects'} · {state.view} · read-only
      </Text>
      {header && (
        <Text>
          WIP {header.wip} · review queue {header.reviewQueue} (in review {header.inReview}) · feedback overdue{' '}
          {header.feedbackOverdue}
        </Text>
      )}
      {header && (
        <Text color={colors.textMuted}>
          Feedback (global) open {header.feedbackOpen} (escalated {header.feedbackEscalated}, overdue{' '}
          {header.feedbackOverdue}) · reviewers {header.reviewers}
        </Text>
      )}
      {header?.paused && (
        <Text bold color={colors.red}>
          DISPATCH PAUSED · queue &gt; 2× active L1+L2 reviewers (advisory only)
        </Text>
      )}
      {hygiene && (
        <Text color={hygiene.closeNow + hygiene.leak + hygiene.ghost ? colors.red : colors.textMuted}>
          hygiene (global): {hygiene.closeNow} CLOSE-NOW · {hygiene.leak} LEAK · {hygiene.ghost} GHOST ·{' '}
          {hygiene.unknown} ?
        </Text>
      )}
      {snapshot?.stale.db && (
        <Text color={colors.red}>STALE DB · last good snapshot retained: {snapshot.stale.db}</Text>
      )}
      {snapshot && (!snapshot.herdr.ok || snapshot.stale.herdr) && (
        <Text color={colors.yellow}>
          herdr unavailable (last ok {snapshot.herdr.at?.slice(11, 19) ?? 'never'}) ·{' '}
          {snapshot.stale.herdr ?? snapshot.herdr.error ?? 'no pane observations'}
        </Text>
      )}
      {state.status && <Text color={colors.red}>{state.status}</Text>}
      {!snapshot && (
        <Text color={colors.textMuted}>Waiting for ledger snapshot · r retry · q quit (no ledger is created)</Text>
      )}
      {state.help ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color={colors.accent}>
            Keyboard help
          </Text>
          <Text>1 lanes · 2 review · 3 cost · 4 hygiene</Text>
          <Text>↑↓ select / scroll detail · Enter detail · Esc back</Text>
          <Text>p cycle project · r refresh DB and herdr · ? help · q quit</Text>
          <Text>Commands are text only. Run write actions in the CLI with your --by identity.</Text>
        </Box>
      ) : card && snapshot ? (
        <CardDetail
          card={card}
          runsAvailable={snapshot.runsAvailable}
          readAt={snapshot.readAt}
          width={width}
          capacity={capacity}
          offset={state.detailOffset}
        />
      ) : props ? (
        <Box flexDirection="column" marginTop={1}>
          {state.view === 'lanes' && <LaneBoard {...props} width={width} />}
          {state.view === 'review' && <ReviewQueue {...props} />}
          {state.view === 'cost' && <CostView {...props} />}
          {state.view === 'hygiene' && <HygieneView {...props} />}
        </Box>
      ) : null}
      <Box flexDirection="column" marginTop={1}>
        <Text color={colors.yellow}>
          {command
            ? `Next: ${command}`
            : (card?.nextBlockers[0] ?? 'Select a card for its next blockers; Enter opens evidence.')}
        </Text>
        <Text color={colors.textMuted}>
          1 lanes · 2 review · 3 cost · 4 hygiene · ↑↓ · Enter · Esc · p project · r refresh · ? help · q quit
        </Text>
        {snapshot && (
          <Text dimColor wrap="truncate-end">
            {snapshot.dbPath} · schema v{snapshot.schemaVersion} · read {snapshot.readAt}
          </Text>
        )}
      </Box>
    </Box>
  );
}
