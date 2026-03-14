import React from 'react';

// ─── State shape ──────────────────────────────────────────────────────────────

export interface FindingItem {
  severity: string;
  file: string;
  line: number | null;
  message: string;
}

export interface TuiState {
  activeTab: 'review' | 'config' | 'sessions' | 'diff';
  focusZone: 'sidebar' | 'main';
  sidebar: { selectedIndex: number };
  review: {
    selectedTool: string;
    mode: string;
    running: boolean;
    progress: string;
    result: null | { summary: string; findings: FindingItem[] };
  };
  config: { selectedAdapter: string };
  sessions: {
    filter: { tool: string; mode: string };
    selectedIndex: number;
  };
  diff: { sessionId: string | null };
  toast: { message: string; type: 'success' | 'error' | 'info'; at: number } | null;
  helpVisible: boolean;
}

// ─── Actions ──────────────────────────────────────────────────────────────────

export type TuiAction =
  | { type: 'SWITCH_TAB'; tab: TuiState['activeTab'] }
  | { type: 'SET_FOCUS'; zone: TuiState['focusZone'] }
  | { type: 'SIDEBAR_MOVE'; delta: number }
  | { type: 'REVIEW_SET_TOOL'; tool: string }
  | { type: 'REVIEW_SET_MODE'; mode: string }
  | { type: 'REVIEW_START' }
  | { type: 'REVIEW_PROGRESS'; progress: string }
  | { type: 'REVIEW_COMPLETE'; result: TuiState['review']['result'] }
  | { type: 'CONFIG_SELECT'; adapter: string }
  | { type: 'SESSIONS_FILTER'; filter: Partial<TuiState['sessions']['filter']> }
  | { type: 'SESSIONS_SELECT'; index: number }
  | { type: 'DIFF_SET_SESSION'; sessionId: string | null }
  | { type: 'SHOW_TOAST'; message: string; toastType: 'success' | 'error' | 'info' }
  | { type: 'CLEAR_TOAST' }
  | { type: 'TOGGLE_HELP' };

// ─── Initial state ────────────────────────────────────────────────────────────

export const initialState: TuiState = {
  activeTab: 'review',
  focusZone: 'sidebar',
  sidebar: { selectedIndex: 0 },
  review: {
    selectedTool: 'kimi',
    mode: 'review',
    running: false,
    progress: '',
    result: null,
  },
  config: { selectedAdapter: 'kimi' },
  sessions: {
    filter: { tool: 'all', mode: 'all' },
    selectedIndex: 0,
  },
  diff: { sessionId: null },
  toast: null,
  helpVisible: false,
};

// ─── Reducer ──────────────────────────────────────────────────────────────────

export function tuiReducer(state: TuiState, action: TuiAction): TuiState {
  switch (action.type) {
    case 'SWITCH_TAB':
      return { ...state, activeTab: action.tab };

    case 'SET_FOCUS':
      return { ...state, focusZone: action.zone };

    case 'SIDEBAR_MOVE': {
      const next = state.sidebar.selectedIndex + action.delta;
      return {
        ...state,
        sidebar: { selectedIndex: Math.max(0, next) },
      };
    }

    case 'REVIEW_SET_TOOL':
      return { ...state, review: { ...state.review, selectedTool: action.tool } };

    case 'REVIEW_SET_MODE':
      return { ...state, review: { ...state.review, mode: action.mode } };

    case 'REVIEW_START':
      return {
        ...state,
        review: { ...state.review, running: true, progress: '', result: null },
      };

    case 'REVIEW_PROGRESS':
      return { ...state, review: { ...state.review, progress: action.progress } };

    case 'REVIEW_COMPLETE':
      return {
        ...state,
        review: { ...state.review, running: false, result: action.result },
      };

    case 'CONFIG_SELECT':
      return { ...state, config: { selectedAdapter: action.adapter } };

    case 'SESSIONS_FILTER':
      return {
        ...state,
        sessions: {
          ...state.sessions,
          filter: { ...state.sessions.filter, ...action.filter },
        },
      };

    case 'SESSIONS_SELECT':
      return {
        ...state,
        sessions: { ...state.sessions, selectedIndex: action.index },
      };

    case 'DIFF_SET_SESSION':
      return { ...state, diff: { sessionId: action.sessionId } };

    case 'SHOW_TOAST':
      return {
        ...state,
        toast: { message: action.message, type: action.toastType, at: Date.now() },
      };

    case 'CLEAR_TOAST':
      return { ...state, toast: null };

    case 'TOGGLE_HELP':
      return { ...state, helpVisible: !state.helpVisible };

    default:
      return state;
  }
}

// ─── Context ──────────────────────────────────────────────────────────────────

type TuiContextValue = [TuiState, React.Dispatch<TuiAction>];

export const TuiContext = React.createContext<TuiContextValue>([
  initialState,
  () => { /* noop */ },
]);

export function useTui(): TuiContextValue {
  return React.useContext(TuiContext);
}
