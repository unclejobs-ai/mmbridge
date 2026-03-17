import type { Finding } from '@mmbridge/core';
import type { ReviewReport } from '@mmbridge/tui';
import { StreamRenderer } from '../render/stream-renderer.js';
import {
  exitWithError,
  importAdapters,
  importCore,
  importSessionStore,
  importTui,
  jsonOutput,
  resolveProjectDir,
} from './helpers.js';

export interface ReviewCommandOptions {
  tool?: string;
  all?: boolean;
  manager?: boolean;
  mode?: string;
  bridge?: string;
  baseRef?: string;
  commit?: string;
  project?: string;
  json?: boolean;
  export?: string;
  stream?: boolean;
}

function normalizeReviewSelection(options: ReviewCommandOptions): {
  tool: string;
  bridge: 'none' | 'standard' | 'interpreted' | undefined;
} {
  const bridge = options.bridge as 'none' | 'standard' | 'interpreted' | undefined;

  if (options.manager) {
    if (options.tool && options.tool !== 'all') {
      exitWithError('--manager cannot be combined with --tool. Use `mmbridge review --manager` by itself.');
    }
    if (bridge && bridge !== 'interpreted') {
      exitWithError('--manager cannot be combined with legacy --bridge modes other than `interpreted`.');
    }
    return { tool: 'all', bridge: 'interpreted' };
  }

  if (options.all) {
    if (options.tool && options.tool !== 'all') {
      exitWithError('--all cannot be combined with --tool. Use either `--tool <name>` or `--all`.');
    }
    return { tool: 'all', bridge };
  }

  return {
    tool: options.tool ?? 'kimi',
    bridge,
  };
}

type ReviewConsoleReport = ReviewReport & {
  summary: string;
  findings: Finding[];
};

function formatContextDigest(contextIndex: {
  changedFiles: number;
  copiedFiles: number;
  redaction?: { usedRuleCount: number } | null;
}): string {
  return [
    `${contextIndex.changedFiles} changed`,
    `${contextIndex.copiedFiles} copied`,
    `${contextIndex.redaction?.usedRuleCount ?? 0} redactions`,
  ].join(' · ');
}

