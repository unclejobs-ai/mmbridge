import type { BoardSnapshot } from '@mmbridge/aps';
import { initialNavigation, reduceBoardKey } from './keymap.js';
import type { BoardAction, BoardNavigation, BoardView } from './keymap.js';

export type CardRow = BoardSnapshot['cards'][number];
export type LaneRow = BoardSnapshot['lanes'][number];
export type ReviewRow = BoardSnapshot['reviewQueue'][number];
export type CostCardRow = NonNullable<BoardSnapshot['cost']>['byCard'][number];
export type HygieneRow = BoardSnapshot['hygiene'][number];

export interface BoardState extends BoardNavigation {
  snapshot: BoardSnapshot | null;
  status: string | null;
}

export interface LaneGridRow {
  key: string;
  project: string;
  lane: string;
  layer: string;
  cells: LaneRow[];
}

export interface BoardSelection {
  key: string;
  cardId: string | null;
  command: string | null;
}

export function groupLaneGrid(lanes: LaneRow[], project: string | null = null): LaneGridRow[] {
  const groups = new Map<string, LaneGridRow>();
  for (const row of lanes) {
    if (project !== null && row.project !== project) continue;
    const owner = row.lane === '(unassigned)' ? row.layerOwner : '';
    const key = `${row.project}\0${row.lane}\0${owner}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, project: row.project, lane: row.lane, layer: row.layer ?? row.layerOwner, cells: [] };
      groups.set(key, group);
    }
    group.cells.push(row);
  }
  const result = [...groups.values()].sort(
    (a, b) => a.project.localeCompare(b.project) || a.layer.localeCompare(b.layer) || a.lane.localeCompare(b.lane),
  );
  for (const row of result) row.cells.sort((a, b) => a.stateOrd - b.stateOrd);
  return result;
}

export function laneCards(snapshot: BoardSnapshot, project: string | null): CardRow[] {
  const today = snapshot.readAt.slice(0, 10);
  return snapshot.cards
    .filter(
      (row) =>
        (project === null || row.project === project) &&
        (!['done', 'rejected'].includes(row.state) || row.since >= `${today}T00:00:00.000Z`),
    )
    .sort(
      (a, b) =>
        a.project.localeCompare(b.project) ||
        a.lane.localeCompare(b.lane) ||
        a.stateOrd - b.stateOrd ||
        a.since.localeCompare(b.since),
    );
}

export function reviewRows(snapshot: BoardSnapshot, project: string | null): ReviewRow[] {
  return snapshot.reviewQueue
    .filter((row) => project === null || row.project === project)
    .sort((a, b) => Number(b.state === 'reported') - Number(a.state === 'reported') || a.since.localeCompare(b.since));
}

export function hygieneRows(snapshot: BoardSnapshot, project: string | null): HygieneRow[] {
  const cards = new Set(snapshot.cards.filter((row) => row.project === project).map((row) => row.cardId));
  return snapshot.hygiene.filter((row) => project === null || (row.cardId !== null && cards.has(row.cardId)));
}

export function costRows(snapshot: BoardSnapshot, project: string | null): CostCardRow[] {
  if (!snapshot.runsAvailable || !snapshot.cost) return [];
  return snapshot.cost.byCard.filter((row) => project === null || row.project === project);
}

export function costLanes(
  snapshot: BoardSnapshot,
  project: string | null,
): NonNullable<BoardSnapshot['cost']>['byLane'] {
  if (!snapshot.runsAvailable || !snapshot.cost) return [];
  if (project === null) return snapshot.cost.byLane;
  const groups = new Map<string, NonNullable<BoardSnapshot['cost']>['byLane'][number]>();
  for (const row of costRows(snapshot, project)) {
    const current = groups.get(row.lane);
    if (!current) {
      groups.set(row.lane, { ...row });
      continue;
    }
    current.runs += row.runs;
    current.usdActual =
      current.usdActual === null && row.usdActual === null ? null : (current.usdActual ?? 0) + (row.usdActual ?? 0);
    current.ioTokens += row.ioTokens;
    current.cacheRead += row.cacheRead;
    current.runsUnknown += row.runsUnknown;
    current.runsUncollected += row.runsUncollected;
  }
  return [...groups.values()].sort((a, b) => (b.usdActual ?? -1) - (a.usdActual ?? -1));
}

export function boardHeader(snapshot: BoardSnapshot, project: string | null): BoardSnapshot['header'] {
  if (project === null) return snapshot.header;
  const cards = snapshot.cards.filter((row) => row.project === project);
  const reviewQueue = cards.filter((row) => ['reported', 'closed_session'].includes(row.state)).length;
  return {
    ...snapshot.header,
    wip: cards.filter((row) => !['issued', 'done', 'rejected'].includes(row.state)).length,
    reviewQueue,
    inReview: cards.filter((row) => row.state === 'inspecting').length,
    paused: reviewQueue > 2 * snapshot.header.reviewers,
  };
}

export function hygieneCounts(rows: HygieneRow[]): { closeNow: number; leak: number; ghost: number; unknown: number } {
  const counts = { closeNow: 0, leak: 0, ghost: 0, unknown: 0 };
  for (const row of rows) {
    if (row.classification === 'CLOSE-NOW') counts.closeNow++;
    if (row.classification === 'LEAK') counts.leak++;
    if (row.classification === 'GHOST') counts.ghost++;
    if (row.classification === '?') counts.unknown++;
  }
  return counts;
}

export function nextCardCommand(card: CardRow): string | null {
  const id = JSON.stringify(card.cardId);
  if (card.state === 'reported' || card.state === 'working') return `mmbridge aps collect ${id} --by <you>`;
  if (card.state === 'closed_session') return `mmbridge aps card show ${id}`;
  return null;
}

export function boardSelections(state: BoardState): BoardSelection[] {
  const snapshot = state.snapshot;
  if (!snapshot) return [];
  switch (state.view) {
    case 'lanes':
      return laneCards(snapshot, state.project).map((row) => ({
        key: row.cardId,
        cardId: row.cardId,
        command: nextCardCommand(row),
      }));
    case 'review':
      return reviewRows(snapshot, state.project).map((row) => ({
        key: row.cardId,
        cardId: row.cardId,
        command:
          row.state === 'reported'
            ? `mmbridge aps collect ${JSON.stringify(row.cardId)} --by <you>`
            : row.state === 'closed_session'
              ? `mmbridge aps card show ${JSON.stringify(row.cardId)}`
              : null,
      }));
    case 'cost':
      return costRows(snapshot, state.project).map((row) => ({
        key: `${row.cardId}\0${row.lane}\0${row.harness}\0${row.kind}\0${row.model}`,
        cardId: row.cardId,
        command: null,
      }));
    case 'hygiene':
      return hygieneRows(snapshot, state.project).map((row, index) => ({
        key: `${row.agentId}\0${row.runId}\0${row.paneId}\0${index}`,
        cardId: row.cardId,
        command: row.action,
      }));
  }
}

export interface BoardStore {
  getSnapshot: () => BoardState;
  subscribe: (listener: () => void) => () => void;
  setSnapshot: (snapshot: BoardSnapshot) => void;
  setStatus: (status: string | null) => void;
  select: (index: number) => void;
  view: (view: BoardView) => void;
  setProject: (project: string | null) => void;
  dispatch: (action: BoardAction) => void;
}

export function createBoardStore(snapshot: BoardSnapshot | null = null): BoardStore {
  let state: BoardState = { ...initialNavigation, snapshot, status: null };
  const listeners = new Set<() => void>();
  const publish = (next: BoardState) => {
    if (next === state) return;
    state = next;
    for (const listener of listeners) listener();
  };
  const dispatch = (action: BoardAction) => {
    const rows = boardSelections(state);
    const projects = [...new Set(state.snapshot?.cards.map((row) => row.project) ?? [])].sort();
    const navigation = reduceBoardKey(state, action, {
      rowCount: rows.length,
      selectedCardId: rows[state.selectedIndex]?.cardId ?? null,
      projects,
    });
    publish(navigation === state ? state : { ...state, ...navigation });
  };
  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setSnapshot(snapshot) {
      const selectedKey = boardSelections(state)[state.selectedIndex]?.key;
      let next = { ...state, snapshot, status: null };
      if (next.project !== null && !snapshot.cards.some((row) => row.project === next.project)) next.project = null;
      const rows = boardSelections(next);
      const selectedIndex = rows.findIndex((row) => row.key === selectedKey);
      next = {
        ...next,
        selectedIndex: selectedIndex < 0 ? Math.min(state.selectedIndex, rows.length - 1) : selectedIndex,
      };
      next.selectedIndex = Math.max(0, next.selectedIndex);
      if (next.detailCardId && !snapshot.cards.some((row) => row.cardId === next.detailCardId))
        next.detailCardId = null;
      publish(next);
    },
    setStatus: (status) => publish({ ...state, status }),
    select: (index) => dispatch({ type: 'select', index }),
    view: (view) => dispatch({ type: 'view', view }),
    setProject: (project) => dispatch({ type: 'project', project }),
    dispatch,
  };
}
