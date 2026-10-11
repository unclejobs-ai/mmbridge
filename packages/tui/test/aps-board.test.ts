import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import type { BoardSnapshot } from '@mmbridge/aps';
import { render } from 'ink';
import React from 'react';
import { AppBoard } from '../dist/aps-board/AppBoard.js';
import { CardDetail, cardDetailLines } from '../dist/aps-board/CardDetail.js';
import { CostView } from '../dist/aps-board/CostView.js';
import { HygieneView } from '../dist/aps-board/HygieneView.js';
import { LaneBoard } from '../dist/aps-board/LaneBoard.js';
import { ReviewQueue } from '../dist/aps-board/ReviewQueue.js';
import { fitCell, formatAge, formatCost, formatTokens, visibleWindow } from '../dist/aps-board/format.js';
import { boardKeyAction, initialNavigation, reduceBoardKey } from '../dist/aps-board/keymap.js';
import {
  boardHeader,
  boardSelections,
  costLanes,
  createBoardStore,
  groupLaneGrid,
  hygieneCounts,
  laneCards,
  reviewRows,
} from '../dist/aps-board/store.js';
import type { CardRow } from '../dist/aps-board/store.js';

const context = { rowCount: 3, selectedCardId: 'FAC-1', projects: ['alpha', 'beta'] };

test('keymap 1-4/Enter/Esc/p/r/q', () => {
  for (const [input, view] of [
    ['1', 'lanes'],
    ['2', 'review'],
    ['3', 'cost'],
    ['4', 'hygiene'],
  ]) {
    assert.deepEqual(boardKeyAction(input, {}), { type: 'view', view });
  }
  assert.deepEqual(boardKeyAction('', { return: true }), { type: 'detail' });
  assert.deepEqual(boardKeyAction('', { escape: true }), { type: 'back' });
  assert.deepEqual(boardKeyAction('p', {}), { type: 'cycle-project' });
  assert.deepEqual(boardKeyAction('r', {}), { type: 'refresh' });
  assert.deepEqual(boardKeyAction('q', {}), { type: 'quit' });
  assert.deepEqual(boardKeyAction('c', { ctrl: true }), { type: 'quit' });
  assert.deepEqual(boardKeyAction('', { upArrow: true }), { type: 'move', delta: -1 });
  assert.deepEqual(boardKeyAction('', { downArrow: true }), { type: 'move', delta: 1 });
  assert.deepEqual(boardKeyAction('?', {}), { type: 'help' });
  assert.equal(boardKeyAction('x', {}), null);
});

test('navigation clamps selection, enters detail, and cycles project filters', () => {
  let state = reduceBoardKey(initialNavigation, { type: 'move', delta: 20 }, context);
  assert.equal(state.selectedIndex, 2);
  state = reduceBoardKey(state, { type: 'detail' }, context);
  assert.equal(state.detailCardId, 'FAC-1');
  state = reduceBoardKey(state, { type: 'move', delta: 1 }, context);
  assert.equal(state.detailOffset, 1);
  state = reduceBoardKey(state, { type: 'back' }, context);
  assert.equal(state.detailCardId, null);
  state = reduceBoardKey(state, { type: 'cycle-project' }, context);
  assert.equal(state.project, 'alpha');
  assert.equal(state.selectedIndex, 0);
  state = reduceBoardKey(state, { type: 'cycle-project' }, context);
  assert.equal(state.project, 'beta');
  state = reduceBoardKey(state, { type: 'cycle-project' }, context);
  assert.equal(state.project, null);
  assert.equal(reduceBoardKey(state, { type: 'move', delta: -1 }, context).selectedIndex, 0);
  const empty = { ...context, rowCount: 0, selectedCardId: null, projects: [] };
  assert.equal(reduceBoardKey(state, { type: 'detail' }, empty), state);
  assert.equal(reduceBoardKey(state, { type: 'cycle-project' }, empty).project, null);
});

