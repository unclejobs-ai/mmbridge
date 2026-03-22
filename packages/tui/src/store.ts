import type { GateResult, ResumeResult } from '@mmbridge/core';
import type { Session } from '@mmbridge/session-store';
import React from 'react';
import type { GroupedFindings } from './hooks/session-analytics.js';

// ─── State shape ──────────────────────────────────────────────────────────────

export type TabId = 'dashboard' | 'sessions' | 'config';

export const TAB_ORDER: TabId[] = ['dashboard', 'sessions', 'config'];

export const REVIEW_MODES = ['review', 'security', 'architecture'] as const;
export type ReviewMode = (typeof REVIEW_MODES)[number];

export interface FindingItem {
  severity: string;
  file: string;
  line: number | null;
  message: string;
  key: string;
  status?: 'accepted' | 'dismissed';
}

export interface AdapterStatus {
  name: string;
  binary: string;
  installed: boolean;
}

export interface ProjectInfo {
  path: string;
  branch: string;
  head: string;
  dirtyCount: number;
  baseRef: string;
  lastCommitMessage?: string;
}

export interface LastReview {
  tool: string;
  mode: string;
  date: string;
  findingCounts: { critical: number; warning: number; info: number; refactor: number };
  summary: string;
}

export interface LatestHandoffPreview {
  sessionId: string;
  summary: string;
  nextCommand: string;
  createdAt: string;
  path: string;
}

export interface MemoryPreviewItem {
  id: string;
  type: string;
  title: string;
  createdAt: string;
}

export interface GatePreview {
  status: 'pass' | 'warn';
  warnings: string[];
  nextCommand: string | null;
}

export interface ResumePreview {
  action: 'followup' | 'rerun' | 'bridge-rerun' | null;
  reason: string | null;
  summary: string;
}

export interface OperationsState {
  gateResult: GateResult | null;
  resumeResult: ResumeResult | null;
}

export interface SessionDetailData {
  sessionId: string;
  contextIndex: import('@mmbridge/core').ContextIndex | null;
  resultIndex: import('@mmbridge/core').ResultIndex | null;
  groupedFindings: GroupedFindings[];
  ancestryChain: string[];
}

export interface TuiState {
  activeTab: TabId;
  focusZone: 'sidebar' | 'main';
  sidebar: { selectedIndex: number };

  // Real data (loaded async)
  adapters: AdapterStatus[];
  adaptersLoading: boolean;
  projectInfo: ProjectInfo | null;
  latestHandoff: LatestHandoffPreview | null;
  memoryPreview: MemoryPreviewItem[];
  operations: OperationsState;
  sessions: Session[];
  sessionsLoading: boolean;

  review: {
    selectedTool: number;
    selectedMode: number;
    focusColumn: 'tool' | 'mode';
  };
  config: { selectedSection: 'adapters' | 'settings'; selectedIndex: number };
  inputMode: 'none' | 'followup' | 'export' | 'config' | 'session-filter';
  inputTarget: { tool: string; sessionId: string; parentSessionId?: string; promptDraft?: string } | null;
  sessionsUi: {
    selectedIndex: number;
    findingIndex: number;
    query: string;
    toolFilter: string;
    severityFilter: string;
    modeFilter: string;
  };
  toast: { message: string; type: 'success' | 'error' | 'info'; at: number } | null;
  helpVisible: boolean;
  sessionDetail: SessionDetailData | null;
}

// ─── Actions ──────────────────────────────────────────────────────────────────

