import { Box, useApp, useInput } from 'ink';
import type React from 'react';
import { useReducer } from 'react';
import { Header } from './components/Header.js';
import { HelpOverlay } from './components/HelpOverlay.js';
import { StatusBar } from './components/StatusBar.js';
import { useLoadData } from './hooks/use-data.js';
import { TuiContext, initialState, tuiReducer } from './store.js';
import type { TabId } from './store.js';
import { ConfigView } from './views/ConfigView.js';
import { DashboardView } from './views/DashboardView.js';
import { SessionsView } from './views/SessionsView.js';

const KEY_TO_TAB: Record<string, TabId> = {
  '1': 'dashboard',
  d: 'dashboard',
  '2': 'sessions',
  s: 'sessions',
  '3': 'config',
  c: 'config',
};

interface AppProps {
  initialTab?: TabId;
  version?: string;
}

export function App({ initialTab, version }: AppProps): React.ReactElement {
  const [state, dispatch] = useReducer(tuiReducer, {
    ...initialState,
    ...(initialTab ? { activeTab: initialTab } : {}),
  });
  const { exit } = useApp();
  const { refresh } = useLoadData(dispatch);

  useInput((input, key) => {
    if (state.helpVisible) {
      if (input === '?' || key.escape) dispatch({ type: 'TOGGLE_HELP' });
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