test('age formatting handles UTC, future, missing, and invalid timestamps', () => {
  const now = '2026-10-11T12:00:00.000Z';
  assert.equal(formatAge('2026-10-11T11:59:30.000Z', now), '<1m');
  assert.equal(formatAge('2026-10-11T11:58:00.000Z', now), '2m');
  assert.equal(formatAge('2026-10-11T10:30:00.000Z', now), '1h30m');
  assert.equal(formatAge('2026-10-09T11:00:00.000Z', now), '2d1h');
  assert.equal(formatAge('2026-10-12T11:00:00.000Z', now), '<1m');
  assert.equal(formatAge(null, now), '—');
  assert.equal(formatAge('invalid', now), '—');
});

test('list-equivalent cost distinguishes zero from unknown usage', () => {
  assert.equal(formatCost(0), '≈$0.00 list-equiv');
  assert.equal(formatCost(12.345), '≈$12.35 list-equiv');
  assert.equal(formatCost(null), 'unknown');
  assert.equal(formatTokens(12000), '12,000');
  assert.equal(formatTokens(null), 'unknown');
});

test('terminal cells fit Korean and windows keep selected rows visible', () => {
  assert.equal(fitCell('발행', 6), '발행  ');
  assert.equal(fitCell('발행작업', 5), '발행…');
  assert.equal(fitCell('abcdef', 4), 'abc…');
  assert.equal(fitCell('abcdef', 0), '');
  assert.deepEqual(visibleWindow(20, 19, 5), { start: 15, end: 20 });
  assert.deepEqual(visibleWindow(2, 0, 5), { start: 0, end: 2 });
});

// Synthetic §4.0 snapshots, never read from the live ledger.
function card(cardId: string, overrides: Partial<CardRow> = {}): CardRow {
  return {
    cardId,
    project: 'alpha',
    title: `Fixture ${cardId}`,
    kind: 'mech',
    state: 'working',
    kanbanKo: '작업',
    stateOrd: 2,
    since: '2026-10-11T10:00:00.000Z',
    assignee: 'worker-1',
    layerOwner: 'L2',
    lane: 'sol',
    model: 'fixture-model',
    assigneeStatus: 'active',
    herdrPane: 'w1:p1',
    attempt: 1,
    reworkCount: 0,
    needsOwner: 0,
    needsVision: 0,
    sha: null,
    reportStatus: null,
    latestReview: null,
    latestVision: null,
    mergeOk: 0,
    ownerOk: 0,
    acceptanceCount: 1,
    timeline: [],
    reports: [],
    reviews: [],
    visionAudits: [],
    links: [],
    runs: [],
    nextBlockers: [],
    ...overrides,
  };
}

