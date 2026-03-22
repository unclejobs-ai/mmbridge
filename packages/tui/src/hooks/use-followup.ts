import { runFollowupAdapter } from '@mmbridge/adapters';
import { buildResultIndex, parseFindings } from '@mmbridge/core';
import { SessionStore } from '@mmbridge/session-store';
import { useCallback } from 'react';
import type { TuiAction } from '../store.js';
import { applyTuiData, loadTuiData } from './use-data.js';

export function useFollowup(dispatch: React.Dispatch<TuiAction>) {
  const submit = useCallback(
    async (tool: string, sessionId: string, prompt: string, parentSessionId?: string) => {
      dispatch({ type: 'COMPLETE_INPUT' });
      try {
        const result = await runFollowupAdapter(tool, {
          workspace: process.cwd(),
          cwd: process.cwd(),
          sessionId,
          prompt,
        });
        const findings = parseFindings(result.text);
        const resultIndex = buildResultIndex({
          summary: result.text,
          findings,
          followupSupported: result.followupSupported,
          rawOutput: result.text,
          parseState: 'raw',
        });
        const store = new SessionStore();
        const saved = await store.save({
          tool,
          mode: 'followup',
          projectDir: process.cwd(),
          workspace: process.cwd(),
          externalSessionId: result.externalSessionId ?? sessionId,
          parentSessionId,
          summary: result.text,
          findings,
          resultIndex,
          followupSupported: result.followupSupported,
          status: result.ok ? 'complete' : 'error',
        });
        const sessions = await store.list({ projectDir: process.cwd() });
        dispatch({ type: 'SET_SESSIONS', sessions });
        const refreshed = await loadTuiData(process.cwd());
        applyTuiData(dispatch, refreshed);
        dispatch({ type: 'SESSIONS_SELECT', index: 0 });
        dispatch({
          type: 'SHOW_TOAST',
          message: `Followup saved: ${saved.id.slice(0, 8)}`,
          toastType: 'success',
        });
      } catch {
        dispatch({
          type: 'SHOW_TOAST',
          message: 'Followup failed',
          toastType: 'error',
        });
      }
    },
    [dispatch],
  );

  const cancel = useCallback(() => {
    dispatch({ type: 'CANCEL_INPUT' });
  }, [dispatch]);

  return { submit, cancel };
}
