import { useCallback } from 'react';
import type { TuiAction } from '../store.js';

interface ExportableFindings {
  localSessionId?: string;
  summary: string;
  findings: ReadonlyArray<{ severity: string; file: string; line: number | null; message: string }>;
}

export function useExportReport(dispatch: React.Dispatch<TuiAction>) {
  return useCallback(
    async (data: ExportableFindings, filePrefix?: string) => {
      try {
        const { exportReport } = await import('@mmbridge/core');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const home = process.env.HOME ?? '/tmp';
        const prefix = filePrefix ? `${filePrefix}-` : '';
        const exportPath = `${home}/.mmbridge/exports/${prefix}${timestamp}.md`;
        await exportReport(
          {
            localSessionId: data.localSessionId,
            summary: data.summary,
            findings: data.findings.map((f) => ({
              severity: f.severity as 'CRITICAL' | 'WARNING' | 'INFO' | 'REFACTOR',
              file: f.file,
              line: f.line,
              message: f.message,
            })),
          },
          exportPath,
        );
        dispatch({ type: 'SHOW_TOAST', message: `Exported to ${exportPath}`, toastType: 'success' });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Export failed';
        dispatch({ type: 'SHOW_TOAST', message: msg, toastType: 'error' });
      }
    },
    [dispatch],
  );
}