function fixture(): BoardSnapshot {
  const cards = [
    card('FAC-1'),
    card('FAC-2', { state: 'reported', kanbanKo: '완료보고', stateOrd: 3, assignee: 'worker-2' }),
    card('FAC-3', {
      project: 'beta',
      lane: '(unassigned)',
      assignee: null,
      state: 'issued',
      kanbanKo: '발행',
      stateOrd: 1,
    }),
    card('FAC-4', {
      title: 'Eligible fixture',
      state: 'closed_session',
      kanbanKo: '종료',
      stateOrd: 4,
      since: '2026-10-11T09:00:00.000Z',
      attempt: 2,
      reworkCount: 1,
      needsOwner: 1,
      needsVision: 1,
    }),
    card('FAC-5', { state: 'closed_session', kanbanKo: '종료', stateOrd: 4 }),
    card('FAC-6', { state: 'inspecting', kanbanKo: '검수', stateOrd: 5 }),
  ];
  return {
    readAt: '2026-10-11T12:00:00.000Z',
    dbPath: '/fixture/aps.db',
    schemaVersion: 2,
    runsAvailable: true,
    header: {
      wip: 5,
      reviewQueue: 3,
      inReview: 1,
      feedbackOverdue: 2,
      feedbackOpen: 4,
      feedbackEscalated: 1,
      paused: true,
      reviewers: 1,
    },
    lanes: [
      {
        project: 'alpha',
        lane: 'sol',
        layer: 'L3',
        layerOwner: 'L2',
        state: 'reported',
        kanbanKo: '완료보고',
        stateOrd: 3,
        n: 1,
        oldestSince: cards[1].since,
      },
      {
        project: 'alpha',
        lane: 'sol',
        layer: 'L3',
        layerOwner: 'L2',
        state: 'working',
        kanbanKo: '작업',
        stateOrd: 2,
        n: 1,
        oldestSince: cards[0].since,
      },
      {
        project: 'beta',
        lane: '(unassigned)',
        layer: null,
        layerOwner: 'L2',
        state: 'issued',
        kanbanKo: '발행',
        stateOrd: 1,
        n: 1,
        oldestSince: cards[2].since,
      },
      {
        project: 'alpha',
        lane: 'sol',
        layer: 'L3',
        layerOwner: 'L2',
        state: 'closed_session',
        kanbanKo: '종료',
        stateOrd: 4,
        n: 2,
        oldestSince: cards[3].since,
      },
      {
        project: 'alpha',
        lane: 'sol',
        layer: 'L3',
        layerOwner: 'L2',
        state: 'inspecting',
        kanbanKo: '검수',
        stateOrd: 5,
        n: 1,
        oldestSince: cards[5].since,
      },
    ],
    cards,
    reviewQueue: [
      {
        cardId: 'FAC-4',
        project: 'alpha',
        title: 'Eligible fixture',
        state: 'closed_session',
        since: cards[3].since,
        attempt: 2,
        reworkCount: 1,
        needsOwner: 1,
        needsVision: 1,
        lane: 'sol',
        model: 'fixture-model',
        sha: 'a'.repeat(40),
        reportStatus: 'DONE',
        prUrl: 'https://example.test/pr/4',
        reportedAt: '2026-10-11T08:00:00.000Z',
      },
      {
        cardId: 'FAC-2',
        project: 'alpha',
        title: 'Incomplete fixture',
        state: 'reported',
        since: cards[1].since,
        attempt: 1,
        reworkCount: 0,
        needsOwner: 0,
        needsVision: 0,
        lane: 'sol',
        model: 'fixture-model',
        sha: 'b'.repeat(40),
        reportStatus: 'DONE',
        prUrl: null,
        reportedAt: cards[1].since,
      },
      {
        cardId: 'FAC-5',
        project: 'alpha',
        title: 'Fixture FAC-5',
        state: 'closed_session',
        since: cards[4].since,
        attempt: 1,
        reworkCount: 0,
        needsOwner: 0,
        needsVision: 0,
        lane: 'sol',
        model: 'fixture-model',
        sha: null,
        reportStatus: 'DONE',
        prUrl: null,
        reportedAt: cards[4].since,
      },
      {
        cardId: 'FAC-6',
        project: 'alpha',
        title: 'Fixture FAC-6',
        state: 'inspecting',
        since: cards[5].since,
        attempt: 1,
        reworkCount: 0,
        needsOwner: 0,
        needsVision: 0,
        lane: 'sol',
        model: 'fixture-model',
        sha: null,
        reportStatus: 'DONE',
        prUrl: null,
        reportedAt: cards[5].since,
      },
    ],
    cost: {
      byLane: [
        { lane: 'sol', runs: 3, usdActual: 4.25, ioTokens: 1200, cacheRead: 500, runsUnknown: 1, runsUncollected: 1 },
      ],
      byCard: [
        {
          cardId: 'FAC-1',
          project: 'alpha',
          lane: 'sol',
          harness: 'omp',
          kind: null,
          model: 'fixture-model',
          runs: 2,
          usdActual: 4.25,
          ioTokens: 1200,
          cacheRead: 500,
          runsUnknown: 0,
          runsUncollected: 1,
        },
        {
          cardId: 'FAC-3',
          project: 'beta',
          lane: 'sol',
          harness: 'grok',
          kind: null,
          model: 'fixture-model',
          runs: 1,
          usdActual: null,
          ioTokens: 0,
          cacheRead: 0,
          runsUnknown: 1,
          runsUncollected: 0,
        },
      ],
      quota: [],
    },
    hygiene: [
      {
        classification: 'CLOSE-NOW',
        agentId: 'worker-2',
        lane: 'sol',
        cardId: 'FAC-2',
        runId: 'r2',
        paneId: 'w1:p2',
        action: 'mmbridge aps collect FAC-2 --by <you>',
        ledger: null,
        pane: null,
      },
      {
        classification: 'LEAK',
        agentId: 'worker-3',
        lane: 'opus',
        cardId: null,
        runId: null,
        paneId: 'w1:p3',
        action: 'herdr pane close w1:p3',
        ledger: null,
        pane: null,
      },
      {
        classification: 'GHOST',
        agentId: 'worker-1',
        lane: 'sol',
        cardId: 'FAC-1',
        runId: 'r1',
        paneId: 'w1:p1',
        action: 'mmbridge aps collect FAC-1 --by <you>',
        ledger: null,
        pane: null,
      },
    ],
    herdr: { ok: true, at: '2026-10-11T12:00:00.000Z', shells: 2 },
    stale: {},
  };
}

