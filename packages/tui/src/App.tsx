import { Box, useApp, useInput } from 'ink';
import type React from 'react';
import { useReducer } from 'react';
import { Header } from './components/Header.js';
import { HelpOverlay } from './components/HelpOverlay.js';
import { StatusBar } from './components/StatusBar.js';
import { useLoadData } from './hooks/use-data.js';
import { TAB_ORDER, TuiContext, initialState, tuiReducer } from './store.js';
import type { TabId } from './store.js';
import { ConfigView } from './views/ConfigView.js';
import { DashboardView } from './views/DashboardView.js';
import { SessionsView } from './views/SessionsView.js';

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

    // Tab switching: number keys + letter shortcuts (d/s/c for xterm compat)
    if (input === '1' || input === 'd') dispatch({ type: 'SWITCH_TAB', tab: 'dashboard' });
    if (input === '2' || input === 's') dispatch({ type: 'SWITCH_TAB', tab: 'sessions' });
    if (input === '3' || input === 'c') dispatch({ type: 'SWITCH_TAB', tab: 'config' });

    // Tab switching: arrow keys
    if (key.leftArrow) dispatch({ type: 'SWITCH_TAB_DELTA', delta: -1 });
    if (key.rightArrow) dispatch({ type: 'SWITCH_TAB_DELTA', delta: 1 });

    // Tab key: switch tabs (except in config where it toggles focus zone)
    if (key.tab && state.activeTab === 'config') {
      dispatch({
        type: 'SET_FOCUS',
        zone: state.focusZone === 'sidebar' ? 'main' : 'sidebar',
      });
    } else if (key.tab && !key.shift) {
      const idx = TAB_ORDER.indexOf(state.activeTab);
      const next = TAB_ORDER[(idx + 1) % TAB_ORDER.length] as TabId;
      dispatch({ type: 'SWITCH_TAB', tab: next });
    } else if (key.tab && key.shift) {
      const idx = TAB_ORDER.indexOf(state.activeTab);
      const prev = TAB_ORDER[(idx - 1 + TAB_ORDER.length) % TAB_ORDER.length] as TabId;
      dispatch({ type: 'SWITCH_TAB', tab: prev });
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
          {state.activeTab === 'sessions' && <SessionsView key="sess" />}
          {state.activeTab === 'config' && <ConfigView key="conf" />}
        </Box>
        <StatusBar toast={state.toast} activeTab={state.activeTab} />
        {state.helpVisible && <HelpOverlay />}
      </Box>
    </TuiContext.Provider>
  );
}
