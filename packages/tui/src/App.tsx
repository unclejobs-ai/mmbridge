import { Box, useApp, useInput } from 'ink';
import type React from 'react';
import { useCallback, useReducer } from 'react';
import { Header } from './components/Header.js';
import { HelpOverlay } from './components/HelpOverlay.js';
import { StatusBar } from './components/StatusBar.js';
import { useLoadData } from './hooks/use-data.js';
import { TuiContext, initialState, tuiReducer } from './store.js';
import type { TabId } from './store.js';
import { ConfigView } from './views/ConfigView.js';
import { DashboardView } from './views/DashboardView.js';
import { ReplView } from './views/ReplView.js';
import { SessionsView } from './views/SessionsView.js';

const KEY_TO_TAB: Record<string, TabId> = {
  '1': 'repl',
  '2': 'dashboard',
  d: 'dashboard',
  '3': 'sessions',
  s: 'sessions',
  '4': 'config',
  c: 'config',
};

export type ReplCommandResult =
  | { type: 'success'; message: string }
  | {
      type: 'findings';
      tool: string;
      findings: Array<{ severity: string; file: string; line: number | null; message: string }>;
      duration: number;
    }
  | { type: 'text'; content: string }
  | { type: 'error'; message: string }
  | { type: 'status'; data: Record<string, string> };

interface AppProps {
  initialTab?: TabId;
  version?: string;
  onReplCommand?: (command: string) => Promise<ReplCommandResult>;
}

export function App({ initialTab, version, onReplCommand }: AppProps): React.ReactElement {
  const [state, dispatch] = useReducer(tuiReducer, {
    ...initialState,
    activeTab: initialTab ?? 'repl',
  });
  const { exit } = useApp();
  const { refresh } = useLoadData(dispatch);

  const handleReplCommand = useCallback(
    async (command: string) => {
      if (onReplCommand) {
        return await onReplCommand(command);
      }
      return { type: 'error' as const, message: 'No command handler configured' };
    },
    [onReplCommand],
  );

  useInput((input, key) => {
    if (state.helpVisible) {
      if (input === '?' || key.escape) dispatch({ type: 'TOGGLE_HELP' });
      return;
    }

    // REPL tab: only allow ESC to switch away (number keys conflict with typing)
    if (state.activeTab === 'repl') {
      if (key.escape) {
        dispatch({ type: 'SWITCH_TAB', tab: 'dashboard' });
      }
      return;
    }

    if (state.inputMode !== 'none') {
      return;
    }

    // Tab switching: number keys + letter shortcuts (d/s/c for xterm compat)
    const tabTarget = KEY_TO_TAB[input];
    if (tabTarget) {
      dispatch({ type: 'SWITCH_TAB', tab: tabTarget });
      return;
    }

    // Tab switching: arrow keys
    if (key.leftArrow) {
      dispatch({ type: 'SWITCH_TAB_DELTA', delta: -1 });
      return;
    }
    if (key.rightArrow) {
      dispatch({ type: 'SWITCH_TAB_DELTA', delta: 1 });
      return;
    }

    // Tab key: focus toggle in config, tab cycle elsewhere
    if (key.tab && state.activeTab === 'config') {
      dispatch({ type: 'SET_FOCUS', zone: state.focusZone === 'sidebar' ? 'main' : 'sidebar' });
      return;
    }
    if (key.tab) {
      dispatch({ type: 'SWITCH_TAB_DELTA', delta: key.shift ? -1 : 1 });
      return;
    }

    // Help & quit
    if (input === '?') dispatch({ type: 'TOGGLE_HELP' });
    if (input === 'q') exit();

    // Refresh on dashboard tab
    if (state.activeTab === 'dashboard' && input === 'r') {
      refresh();
      dispatch({ type: 'SHOW_TOAST', message: 'Refreshing...', toastType: 'info' });
    }
  });

  const branch = state.projectInfo?.branch;
  const dirtyCount = state.projectInfo?.dirtyCount;

  return (
    <TuiContext.Provider value={[state, dispatch]}>
      <Box flexDirection="column" width="100%" height="100%">
        <Header activeTab={state.activeTab} branch={branch} dirtyCount={dirtyCount} version={version} />
        <Box flexGrow={1}>
          {state.activeTab === 'repl' && <ReplView version={version} onCommand={handleReplCommand} />}
          {state.activeTab === 'dashboard' && <DashboardView />}
          {state.activeTab === 'sessions' && <SessionsView />}
          {state.activeTab === 'config' && <ConfigView />}
        </Box>
        <StatusBar
          toast={state.toast}
          activeTab={state.activeTab}
          onToastExpired={() => dispatch({ type: 'CLEAR_TOAST' })}
        />
        {state.helpVisible && <HelpOverlay />}
      </Box>
    </TuiContext.Provider>
  );
}