async function screen(element: React.ReactElement, width = 120, keys: string[] = []): Promise<string> {
  const stdout = Object.assign(new PassThrough(), { columns: width, rows: 40, isTTY: false });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  let output = '';
  stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  const instance = render(element, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stderr: stdout as unknown as NodeJS.WriteStream,
    debug: true,
    exitOnCtrlC: false,
  });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (const key of keys) {
      stdin.write(key);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return output;
  } finally {
    instance.unmount();
    stdout.destroy();
    stdin.destroy();
  }
}

test('lane grid groups by agents.name and orders by state_ord', () => {
  const snapshot = fixture();
  const grid = groupLaneGrid(snapshot.lanes);
  assert.equal(grid.length, 2);
  assert.equal(grid[0].lane, 'sol');
  assert.deepEqual(
    grid[0].cells.map((row) => row.stateOrd),
    [2, 3, 4, 5],
  );
  assert.equal(groupLaneGrid(snapshot.lanes, 'beta')[0].layer, 'L2');
  assert.deepEqual(
    laneCards(snapshot, 'alpha').map((row) => row.cardId),
    ['FAC-1', 'FAC-2', 'FAC-4', 'FAC-5', 'FAC-6'],
  );
  const extra = { ...snapshot.lanes[2], layerOwner: 'L1' };
  assert.equal(groupLaneGrid([...snapshot.lanes, extra], 'beta').length, 2);
});

test('paused banner when queue > 2× reviewers', async () => {
  const snapshot = fixture();
  const store = createBoardStore(snapshot);
  const output = await screen(React.createElement(AppBoard, { store, onRefresh() {}, onQuit() {} }));
  assert.match(output, /DISPATCH PAUSED/);
  assert.match(output, /hygiene \(global\): 1 CLOSE-NOW · 1 LEAK · 1 GHOST/);
  assert.match(output, /Feedback \(global\) open 4/);
  snapshot.header = { ...snapshot.header, reviewQueue: 2, paused: false };
  assert.equal(boardHeader(snapshot, null).paused, false);
});

test('stale marker kept with last good snapshot', async () => {
  const snapshot = fixture();
  const store = createBoardStore(snapshot);
  const stale = {
    ...snapshot,
    stale: { db: 'database busy', herdr: 'herdr failed' },
    herdr: { ...snapshot.herdr, ok: false },
  };
  store.setSnapshot(stale);
  assert.equal(store.getSnapshot().snapshot?.cards, snapshot.cards);
  assert.equal(store.getSnapshot().snapshot?.stale.db, 'database busy');
  const output = await screen(React.createElement(AppBoard, { store, onRefresh() {}, onQuit() {} }));
  assert.match(output, /STALE DB · last good snapshot retained: database busy/);
  assert.match(output, /herdr unavailable \(last ok 12:00:00\)/);
  assert.match(output, /FAC-1/);
});

