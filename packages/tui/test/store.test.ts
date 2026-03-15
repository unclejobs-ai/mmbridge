import test from 'node:test';
import assert from 'node:assert/strict';
import { tuiReducer, initialState } from '../dist/store.js';
import type { TuiState, TuiAction } from '../dist/store.js';

function dispatch(state: TuiState, action: TuiAction): TuiState {
  return tuiReducer(state, action);
}

// ─── SWITCH_TAB ──────────────────────────────────────────────────────────────

test('SWITCH_TAB: changes active tab', () => {
  const next = dispatch(initialState, { type: 'SWITCH_TAB', tab: 'review' });
  assert.equal(next.activeTab, 'review');
});

test('SWITCH_TAB: resets sidebar selection', () => {
  const withSidebar = { ...initialState, sidebar: { selectedIndex: 5 } };
  const next = dispatch(withSidebar, { type: 'SWITCH_TAB', tab: 'sessions' });
  assert.equal(next.sidebar.selectedIndex, 0);
});

// ─── SWITCH_TAB_DELTA ────────────────────────────────────────────────────────

test('SWITCH_TAB_DELTA: moves forward', () => {
  const next = dispatch(initialState, { type: 'SWITCH_TAB_DELTA', delta: 1 });
  assert.equal(next.activeTab, 'review');
});

test('SWITCH_TAB_DELTA: clamps at end', () => {
  const atConfig = dispatch(initialState, { type: 'SWITCH_TAB', tab: 'config' });
  const next = dispatch(atConfig, { type: 'SWITCH_TAB_DELTA', delta: 1 });
  assert.equal(next.activeTab, 'config');
});

test('SWITCH_TAB_DELTA: clamps at beginning', () => {
  const next = dispatch(initialState, { type: 'SWITCH_TAB_DELTA', delta: -1 });
  assert.equal(next.activeTab, 'status');
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
  const adapters = [{ name: 'kimi', binary: 'kimi', installed: true, sessionCount: 5, lastSessionDate: null }];
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

test('REVIEW_START: sets running and switches to progress phase', () => {
  const next = dispatch(initialState, { type: 'REVIEW_START' });
  assert.equal(next.review.running, true);
  assert.equal(next.review.progress, '');
  assert.equal(next.review.progressPhase, 'context');
  assert.equal(next.review.elapsed, 0);
  assert.equal(next.review.result, null);
  assert.equal(next.reviewPhase, 'progress');
});

test('REVIEW_PROGRESS: updates progress and elapsed', () => {
  const started = dispatch(initialState, { type: 'REVIEW_START' });
  const next = dispatch(started, {
    type: 'REVIEW_PROGRESS',
    progress: 'Analyzing files...',
    elapsed: 5.3,
    phase: 'review',
  });
  assert.equal(next.review.progress, 'Analyzing files...');
  assert.equal(next.review.elapsed, 5.3);
  assert.equal(next.review.progressPhase, 'review');
});

test('REVIEW_PROGRESS: preserves existing phase when none specified', () => {
  const started = dispatch(initialState, { type: 'REVIEW_START' });
  const withPhase = dispatch(started, {
    type: 'REVIEW_PROGRESS',
    progress: 'Redacting...',
    elapsed: 2,
    phase: 'redact',
  });
  const next = dispatch(withPhase, {
    type: 'REVIEW_PROGRESS',
    progress: 'Still redacting...',
    elapsed: 3,
  });
  assert.equal(next.review.progressPhase, 'redact');
});

test('REVIEW_COMPLETE: with result transitions to results phase', () => {
  const started = dispatch(initialState, { type: 'REVIEW_START' });
  const result = { summary: 'Done', findings: [] };
  const next = dispatch(started, { type: 'REVIEW_COMPLETE', result });
  assert.equal(next.review.running, false);
  assert.deepEqual(next.review.result, result);
  assert.equal(next.reviewPhase, 'results');
});

test('REVIEW_COMPLETE: with null result transitions to setup phase', () => {
  const started = dispatch(initialState, { type: 'REVIEW_START' });
  const next = dispatch(started, { type: 'REVIEW_COMPLETE', result: null });
  assert.equal(next.review.running, false);
  assert.equal(next.review.result, null);
  assert.equal(next.reviewPhase, 'setup');
});

// ─── REVIEW_TOGGLE_BRIDGE ────────────────────────────────────────────────────

test('REVIEW_TOGGLE_BRIDGE: toggles bridge mode', () => {
  assert.equal(initialState.review.bridgeMode, false);
  const next = dispatch(initialState, { type: 'REVIEW_TOGGLE_BRIDGE' });
  assert.equal(next.review.bridgeMode, true);
  const back = dispatch(next, { type: 'REVIEW_TOGGLE_BRIDGE' });
  assert.equal(back.review.bridgeMode, false);
});

// ─── REVIEW_BRIDGE_TOOL_PROGRESS ─────────────────────────────────────────────

test('REVIEW_BRIDGE_TOOL_PROGRESS: tracks per-tool status', () => {
  let state = dispatch(initialState, { type: 'REVIEW_BRIDGE_TOOL_PROGRESS', tool: 'kimi', status: 'running' });
  assert.equal(state.review.bridgeToolProgress['kimi'], 'running');
  state = dispatch(state, { type: 'REVIEW_BRIDGE_TOOL_PROGRESS', tool: 'kimi', status: 'done' });
  assert.equal(state.review.bridgeToolProgress['kimi'], 'done');
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
});

// ─── Toast ───────────────────────────────────────────────────────────────────

test('SHOW_TOAST: sets toast with timestamp', () => {
  const before = Date.now();
  const next = dispatch(initialState, { type: 'SHOW_TOAST', message: 'Saved!', toastType: 'success' });
  assert.equal(next.toast?.message, 'Saved!');
  assert.equal(next.toast?.type, 'success');
  assert.ok(next.toast!.at >= before);
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
  const next = dispatch(initialState, { type: 'START_FOLLOWUP', tool: 'kimi', sessionId: 'sess-123' });
  assert.equal(next.inputMode, 'followup');
  assert.deepEqual(next.inputTarget, { tool: 'kimi', sessionId: 'sess-123' });
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

// ─── SET_REVIEW_PHASE ────────────────────────────────────────────────────────

test('SET_REVIEW_PHASE: updates review phase', () => {
  const next = dispatch(initialState, { type: 'SET_REVIEW_PHASE', phase: 'progress' });
  assert.equal(next.reviewPhase, 'progress');
});

// ─── Unknown action returns unchanged state ──────────────────────────────────

test('unknown action: returns same state', () => {
  const next = dispatch(initialState, { type: 'UNKNOWN_ACTION' } as unknown as TuiAction);
  assert.equal(next, initialState);
});
