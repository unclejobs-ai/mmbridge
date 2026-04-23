import assert from 'node:assert/strict';
import test from 'node:test';
import { initialState, tuiReducer } from '../dist/store.js';
import type { TuiAction, TuiState } from '../dist/store.js';

function dispatch(state: TuiState, action: TuiAction): TuiState {
  return tuiReducer(state, action);
}

// ─── SWITCH_TAB ──────────────────────────────────────────────────────────────

test('SWITCH_TAB: changes active tab', () => {
  const next = dispatch(initialState, { type: 'SWITCH_TAB', tab: 'sessions' });
  assert.equal(next.activeTab, 'sessions');
});

test('SWITCH_TAB: resets sidebar selection', () => {
  const withSidebar = { ...initialState, sidebar: { selectedIndex: 5 } };
  const next = dispatch(withSidebar, { type: 'SWITCH_TAB', tab: 'sessions' });
  assert.equal(next.sidebar.selectedIndex, 0);
});

// ─── SWITCH_TAB_DELTA ────────────────────────────────────────────────────────

test('SWITCH_TAB_DELTA: moves forward from dashboard', () => {
  const next = dispatch(initialState, { type: 'SWITCH_TAB_DELTA', delta: 1 });
  assert.equal(next.activeTab, 'sessions');
});

test('SWITCH_TAB_DELTA: clamps at end', () => {
  const atConfig = dispatch(initialState, { type: 'SWITCH_TAB', tab: 'config' });
  const next = dispatch(atConfig, { type: 'SWITCH_TAB_DELTA', delta: 1 });
  assert.equal(next.activeTab, 'config');
});

test('SWITCH_TAB_DELTA: moves backward from dashboard to repl', () => {
  const next = dispatch(initialState, { type: 'SWITCH_TAB_DELTA', delta: -1 });
  assert.equal(next.activeTab, 'repl');
});

// ─── SET_FOCUS ───────────────────────────────────────────────────────────────

test('SET_FOCUS: changes focus zone', () => {
  const next = dispatch(initialState, { type: 'SET_FOCUS', zone: 'main' });
  assert.equal(next.focusZone, 'main');
});

// ─── SIDEBAR_MOVE ────────────────────────────────────────────────────────────

test('SIDEBAR_MOVE: moves down', () => {
  const next = dispatch(initialState, { type: 'SIDEBAR_MOVE', delta: 1 });
  assert.equal(next.sidebar.selectedIndex, 1);
});

test('SIDEBAR_MOVE: clamps at 0', () => {
  const next = dispatch(initialState, { type: 'SIDEBAR_MOVE', delta: -1 });
  assert.equal(next.sidebar.selectedIndex, 0);
});

// ─── SET_ADAPTERS ────────────────────────────────────────────────────────────

test('SET_ADAPTERS: sets adapters and clears loading', () => {
  const adapters = [{ name: 'kimi', binary: 'kimi', installed: true }];
  const next = dispatch(initialState, { type: 'SET_ADAPTERS', adapters });
  assert.equal(next.adapters.length, 1);
  assert.equal(next.adaptersLoading, false);
});

// ─── SET_SESSIONS ────────────────────────────────────────────────────────────

test('SET_SESSIONS: sets sessions and clears loading', () => {
  const sessions = [{ id: 'abc', tool: 'kimi', mode: 'review', createdAt: '2026-01-01T00:00:00Z' }] as unknown[];
  const next = dispatch(initialState, { type: 'SET_SESSIONS', sessions: sessions as TuiState['sessions'] });
  assert.equal(next.sessions.length, 1);
  assert.equal(next.sessionsLoading, false);
});

test('SET_OPERATIONS: stores the latest raw gate and resume results', () => {
  const next = dispatch(initialState, {
    type: 'SET_OPERATIONS',
    operations: {
      gateResult: {
        status: 'warn',
        warnings: [{ code: 'stale-review', message: 'stale', nextCommand: 'mmbridge review' }],
      },
      resumeResult: {
        recommended: {
          action: 'followup',
          reason: 'Resume the latest thread',
        },
        alternatives: [],
        summary: 'Continue from the last finding',
        readOnly: false,
      },
    },
  });
  assert.equal(next.operations.gateResult?.status, 'warn');
  assert.equal(next.operations.resumeResult?.recommended?.action, 'followup');
});

// ─── REVIEW actions ──────────────────────────────────────────────────────────

test('REVIEW_SET_TOOL: updates selected tool index', () => {
  const next = dispatch(initialState, { type: 'REVIEW_SET_TOOL', index: 2 });
  assert.equal(next.review.selectedTool, 2);
});

