import {
  exitWithError,
  importAdapters,
  importCore,
  importSessionStore,
  importTui,
  jsonOutput,
  resolveProjectDir,
} from './helpers.js';

export interface FollowupCommandOptions {
  tool: string;
  prompt: string;
  json?: boolean;
  explicitSessionId?: string;
  projectDir?: string;
  useLatestWhenMissing?: boolean;
}

export async function runFollowupCommand(options: FollowupCommandOptions): Promise<void> {
  const projectDir = resolveProjectDir(options.projectDir);

  const { createMemoryProvider, SessionStore } = await importSessionStore();
  const { buildResultIndex, parseFindings } = await importCore();
  const { runFollowupAdapter } = await importAdapters(projectDir);
  const { renderReviewConsole } = await importTui();

  const sessionStore = new SessionStore();
  const memoryStore = await createMemoryProvider({ projectDir, baseDir: sessionStore.baseDir });

  let sessionId = options.explicitSessionId;
  let parentSessionId: string | undefined;
  if (!sessionId) {
    if (options.useLatestWhenMissing) {
      const sessions = await sessionStore.list({ tool: options.tool, projectDir });
      const latest = sessions[0] ?? null;
      if (!latest?.externalSessionId) {
        exitWithError(`No external session ID found for tool "${options.tool}". Run a review first.`);
      }
      sessionId = latest.externalSessionId;
      parentSessionId = latest.id;
    } else {
      exitWithError('Session ID is required. Pass --session or run with --latest flag.');
    }
  }

  if (!parentSessionId && sessionId) {
    const sessions = await sessionStore.list({ tool: options.tool, projectDir });
    parentSessionId = sessions.find((session) => session.externalSessionId === sessionId)?.id;
  }

  const recall = await memoryStore.buildRecall(projectDir, {
    mode: 'followup',
    tool: options.tool,
    queryText: options.prompt,
    sessionId: parentSessionId,
  });

  const finalPrompt = recall.promptContext
    ? ['# Recall', recall.promptContext, '', '# Follow-up', options.prompt].join('\n\n')
    : options.prompt;
  let report: {
    tool: string;
    mode: string;
    status: string;
    localSessionId: string;
    externalSessionId?: string;
    summary: string;
    findings: ReturnType<typeof parseFindings>;
    resultIndex: ReturnType<typeof buildResultIndex>;
    followupSupported?: boolean;
    recalledMemorySummary: string;
    recalledMemoryHits: typeof recall.memoryHits;
    handoff: Awaited<ReturnType<typeof memoryStore.createOrUpdateHandoff>>['artifact'];
    handoffPath: string;
    nextPrompt: string;
    nextCommand: string;
  };

  try {
    const result = await runFollowupAdapter(options.tool, {
      workspace: projectDir,
      cwd: projectDir,
      sessionId,
      prompt: finalPrompt,
    });

    const findings = parseFindings(result.text);
    const resultIndex = buildResultIndex({
      summary: result.text,
      findings,
      followupSupported: result.followupSupported,
      rawOutput: result.text,
      parseState: 'raw',
    });
    const savedSession = await sessionStore.save({
      tool: options.tool,
      mode: 'followup',
      projectDir,
      workspace: projectDir,
      externalSessionId: result.externalSessionId ?? sessionId,
      parentSessionId,
      summary: result.text,
      findings,
      resultIndex,
      recalledMemoryIds: recall.recalledMemoryIds,
      followupSupported: result.followupSupported,
      status: result.ok ? 'complete' : 'error',
    });
    const handoff = await memoryStore.createOrUpdateHandoff(projectDir, savedSession.id, recall.recalledMemoryIds);

    report = {
      tool: options.tool,
      mode: 'followup',
      status: result.ok ? 'complete' : 'error',
      localSessionId: savedSession.id,
      externalSessionId: result.externalSessionId ?? sessionId,
      summary: result.text,
      findings,
      resultIndex,
      followupSupported: result.followupSupported,
      recalledMemorySummary: recall.summary,
      recalledMemoryHits: recall.memoryHits,
      handoff: handoff.artifact,
      handoffPath: handoff.artifact.markdownPath,
      nextPrompt: handoff.recommendedNextPrompt,
      nextCommand: handoff.recommendedNextCommand,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const resultIndex = buildResultIndex({
      summary: message,
      findings: [],
      rawOutput: message,
      parseState: 'error',
    });
    const savedSession = await sessionStore.save({
      tool: options.tool,
      mode: 'followup',
      projectDir,
      workspace: projectDir,
      externalSessionId: sessionId,
      parentSessionId,
      summary: message,
      findings: [],
      resultIndex,
      recalledMemoryIds: recall.recalledMemoryIds,
      followupSupported: false,
      status: 'error',
    });
    const handoff = await memoryStore.createOrUpdateHandoff(projectDir, savedSession.id, recall.recalledMemoryIds);
    report = {
      tool: options.tool,
      mode: 'followup',
      status: 'error',
      localSessionId: savedSession.id,
      externalSessionId: sessionId,
      summary: message,
      findings: [],
      resultIndex,
      followupSupported: false,
      recalledMemorySummary: recall.summary,
      recalledMemoryHits: recall.memoryHits,
      handoff: handoff.artifact,
      handoffPath: handoff.artifact.markdownPath,
      nextPrompt: handoff.recommendedNextPrompt,
      nextCommand: handoff.recommendedNextCommand,
    };
    process.exitCode = 1;
  }

  if (options.json) {
    jsonOutput(report);
    return;
  }

  await renderReviewConsole(report);
}
