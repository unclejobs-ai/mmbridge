import { runFollowupAdapter } from '@mmbridge/adapters';
import { useCallback } from 'react';
import type { TuiAction } from '../store.js';

export function useFollowup(dispatch: React.Dispatch<TuiAction>) {
  const submit = useCallback(
    async (tool: string, sessionId: string, prompt: string) => {
      dispatch({ type: 'COMPLETE_INPUT' });
      try {
        const result = await runFollowupAdapter(tool, {
          workspace: process.cwd(),
          sessionId,
          prompt,
        });
        dispatch({
          type: 'SHOW_TOAST',
          message: `Followup: ${result.text.slice(0, 60)}...`,
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
