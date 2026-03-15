import { parseFindings } from './finding-parser.js';
import { enrichFindings } from './report.js';
import type { Finding } from './types.js';

export interface AdapterRunResult {
  text: string;
}

export interface OrchestrateOptions {
  tools: string[];
  workspace: string;
  mode: string;
  baseRef?: string;
  changedFiles: string[];
  runAdapter: (
    tool: string,
    options: {
      workspace: string;
      cwd: string;
      mode: string;
      baseRef?: string;
      changedFiles: string[];
      onStdout?: (chunk: string) => void;
      onStderr?: (chunk: string) => void;
    },
  ) => Promise<AdapterRunResult>;
  onToolProgress?: (tool: string, status: 'start' | 'done' | 'error', result?: unknown) => void;
  /** Streaming callback for adapter stdout — receives (tool, chunk) */
  onStdout?: (tool: string, chunk: string) => void;
}

export interface ToolResult {
  tool: string;
  findings: Finding[];
  summary: string;
  skipped: boolean;
  error?: string;
}

export interface OrchestrateResult {
  results: ToolResult[];
  elapsed: number;
}

export async function orchestrateReview(options: OrchestrateOptions): Promise<OrchestrateResult> {
  const startTime = Date.now();

  const promises = options.tools.map(async (tool): Promise<ToolResult> => {
    options.onToolProgress?.(tool, 'start');
    try {
      const adapterResult = await options.runAdapter(tool, {
        workspace: options.workspace,
        cwd: process.cwd(),
        mode: options.mode,
        baseRef: options.baseRef,
        changedFiles: options.changedFiles,
        onStdout: options.onStdout ? (chunk: string) => options.onStdout?.(tool, chunk) : undefined,
      });

      const rawFindings = parseFindings(adapterResult.text);
      const enriched = enrichFindings(rawFindings, options.changedFiles);

      const result: ToolResult = {
        tool,
        findings: enriched.findings,
        summary: adapterResult.text,
        skipped: false,
      };

      options.onToolProgress?.(tool, 'done', result);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const result: ToolResult = {
        tool,
        findings: [],
        summary: '',
        skipped: true,
        error: message,
      };
      options.onToolProgress?.(tool, 'error', result);
      return result;
    }
  });

  // Inner try/catch ensures all promises resolve — Promise.all is safe here
  const toolResults = await Promise.all(promises);

  return {
    results: toolResults,
    elapsed: (Date.now() - startTime) / 1000,
  };
}