export async function runReviewCommand(options: ReviewCommandOptions): Promise<void> {
  const projectDir = resolveProjectDir(options.project);
  const mode = options.mode ?? 'review';
  const { tool, bridge } = normalizeReviewSelection(options);

  const { buildResultIndex, runReviewPipeline, commandExists } = await importCore();
  const { defaultRegistry, runReviewAdapter } = await importAdapters(projectDir);
  const { ProjectMemoryStore, SessionStore } = await importSessionStore();
  const { renderReviewConsole } = await importTui();

  // Validate tool exists (unless 'all')
  if (tool !== 'all') {
    const adapter = defaultRegistry.get(tool);
    if (!adapter) {
      exitWithError(`Unknown tool: ${tool}. Available: ${defaultRegistry.list().join(', ')}`);
    }
    const isInstalled = await commandExists(adapter.binary);
    if (!isInstalled) {
      exitWithError(`Binary "${adapter.binary}" not found in PATH. Install it to use the "${tool}" adapter.`);
    }
  }

  const sessionStore = new SessionStore();
  const memoryStore = new ProjectMemoryStore(sessionStore.baseDir);
  const recall = await memoryStore.buildRecall(projectDir, { mode, tool });

  const saveSession = (data: Parameters<typeof sessionStore.save>[0]) =>
    sessionStore.save({
      ...data,
      recalledMemoryIds: recall.recalledMemoryIds,
      contextDigest: data.contextIndex ? formatContextDigest(data.contextIndex) : null,
    });

  const finalizeReport = async (
    result: Awaited<ReturnType<typeof runReviewPipeline>>,
  ): Promise<ReviewConsoleReport> => {
    const handoff = await memoryStore.createOrUpdateHandoff(projectDir, result.sessionId, recall.recalledMemoryIds);
    return {
      tool: result.toolResults?.length ? 'bridge' : tool,
      mode,
      status: 'complete',
      localSessionId: result.sessionId,
      summary: result.summary,
      findings: result.findings,
      resultIndex: result.resultIndex,
      externalSessionId: result.externalSessionId ?? undefined,
      followupSupported: result.followupSupported,
      toolResults: result.toolResults,
      interpretation: result.interpretation ?? undefined,
      manager: result.manager ?? undefined,
      recalledMemorySummary: recall.summary,
      recalledMemoryHits: recall.memoryHits,
      handoff: handoff.artifact,
      handoffPath: handoff.artifact.markdownPath,
      nextPrompt: handoff.recommendedNextPrompt,
      nextCommand: handoff.recommendedNextCommand,
    };
  };

  const buildErrorReport = async (error: unknown): Promise<ReviewConsoleReport> => {
    const message = error instanceof Error ? error.message : String(error);
    const failedSession = await sessionStore.save({
      tool: tool === 'all' ? 'bridge' : tool,
      mode,
      projectDir,
      workspace: projectDir,
      summary: message,
      findings: [],
      resultIndex: buildResultIndex({
        summary: message,
        findings: [],
        rawOutput: message,
        parseState: 'error',
      }),
      status: 'error',
      recalledMemoryIds: recall.recalledMemoryIds,
      contextDigest: null,
    });
    const handoff = await memoryStore.createOrUpdateHandoff(projectDir, failedSession.id, recall.recalledMemoryIds);
    return {
      tool: tool === 'all' ? 'bridge' : tool,
      mode,
      status: 'error',
      localSessionId: failedSession.id,
      summary: message,
      findings: [],
      resultIndex: failedSession.resultIndex ?? undefined,
      recalledMemorySummary: recall.summary,
      recalledMemoryHits: recall.memoryHits,
      handoff: handoff.artifact,
      handoffPath: handoff.artifact.markdownPath,
      nextPrompt: handoff.recommendedNextPrompt,
      nextCommand: handoff.recommendedNextCommand,
    };
  };

  if (options.stream) {
    const renderer = new StreamRenderer(tool, mode);
    const startedAt = Date.now();
    renderer.start();
    renderer.phase('recall', recall.summary);
    renderer.setRecall(recall.summary, recall.memoryHits);

    try {
      const result = await runReviewPipeline({
        tool,
        mode,
        projectDir,
        baseRef: options.baseRef,
        commit: options.commit,
        bridge,
        recallPromptContext: recall.promptContext,
        recallSummary: recall.summary,
        runAdapter: runReviewAdapter,
        listInstalledTools: () => defaultRegistry.listInstalled(),
        saveSession,
        onContextReady: (contextIndex) => renderer.setContextIndex(contextIndex),
        onProgress: (phase, detail) => renderer.phase(phase, detail),
        onStdout: (_tool, chunk) => {
          for (const line of chunk.split('\n')) {
            renderer.streamLine(line);
          }
        },
      });
      renderer.setContextIndex(result.contextIndex);
      renderer.phase('handoff', 'Writing handoff artifact...');
      renderer.setHandoff('writing');
      const report = await finalizeReport(result);
      renderer.setHandoff('done', report.handoffPath ?? null, report.handoff?.summary ?? null);

      const elapsedMs = Date.now() - startedAt;
      const elapsed = elapsedMs < 1000 ? `${elapsedMs}ms` : `${(elapsedMs / 1000).toFixed(1)}s`;

      renderer.printFindings(result.findings);
      renderer.printSummary(result.findings, elapsed);
      renderer.done(result.sessionId);
      await renderReviewConsole(report);
    } catch (error) {
      renderer.phase('handoff', 'Capturing failure handoff...');
      renderer.setHandoff('writing');
      const report = await buildErrorReport(error);
      renderer.setHandoff('error', report.handoffPath ?? null, report.handoff?.summary ?? null);
      await renderReviewConsole(report);
      process.exitCode = 1;
    } finally {
      renderer.cleanup();
    }

    return;
  }

  let report: ReviewConsoleReport;
  try {
    const result = await runReviewPipeline({
      tool,
      mode,
      projectDir,
      baseRef: options.baseRef,
      commit: options.commit,
      bridge,
      recallPromptContext: recall.promptContext,
      recallSummary: recall.summary,
      runAdapter: runReviewAdapter,
      listInstalledTools: () => defaultRegistry.listInstalled(),
      saveSession,
      onContextReady: () => {},
    });
    report = await finalizeReport(result);
  } catch (error) {
    report = await buildErrorReport(error);
    process.exitCode = 1;
  }

  if (options.export) {
    const { exportReport } = await import('./export.js');
    await exportReport(
      {
        localSessionId: report.localSessionId,
        externalSessionId: report.externalSessionId,
        workspace: report.workspace,
        summary: report.summary,
        findings: report.findings,
        resultIndex: report.resultIndex,
        followupSupported: report.followupSupported,
      },
      options.export,
    );
  }

  if (options.json) {
    jsonOutput(report);
    return;
  }

  await renderReviewConsole(report);
}