test('runsAvailable false hides cost with migration hint', async () => {
  const snapshot = { ...fixture(), runsAvailable: false, cost: null };
  const store = createBoardStore(snapshot);
  store.view('cost');
  assert.deepEqual(boardSelections(store.getSnapshot()), []);
  const output = await screen(
    React.createElement(CostView, { snapshot, project: null, selectedIndex: 0, capacity: 20 }),
  );
  assert.match(output, /needs migration NNNN_worker_runs/);
  assert.doesNotMatch(output, /≈\$/);
});

test('hygiene header counts unknown observations without inventing leaks', () => {
  const snapshot = fixture();
  assert.deepEqual(hygieneCounts(snapshot.hygiene), { closeNow: 1, leak: 1, ghost: 1, unknown: 0 });
  const unknown = snapshot.hygiene.map((row) => ({ ...row, classification: '?' as const }));
  assert.deepEqual(hygieneCounts(unknown), { closeNow: 0, leak: 0, ghost: 0, unknown: 3 });
});

test('external store preserves identity, selection, and detail through refresh; unsubscribe stops notifications', () => {
  const snapshot = fixture();
  const store = createBoardStore(snapshot);
  assert.equal(store.getSnapshot(), store.getSnapshot());
  let updates = 0;
  const unsubscribe = store.subscribe(() => updates++);
  store.select(1);
  store.dispatch({ type: 'detail' });
  assert.equal(store.getSnapshot().detailCardId, 'FAC-2');
  store.setSnapshot({ ...snapshot, cards: [...snapshot.cards].reverse() });
  assert.equal(boardSelections(store.getSnapshot())[store.getSnapshot().selectedIndex].cardId, 'FAC-2');
  assert.equal(store.getSnapshot().detailCardId, 'FAC-2');
  store.dispatch({ type: 'back' });
  store.dispatch({ type: 'cycle-project' });
  assert.equal(store.getSnapshot().project, 'alpha');
  assert.equal(boardHeader(snapshot, 'alpha').wip, 5);
  store.setSnapshot({ ...snapshot, cards: [] });
  assert.equal(store.getSnapshot().project, null);
  assert.equal(store.getSnapshot().selectedIndex, 0);
  const before = updates;
  unsubscribe();
  store.setStatus('ledger not found');
  assert.equal(updates, before);
});

test('fixture view snapshots expose handoff groups, unknown costs, and suggested hygiene commands', async () => {
  const snapshot = fixture();
  const props = { snapshot, project: null, selectedIndex: 0, capacity: 25 };
  const lanes = await screen(React.createElement(LaneBoard, { ...props, width: 118 }));
  assert.match(lanes, /alpha\/sol L3/);
  assert.match(lanes, /1\/2h/);
  const narrow = await screen(React.createElement(LaneBoard, { ...props, width: 58 }), 60);
  assert.match(narrow, /발행/);
  assert.match(narrow, /머지대기/);
  const review = await screen(React.createElement(ReviewQueue, props));
  assert.match(review, /Handoff incomplete 1/);
  assert.match(review, /Eligible 3/);
  assert.ok(review.indexOf('Incomplete fixture') < review.indexOf('Eligible fixture'));
  assert.deepEqual(
    reviewRows(snapshot, 'alpha').map((row) => row.cardId),
    ['FAC-2', 'FAC-4', 'FAC-5', 'FAC-6'],
  );
  const cost = await screen(React.createElement(CostView, props));
  assert.match(cost, /≈\$4\.25 list-equiv/);
  assert.match(cost, /no quota samples/);
  assert.match(cost, /unknown 1/);
  assert.match(cost, /reviewer and manager sessions excluded/);
  assert.equal(costLanes(snapshot, 'alpha')[0].runs, 2);
  const hygiene = await screen(React.createElement(HygieneView, props));
  assert.match(hygiene, /herdr pane close w1:p3/);
  assert.match(hygiene, /Shells \(global\): 2/);
});

