import {
  resolveProjectDir,
  jsonOutput,
  exitWithError,
  importCore,
  importAdapters,
  importSessionStore,
  importTui,
} from './helpers.js';

export interface ReviewCommandOptions {
  tool?: string;
  mode?: string;
  bridge?: string;
  baseRef?: string;
  commit?: string;
  project?: string;
  json?: boolean;
  export?: string;
}

export async function runReviewCommand(options: ReviewCommandOptions): Promise<void> {
  const projectDir = resolveProjectDir(options.project);
  const mode = options.mode ?? 'review';
  const tool = options.tool ?? 'kimi';
  const bridge = (options.bridge ?? 'none') as 'none' | 'standard' | 'interpreted';

  const { runReviewPipeline, commandExists } = await importCore();
  const { defaultRegistry, runReviewAdapter } = await importAdapters();
  const { SessionStore } = await importSessionStore();
  const { renderReviewConsole } = await importTui();

  // Validate tool exists (unless 'all')
  if (tool !== 'all') {
    const adapter = defaultRegistry.get(tool);
    if (!adapter) {
      exitWithError(`Unknown tool: ${tool}. Available: ${defaultRegistry.list().join(', ')}`);
    }
    const isInstalled = await commandExists(adapter.binary);
    if (!isInstalled) {
      exitWithError(
        `Binary "${adapter.binary}" not found in PATH. Install it to use the "${tool}" adapter.`,
      );
    }
  }

  const sessionStore = new SessionStore(projectDir);

  const result = await runReviewPipeline({
    tool,
    mode,
    projectDir,
    baseRef: options.baseRef,
    commit: options.commit,
    bridge: tool === 'all' && bridge === 'none' ? 'standard' : bridge,
    runAdapter: runReviewAdapter,
    listInstalledTools: () => defaultRegistry.listInstalled(),
    saveSession: (data) => sessionStore.save(data),
  });

  const report = {
    localSessionId: result.sessionId,
    summary: result.summary,
    findings: result.findings,
    resultIndex: result.resultIndex,
    externalSessionId: result.externalSessionId ?? undefined,
    followupSupported: result.followupSupported,
    toolResults: result.toolResults,
    interpretation: result.interpretation ?? undefined,
  };

  if (options.export) {
    const { exportReport } = await import('./export.js');
    await exportReport(report, options.export);
  }

  if (options.json) {
    jsonOutput(report);
    return;
  }

  await renderReviewConsole(report);
}
