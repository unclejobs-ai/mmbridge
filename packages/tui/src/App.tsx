import React, { useReducer } from 'react';
import { Box, useInput, useApp } from 'ink';
import { tuiReducer, initialState, TuiContext } from './store.js';
import type { TabId } from './store.js';
import { Header } from './components/Header.js';
import { StatusBar } from './components/StatusBar.js';
import { HelpOverlay } from './components/HelpOverlay.js';
import { DashboardView } from './views/DashboardView.js';
import { SessionsView } from './views/SessionsView.js';
import { ConfigView } from './views/ConfigView.js';
import { useLoadData } from './hooks/use-data.js';

interface AppProps {
  initialTab?: TabId;
}

export function App({ initialTab }: AppProps): React.ReactElement {
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

    // Tab switching: number keys
    if (input === '1') dispatch({ type: 'SWITCH_TAB', tab: 'dashboard' });
    if (input === '2') dispatch({ type: 'SWITCH_TAB', tab: 'sessions' });
    if (input === '3') dispatch({ type: 'SWITCH_TAB', tab: 'config' });

    // Tab switching: arrow keys (left/right)
    if (key.leftArrow) dispatch({ type: 'SWITCH_TAB_DELTA', delta: -1 });
    if (key.rightArrow) dispatch({ type: 'SWITCH_TAB_DELTA', delta: 1 });

    // Help & quit
    if (input === '?') dispatch({ type: 'TOGGLE_HELP' });
    if (input === 'q') exit();

    // Focus zone toggle (config tab only)
    if (state.activeTab === 'config' && key.tab) {
      dispatch({
        type: 'SET_FOCUS',
        zone: state.focusZone === 'sidebar' ? 'main' : 'sidebar',
      });
    }

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
        <Header activeTab={state.activeTab} branch={branch} dirtyCount={dirtyCount} />
        <Box flexGrow={1}>
          {state.activeTab === 'dashboard' && <DashboardView />}
          {state.activeTab === 'sessions'  && <SessionsView />}
          {state.activeTab === 'config'    && <ConfigView />}
        </Box>
        <StatusBar toast={state.toast} activeTab={state.activeTab} />
        {state.helpVisible && <HelpOverlay />}
      </Box>
    </TuiContext.Provider>
  );
}