test('card detail includes report/review/vision/run close evidence and blockers', async () => {
  const snapshot = fixture();
  const row = card('FAC-9', {
    nextBlockers: ['D04 vision', 'D05 owner OK'],
    timeline: [{ fromState: 'working', toState: 'reported', byAgent: 'worker', note: 'handoff', at: snapshot.readAt }],
    reports: [
      {
        id: 1,
        attempt: 1,
        byAgent: 'worker',
        sha: 'c'.repeat(40),
        branch: 'fac/test',
        prUrl: 'https://example.test/pr/9',
        filesJson: '["a.ts"]',
        evidenceJson: '{"checks":"passed"}',
        risks: 'fixture risk',
        status: 'DONE',
        bodyMd: 'CLOSED: yes',
        at: snapshot.readAt,
      },
    ],
    reviews: [
      {
        id: 1,
        attempt: 1,
        sha: 'c'.repeat(40),
        reviewer: 'independent',
        layer: 'L2',
        verdict: 'accept',
        itemsJson: '[]',
        at: snapshot.readAt,
      },
    ],
    visionAudits: [
      {
        id: 1,
        attempt: 1,
        sha: 'c'.repeat(40),
        auditor: 'visual',
        verdict: 'pass',
        screenshotsJson: '["screenshot.png"]',
        itemsJson: '[]',
        notes: 'clear',
        at: snapshot.readAt,
      },
    ],
    links: [{ kind: 'pr', ref: 'https://example.test/pr/9', detailJson: '{}', at: snapshot.readAt }],
    runs: [
      {
        runId: 'r9',
        cardId: 'FAC-9',
        attempt: 1,
        agentId: 'worker',
        harness: 'herdr',
        kind: 'omp',
        model: 'fixture-model',
        worktree: '/fixture/worktree',
        branch: 'fac/test',
        packetDir: '/fixture/packet',
        status: 'closed',
        since: snapshot.readAt,
        workspaceId: 'w1',
        tabId: 't1',
        paneId: 'w1:p9',
        terminalId: 'term9',
        pid: null,
        sessionRef: '/fixture/session.jsonl',
        reportPresent: true,
        events: [
          { status: 'closed', byAgent: 'manager', detailJson: '{"evidence":"pane_not_found"}', at: snapshot.readAt },
        ],
      },
    ],
  });
  const lines = cardDetailLines(row, true, snapshot.readAt).join('\n');
  for (const expected of [
    'D04 vision',
    'D05 owner OK',
    'working → reported',
    'fixture risk',
    'CLOSED: yes',
    'independent',
    'screenshot.png',
    'herdr/omp',
    'term9',
    'report.json present',
    'pane_not_found',
  ]) {
    assert.ok(lines.includes(expected), expected);
  }
  const output = await screen(
    React.createElement(CardDetail, {
      card: row,
      runsAvailable: true,
      readAt: snapshot.readAt,
      width: 118,
      capacity: 100,
      offset: 0,
    }),
  );
  assert.match(output, /pane_not_found/);
  assert.match(output, /Next blockers/);
});

test('Ink input opens and exits detail, filters project, and invokes only refresh/quit callbacks', async () => {
  const store = createBoardStore(fixture());
  let refreshes = 0;
  let quits = 0;
  const output = await screen(
    React.createElement(AppBoard, {
      store,
      onRefresh() {
        refreshes++;
      },
      onQuit() {
        quits++;
      },
    }),
    120,
    ['2', '\r', '\x1b', 'p', 'r', 'q'],
  );
  assert.match(output, /Card detail · Esc back/);
  assert.equal(store.getSnapshot().view, 'review');
  assert.equal(store.getSnapshot().detailCardId, null);
  assert.equal(store.getSnapshot().project, 'alpha');
  assert.equal(refreshes, 1);
  assert.equal(quits, 1);
});