test('REVIEW_SET_MODE: updates selected mode index', () => {
  const next = dispatch(initialState, { type: 'REVIEW_SET_MODE', index: 1 });
  assert.equal(next.review.selectedMode, 1);
});

test('REVIEW_SET_FOCUS_COLUMN: toggles focus column', () => {
  const next = dispatch(initialState, { type: 'REVIEW_SET_FOCUS_COLUMN', column: 'mode' });
  assert.equal(next.review.focusColumn, 'mode');
});

// ─── CONFIG actions ──────────────────────────────────────────────────────────

test('CONFIG_SET_SECTION: changes section and resets index', () => {
  const next = dispatch(initialState, { type: 'CONFIG_SET_SECTION', section: 'settings' });
  assert.equal(next.config.selectedSection, 'settings');
  assert.equal(next.config.selectedIndex, 0);
});

test('CONFIG_SELECT: updates selection index', () => {
  const next = dispatch(initialState, { type: 'CONFIG_SELECT', index: 3 });
  assert.equal(next.config.selectedIndex, 3);
});

// ─── SESSIONS_SELECT ─────────────────────────────────────────────────────────

test('SESSIONS_SELECT: updates sessions UI index', () => {
  const next = dispatch(initialState, { type: 'SESSIONS_SELECT', index: 5 });
  assert.equal(next.sessionsUi.selectedIndex, 5);
  assert.equal(next.sessionsUi.findingIndex, 0);
  assert.equal(next.sessionsUi.query, '');
});

test('SESSIONS_SELECT_FINDING: updates finding selection', () => {
  const next = dispatch(initialState, { type: 'SESSIONS_SELECT_FINDING', index: 2 });
  assert.equal(next.sessionsUi.findingIndex, 2);
});

test('SESSIONS_SET_QUERY: stores query and resets selection', () => {
  let withSelection = dispatch(initialState, { type: 'SESSIONS_SELECT', index: 5 });
  withSelection = dispatch(withSelection, { type: 'SESSIONS_SELECT_FINDING', index: 3 });
  const next = dispatch(withSelection, { type: 'SESSIONS_SET_QUERY', query: 'auth' });
  assert.equal(next.sessionsUi.query, 'auth');
  assert.equal(next.sessionsUi.selectedIndex, 0);
  assert.equal(next.sessionsUi.findingIndex, 0);
});

test('SESSIONS_CYCLE_TOOL: advances tool filter', () => {
  const next = dispatch(initialState, { type: 'SESSIONS_CYCLE_TOOL', tools: ['all', 'kimi', 'bridge'] });
  assert.equal(next.sessionsUi.toolFilter, 'kimi');
});

test('SESSIONS_CYCLE_SEVERITY: advances severity filter', () => {
  const next = dispatch(initialState, {
    type: 'SESSIONS_CYCLE_SEVERITY',
    severities: ['all', 'CRITICAL', 'WARNING'],
  });
  assert.equal(next.sessionsUi.severityFilter, 'CRITICAL');
});

test('SESSIONS_CYCLE_MODE: advances mode filter', () => {
  const next = dispatch(initialState, { type: 'SESSIONS_CYCLE_MODE', modes: ['all', 'review', 'followup'] });
  assert.equal(next.sessionsUi.modeFilter, 'review');
});

test('SESSIONS_CLEAR_FILTERS: resets all session filters', () => {
  let next = dispatch(initialState, { type: 'SESSIONS_SET_QUERY', query: 'auth' });
  next = dispatch(next, { type: 'SESSIONS_SELECT_FINDING', index: 2 });
  next = dispatch(next, { type: 'SESSIONS_CYCLE_TOOL', tools: ['all', 'kimi'] });
  next = dispatch(next, { type: 'SESSIONS_CYCLE_SEVERITY', severities: ['all', 'CRITICAL'] });
  next = dispatch(next, { type: 'SESSIONS_CYCLE_MODE', modes: ['all', 'review'] });
  next = dispatch(next, { type: 'SESSIONS_CLEAR_FILTERS' });
  assert.deepEqual(next.sessionsUi, {
    selectedIndex: 0,
    findingIndex: 0,
    query: '',
    toolFilter: 'all',
    severityFilter: 'all',
    modeFilter: 'all',
  });
});

// ─── Toast ───────────────────────────────────────────────────────────────────