export type TuiAction =
  | { type: 'SWITCH_TAB'; tab: TabId }
  | { type: 'SWITCH_TAB_DELTA'; delta: number }
  | { type: 'SET_FOCUS'; zone: TuiState['focusZone'] }
  | { type: 'SIDEBAR_MOVE'; delta: number }
  | { type: 'SET_ADAPTERS'; adapters: AdapterStatus[] }
  | { type: 'SET_ADAPTERS_LOADING'; loading: boolean }
  | { type: 'SET_PROJECT_INFO'; info: ProjectInfo | null }
  | { type: 'SET_LATEST_HANDOFF'; handoff: LatestHandoffPreview | null }
  | { type: 'SET_MEMORY_PREVIEW'; items: MemoryPreviewItem[] }
  | { type: 'SET_OPERATIONS'; operations: OperationsState }
  | { type: 'SET_SESSIONS'; sessions: Session[] }
  | { type: 'SET_SESSIONS_LOADING'; loading: boolean }
  | { type: 'REVIEW_SET_TOOL'; index: number }
  | { type: 'REVIEW_SET_MODE'; index: number }
  | { type: 'REVIEW_SET_FOCUS_COLUMN'; column: 'tool' | 'mode' }
  | { type: 'CONFIG_SET_SECTION'; section: 'adapters' | 'settings' }
  | { type: 'CONFIG_SELECT'; index: number }
  | { type: 'SESSIONS_SELECT'; index: number }
  | { type: 'SESSIONS_SELECT_FINDING'; index: number }
  | { type: 'SESSIONS_SET_QUERY'; query: string }
  | { type: 'SESSIONS_CYCLE_TOOL'; tools: string[] }
  | { type: 'SESSIONS_CYCLE_SEVERITY'; severities: string[] }
  | { type: 'SESSIONS_CYCLE_MODE'; modes: string[] }
  | { type: 'SESSIONS_CLEAR_FILTERS' }
  | { type: 'SHOW_TOAST'; message: string; toastType: 'success' | 'error' | 'info' }
  | { type: 'CLEAR_TOAST' }
  | { type: 'TOGGLE_HELP' }
  | { type: 'SET_SESSION_DETAIL'; detail: SessionDetailData | null }
  | { type: 'CLEAR_SESSION_DETAIL' }
  | { type: 'START_FOLLOWUP'; tool: string; sessionId: string; parentSessionId?: string; promptDraft?: string }
  | { type: 'START_SESSION_FILTER' }
  | { type: 'START_CONFIG_EDIT' }
  | { type: 'START_EXPORT' }
  | { type: 'CANCEL_INPUT' }
  | { type: 'COMPLETE_INPUT' };

// ─── Initial state ────────────────────────────────────────────────────────────

