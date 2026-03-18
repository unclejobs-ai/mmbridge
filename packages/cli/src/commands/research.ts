import type { ResearchReport } from '@mmbridge/core';
import { StreamRenderer } from '../render/stream-renderer.js';
import {
  exitWithError,
  importAdapters,
  importCore,
  importSessionStore,
  jsonOutput,
  resolveProjectDir,
} from './helpers.js';

export interface ResearchCommandOptions {
  topic: string;
  type?: string;
  tool?: string;
  project?: string;
  json?: boolean;
  stream?: boolean;
}

function formatResearchReport(report: ResearchReport): void {
  const C = {
    RESET: '\x1b[0m',
    BOLD: '\x1b[1m',
    DIM: '\x1b[2m',
    GREEN: '\x1b[38;2;166;227;161m',
    ACCENT: '\x1b[38;2;180;190;254m',
    YELLOW: '\x1b[38;2;249;226;175m',
    BLUE: '\x1b[38;2;137;220;235m',
    RED: '\x1b[38;2;243;139;168m',
  } as const;

  process.stdout.write(
    `\n${C.BOLD}${C.ACCENT}Research: ${report.topic}${C.RESET}  ${C.DIM}(${report.type})${C.RESET}\n\n`,
  );

  if (report.consensus.length > 0) {
    process.stdout.write(`${C.GREEN}${C.BOLD}Consensus (${report.consensus.length})${C.RESET}\n`);
    for (const insight of report.consensus) {
      process.stdout.write(
        `  ${C.GREEN}●${C.RESET} ${insight.content}\n    ${C.DIM}Sources: ${insight.sources.join(', ')} · ${insight.confidence}${C.RESET}\n`,
      );
    }
    process.stdout.write('\n');
  }

  const uniqueTools = Object.keys(report.uniqueInsights);
  if (uniqueTools.length > 0) {
    process.stdout.write(`${C.BLUE}${C.BOLD}Unique Insights${C.RESET}\n`);
    for (const tool of uniqueTools) {
      const insights = report.uniqueInsights[tool] ?? [];
      if (insights.length === 0) continue;
      process.stdout.write(`  ${C.DIM}[${tool}]${C.RESET}\n`);
      for (const insight of insights) {
        process.stdout.write(
          `    ${C.BLUE}◆${C.RESET} ${insight.content}\n      ${C.DIM}${insight.confidence}${C.RESET}\n`,
        );
      }
    }
    process.stdout.write('\n');
  }

  if (report.contradictions.length > 0) {
    process.stdout.write(`${C.YELLOW}${C.BOLD}Contradictions (${report.contradictions.length})${C.RESET}\n`);
    for (const insight of report.contradictions) {
      process.stdout.write(`  ${C.YELLOW}▲${C.RESET} ${insight.content}\n`);
      if (insight.positions) {
        for (const pos of insight.positions) {
          process.stdout.write(`    ${C.DIM}[${pos.source}] ${pos.position}${C.RESET}\n`);
        }
      }
    }
    process.stdout.write('\n');
  }

  process.stdout.write(`${C.DIM}${report.summary}${C.RESET}\n`);
}

export async function runResearchCommand(options: ResearchCommandOptions): Promise<void> {
  const { topic } = options;

  if (!topic || topic.trim().length === 0) {
    exitWithError('Research topic is required. Usage: mmbridge research <topic>');
  }

  const researchType = (options.type ?? 'open') as 'code-aware' | 'open';
  if (researchType !== 'code-aware' && researchType !== 'open') {
    exitWithError(`Invalid research type "${options.type}". Use "code-aware" or "open".`);
  }

  const projectDir = resolveProjectDir(options.project);

  const { runResearchPipeline } = await import('@mmbridge/core');
  const { defaultRegistry, runReviewAdapter } = await importAdapters(projectDir);
  const { SessionStore, ProjectMemoryStore } = await importSessionStore();
  const { buildResultIndex } = await importCore();

  // Resolve tools
  let toolNames: string[];
  if (options.tool && options.tool.trim() !== '' && options.tool.toLowerCase() !== 'all') {
    toolNames = options.tool
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);

    for (const name of toolNames) {
      if (!defaultRegistry.get(name)) {
        exitWithError(`Unknown tool: ${name}. Available: ${defaultRegistry.list().join(', ')}`);
      }
    }
  } else {
    toolNames = await defaultRegistry.listInstalled();
  }

  if (toolNames.length === 0) {
    exitWithError('No tools available for research. Run `mmbridge doctor` to check installed tools.');
  }

  const sessionStore = new SessionStore();
  const memoryStore = new ProjectMemoryStore(sessionStore.baseDir);

  const recall = await memoryStore.buildRecall(projectDir, { mode: 'research', tool: toolNames.join(',') });

  const saveSession = (data: Parameters<typeof sessionStore.save>[0]) =>
    sessionStore.save({
      ...data,
      recalledMemoryIds: recall.recalledMemoryIds,
      contextDigest: data.contextIndex
        ? `${data.contextIndex.changedFiles} changed · ${data.contextIndex.copiedFiles} copied`
        : null,
    });

  const pipelineOptions = {
    topic,
    type: researchType,
    tools: toolNames,
    projectDir,
    baseRef: undefined as string | undefined,
    runAdapter: runReviewAdapter,
    listInstalledTools: () => defaultRegistry.listInstalled(),
    saveSession,
  };

  if (options.stream) {
    const renderer = new StreamRenderer('research', 'research');
    const startedAt = Date.now();
    renderer.start();
    renderer.phase('recall', recall.summary);
    renderer.setRecall(recall.summary, recall.memoryHits);

    try {
      const result = await runResearchPipeline({
        ...pipelineOptions,
        onProgress: (phase, detail) => renderer.phase(phase, detail),
        onStdout: (_tool, chunk) => {
          for (const line of chunk.split('\n')) {
            renderer.streamLine(line);
          }
        },
      });

      const elapsedMs = Date.now() - startedAt;
      const elapsed = elapsedMs < 1000 ? `${elapsedMs}ms` : `${(elapsedMs / 1000).toFixed(1)}s`;
      renderer.printSummary([], elapsed);
      renderer.done(result.sessionId);

      if (options.json) {
        jsonOutput(result.report);
      } else {
        formatResearchReport(result.report);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      renderer.phase('handoff', 'Capturing failure...');

      await sessionStore.save({
        tool: 'research',
        mode: 'research',
        projectDir,
        workspace: projectDir,
        runId: null,
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
        diffDigest: null,
      });

      process.stderr.write(`[mmbridge] Research failed: ${message}\n`);
      process.exitCode = 1;
    } finally {
      renderer.cleanup();
    }

    return;
  }

  // Non-streaming path
  try {
    const result = await runResearchPipeline(pipelineOptions);

    if (options.json) {
      jsonOutput(result.report);
      return;
    }

    formatResearchReport(result.report);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    await sessionStore.save({
      tool: 'research',
      mode: 'research',
      projectDir,
      workspace: projectDir,
      runId: null,
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
      diffDigest: null,
    });

    process.stderr.write(`[mmbridge] Research failed: ${message}\n`);
    process.exitCode = 1;
  }
}