test('SHOW_TOAST: sets toast with timestamp', () => {
  const before = Date.now();
  const next = dispatch(initialState, { type: 'SHOW_TOAST', message: 'Saved!', toastType: 'success' });
  assert.equal(next.toast?.message, 'Saved!');
  assert.equal(next.toast?.type, 'success');
  assert.ok(next.toast?.at >= before);
});

test('CLEAR_TOAST: removes toast', () => {
  const withToast = dispatch(initialState, { type: 'SHOW_TOAST', message: 'Hi', toastType: 'info' });
  const next = dispatch(withToast, { type: 'CLEAR_TOAST' });
  assert.equal(next.toast, null);
});

// ─── TOGGLE_HELP ─────────────────────────────────────────────────────────────

test('TOGGLE_HELP: toggles help visibility', () => {
  assert.equal(initialState.helpVisible, false);
  const next = dispatch(initialState, { type: 'TOGGLE_HELP' });
  assert.equal(next.helpVisible, true);
  const back = dispatch(next, { type: 'TOGGLE_HELP' });
  assert.equal(back.helpVisible, false);
});

// ─── Session detail ──────────────────────────────────────────────────────────

test('SET_SESSION_DETAIL: sets detail', () => {
  const detail = { sessionId: 'abc', contextIndex: null, resultIndex: null, groupedFindings: [], ancestryChain: [] };
  const next = dispatch(initialState, { type: 'SET_SESSION_DETAIL', detail });
  assert.equal(next.sessionDetail?.sessionId, 'abc');
});

test('CLEAR_SESSION_DETAIL: clears detail', () => {
  const detail = { sessionId: 'abc', contextIndex: null, resultIndex: null, groupedFindings: [], ancestryChain: [] };
  const withDetail = dispatch(initialState, { type: 'SET_SESSION_DETAIL', detail });
  const next = dispatch(withDetail, { type: 'CLEAR_SESSION_DETAIL' });
  assert.equal(next.sessionDetail, null);
});

// ─── Input mode ──────────────────────────────────────────────────────────────

test('START_FOLLOWUP: sets input mode and target', () => {
  const next = dispatch(initialState, {
    type: 'START_FOLLOWUP',
    tool: 'kimi',
    sessionId: 'sess-123',
    parentSessionId: 'local-1',
    promptDraft: 'check this finding',
  });
  assert.equal(next.inputMode, 'followup');
  assert.deepEqual(next.inputTarget, {
    tool: 'kimi',
    sessionId: 'sess-123',
    parentSessionId: 'local-1',
    promptDraft: 'check this finding',
  });
});

test('START_CONFIG_EDIT: enters config input mode without target', () => {
  const next = dispatch(initialState, { type: 'START_CONFIG_EDIT' });
  assert.equal(next.inputMode, 'config');
  assert.equal(next.inputTarget, null);
});

test('START_SESSION_FILTER: enters session-filter input mode without target', () => {
  const next = dispatch(initialState, { type: 'START_SESSION_FILTER' });
  assert.equal(next.inputMode, 'session-filter');
  assert.equal(next.inputTarget, null);
});

test('CANCEL_INPUT: resets input mode', () => {
  const inFollowup = dispatch(initialState, { type: 'START_FOLLOWUP', tool: 'kimi', sessionId: 'x' });
  const next = dispatch(inFollowup, { type: 'CANCEL_INPUT' });
  assert.equal(next.inputMode, 'none');
  assert.equal(next.inputTarget, null);
});

test('COMPLETE_INPUT: resets input mode', () => {
  const inFollowup = dispatch(initialState, { type: 'START_FOLLOWUP', tool: 'kimi', sessionId: 'x' });
  const next = dispatch(inFollowup, { type: 'COMPLETE_INPUT' });
  assert.equal(next.inputMode, 'none');
  assert.equal(next.inputTarget, null);
});

// ─── initialState defaults ───────────────────────────────────────────────────

test('initialState: activeTab is dashboard', () => {
  assert.equal(initialState.activeTab, 'dashboard');
});

test('initialState: TAB_ORDER has 4 tabs', async () => {
  const { TAB_ORDER } = await import('../dist/store.js');
  assert.equal(TAB_ORDER.length, 4);
  assert.deepEqual(TAB_ORDER, ['repl', 'dashboard', 'sessions', 'config']);
});

// ─── Unknown action returns unchanged state ──────────────────────────────────

test('unknown action: returns same state', () => {
  const next = dispatch(initialState, { type: 'UNKNOWN_ACTION' } as unknown as TuiAction);
  assert.equal(next, initialState);
});