export const initialState: TuiState = {
  activeTab: 'dashboard',
  focusZone: 'sidebar',
  sidebar: { selectedIndex: 0 },

  adapters: [],
  adaptersLoading: true,
  projectInfo: null,
  latestHandoff: null,
  memoryPreview: [],
  operations: {
    gateResult: null,
    resumeResult: null,
  },
  sessions: [],
  sessionsLoading: true,

  review: {
    selectedTool: 0,
    selectedMode: 0,
    focusColumn: 'tool',
  },
  config: { selectedSection: 'adapters', selectedIndex: 0 },
  sessionsUi: {
    selectedIndex: 0,
    findingIndex: 0,
    query: '',
    toolFilter: 'all',
    severityFilter: 'all',
    modeFilter: 'all',
  },
  toast: null,
  helpVisible: false,
  sessionDetail: null,
  inputMode: 'none',
  inputTarget: null,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

// ─── Reducer ──────────────────────────────────────────────────────────────────

export function tuiReducer(state: TuiState, action: TuiAction): TuiState {
  switch (action.type) {
    case 'SWITCH_TAB':
      return { ...state, activeTab: action.tab, sidebar: { selectedIndex: 0 } };

    case 'SWITCH_TAB_DELTA': {
      const idx = TAB_ORDER.indexOf(state.activeTab);
      const next = clamp(idx + action.delta, 0, TAB_ORDER.length - 1);
      const tab = TAB_ORDER[next] ?? state.activeTab;
      return { ...state, activeTab: tab, sidebar: { selectedIndex: 0 } };
    }

    case 'SET_FOCUS':
      return { ...state, focusZone: action.zone };

    case 'SIDEBAR_MOVE': {
      const next = state.sidebar.selectedIndex + action.delta;
      return {
        ...state,
        sidebar: { selectedIndex: Math.max(0, next) },
      };
    }

    case 'SET_ADAPTERS':
      return { ...state, adapters: action.adapters, adaptersLoading: false };

    case 'SET_ADAPTERS_LOADING':
      return { ...state, adaptersLoading: action.loading };

    case 'SET_PROJECT_INFO':
      return { ...state, projectInfo: action.info };

    case 'SET_LATEST_HANDOFF':
      return { ...state, latestHandoff: action.handoff };

    case 'SET_MEMORY_PREVIEW':
      return { ...state, memoryPreview: action.items };

    case 'SET_OPERATIONS':
      return { ...state, operations: action.operations };

    case 'SET_SESSIONS':
      return { ...state, sessions: action.sessions, sessionsLoading: false };

    case 'SET_SESSIONS_LOADING':
      return { ...state, sessionsLoading: action.loading };

    case 'REVIEW_SET_TOOL':
      return { ...state, review: { ...state.review, selectedTool: action.index } };

    case 'REVIEW_SET_MODE':
      return { ...state, review: { ...state.review, selectedMode: action.index } };

    case 'REVIEW_SET_FOCUS_COLUMN':
      return { ...state, review: { ...state.review, focusColumn: action.column } };

    case 'CONFIG_SET_SECTION':
      return {
        ...state,
        config: { selectedSection: action.section, selectedIndex: 0 },
      };

    case 'CONFIG_SELECT':
      return {
        ...state,
        config: { ...state.config, selectedIndex: action.index },
      };

    case 'SESSIONS_SELECT':
      return {
        ...state,
        sessionsUi: { ...state.sessionsUi, selectedIndex: action.index, findingIndex: 0 },
      };

    case 'SESSIONS_SELECT_FINDING':
      return {
        ...state,
        sessionsUi: { ...state.sessionsUi, findingIndex: action.index },
      };

    case 'SESSIONS_SET_QUERY':
      return {
        ...state,
        sessionsUi: { ...state.sessionsUi, selectedIndex: 0, findingIndex: 0, query: action.query },
      };

    case 'SESSIONS_CYCLE_TOOL': {
      const currentIndex = action.tools.indexOf(state.sessionsUi.toolFilter);
      const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % action.tools.length : 0;
      return {
        ...state,
        sessionsUi: {
          ...state.sessionsUi,
          selectedIndex: 0,
          findingIndex: 0,
          toolFilter: action.tools[nextIndex] ?? 'all',
        },
      };
    }

    case 'SESSIONS_CYCLE_SEVERITY': {
      const currentIndex = action.severities.indexOf(state.sessionsUi.severityFilter);
      const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % action.severities.length : 0;
      return {
        ...state,
        sessionsUi: {
          ...state.sessionsUi,
          selectedIndex: 0,
          findingIndex: 0,
          severityFilter: action.severities[nextIndex] ?? 'all',
        },
      };
    }

    case 'SESSIONS_CYCLE_MODE': {
      const currentIndex = action.modes.indexOf(state.sessionsUi.modeFilter);
      const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % action.modes.length : 0;
      return {
        ...state,
        sessionsUi: {
          ...state.sessionsUi,
          selectedIndex: 0,
          findingIndex: 0,
          modeFilter: action.modes[nextIndex] ?? 'all',
        },
      };
    }

    case 'SESSIONS_CLEAR_FILTERS':
      return {
        ...state,
        sessionsUi: {
          ...state.sessionsUi,
          selectedIndex: 0,
          findingIndex: 0,
          query: '',
          toolFilter: 'all',
          severityFilter: 'all',
          modeFilter: 'all',
        },
      };

    case 'SHOW_TOAST':
      return {
        ...state,
        toast: { message: action.message, type: action.toastType, at: Date.now() },
      };

    case 'CLEAR_TOAST':
      return { ...state, toast: null };

    case 'TOGGLE_HELP':
      return { ...state, helpVisible: !state.helpVisible };

    case 'SET_SESSION_DETAIL':
      return { ...state, sessionDetail: action.detail };

    case 'CLEAR_SESSION_DETAIL':
      return { ...state, sessionDetail: null };

    case 'START_FOLLOWUP':
      return {
        ...state,
        inputMode: 'followup',
        inputTarget: {
          tool: action.tool,
          sessionId: action.sessionId,
          parentSessionId: action.parentSessionId,
          promptDraft: action.promptDraft,
        },
      };

    case 'START_SESSION_FILTER':
      return { ...state, inputMode: 'session-filter', inputTarget: null };

    case 'START_CONFIG_EDIT':
      return { ...state, inputMode: 'config', inputTarget: null };

    case 'START_EXPORT':
      return { ...state, inputMode: 'export', inputTarget: null };

    case 'CANCEL_INPUT':
      return { ...state, inputMode: 'none', inputTarget: null };

    case 'COMPLETE_INPUT':
      return { ...state, inputMode: 'none', inputTarget: null };

    default:
      return state;
  }
}

// ─── Context ──────────────────────────────────────────────────────────────────

type TuiContextValue = [TuiState, React.Dispatch<TuiAction>];

export const TuiContext = React.createContext<TuiContextValue>([
  initialState,
  () => {
    /* noop */
  },
]);

export function useTui(): TuiContextValue {
  return React.useContext(TuiContext);
}
