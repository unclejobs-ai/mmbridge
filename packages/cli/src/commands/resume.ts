import type { Finding, ResumeAction, ResumeResult, ReviewRun } from '@mmbridge/core';
import type { HandoffDocument, Session } from '@mmbridge/session-store';
import type { ReviewReport } from '@mmbridge/tui';
import {
  exitWithError,
  importAdapters,
  importCore,
  importSessionStore,
  importTui,
  jsonOutput,
  resolveProjectDir,
} from './helpers.js';

export interface ResumeCommandOptions {
  project?: string;
  session?: string;
  action?: 'followup' | 'rerun' | 'bridge-rerun';
  yes?: boolean;
  json?: boolean;
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

function isReviewMode(mode: string): mode is 'review' | 'security' | 'architecture' {
  return mode === 'review' || mode === 'security' || mode === 'architecture';
}

function summarizePreview(input: {
  session: Session;
  sourceSession: Session;
  recommendation: ResumeResult;
  gateWarnings: Array<{ code: string; message: string; nextCommand: string }>;
  handoff: HandoffDocument | null;
}): string {
  const lines = [
    `Session: ${input.session.id}`,
    `Tool: ${input.session.tool}`,
    `Mode: ${input.sourceSession.mode}`,
    `Summary: ${input.recommendation.summary}`,
  ];

  if (input.handoff?.artifact.openBlockers.length) {
    lines.push(`Top blocker: ${input.handoff.artifact.openBlockers[0]}`);
  }

  if (input.recommendation.recommended) {
    lines.push(
      `Recommended action: ${input.recommendation.recommended.action} — ${input.recommendation.recommended.reason}`,
    );
  } else {
    lines.push('Recommended action: none');
  }

  if (input.gateWarnings.length > 0) {
    lines.push('Gate warnings:');
    for (const warning of input.gateWarnings) {
      lines.push(`- ${warning.code}: ${warning.message}`);
    }
  }

  if (input.handoff?.recommendedNextCommand) {
    lines.push(`Latest handoff next: ${input.handoff.recommendedNextCommand}`);
  }

  return lines.join('\n');
}

export async function runResumeCommand(options: ResumeCommandOptions): Promise<void> {
  const projectDir = resolveProjectDir(options.project);

  const core = await importCore();
  const { defaultRegistry, runFollowupAdapter, runReviewAdapter } = await importAdapters(projectDir);
  const sessionStoreModule = await importSessionStore();
  const { renderReviewConsole } = await importTui();

  const {
    buildResultIndex,
    evaluateGate,
    getChangedFiles,
    getDefaultBaseRef,
    getDiff,
    recommendResumeAction,
    runReviewPipeline,
    runCommand,
    shortDigest,
  } = core;
  const { ProjectMemoryStore, RunStore, SessionStore } = sessionStoreModule;

  const sessionStore = new SessionStore();
  const runStore = new RunStore(sessionStore.baseDir);
  const memoryStore = new ProjectMemoryStore(sessionStore.baseDir);

  const selectedSession = options.session
    ? await sessionStore.get(options.session)
    : ((await sessionStore.list({ projectDir, limit: 1 }))[0] ?? null);

  if (!selectedSession) {
    exitWithError('No saved session is available to resume for this project.');
  }
  const session = selectedSession;

  const parentSession =
    session.mode === 'followup' && session.parentSessionId ? await sessionStore.get(session.parentSessionId) : null;
  const sourceSession = parentSession ?? session;
  const effectiveMode = isReviewMode(sourceSession.mode) ? sourceSession.mode : 'review';

  const currentRunFromSession = session.runId ? await runStore.get(session.runId) : null;
  const latestRun =
    currentRunFromSession && isReviewMode(currentRunFromSession.mode)
      ? currentRunFromSession
      : await runStore.getLatest({ projectDir, mode: effectiveMode });

  let baseRef: string | null = latestRun?.baseRef ?? sourceSession.baseRef ?? null;
  let diffDigest: string | null = latestRun?.diffDigest ?? sourceSession.diffDigest ?? null;
  let changedFilesCount = latestRun?.changedFiles ?? sourceSession.contextIndex?.changedFiles ?? 0;

  const gitRoot = await runCommand('git', ['rev-parse', '--is-inside-work-tree'], { cwd: projectDir }).catch(
    () => null,
  );
  if (gitRoot?.ok && gitRoot.stdout.trim() === 'true') {
    baseRef = baseRef ?? (await getDefaultBaseRef(projectDir));
    const [diffText, changedFiles] = await Promise.all([
      getDiff(baseRef, projectDir),
      getChangedFiles(baseRef, projectDir),
    ]);
    diffDigest = shortDigest(diffText);
    changedFilesCount = changedFiles.length;
  }

  const handoff = await memoryStore.getHandoffBySession(projectDir, session.id).catch(() => null);
  const gateResult = evaluateGate({
    current: {
      projectDir,
      mode: effectiveMode,
      baseRef,
      diffDigest,
      changedFilesCount,
      explicitMode: false,
    },
    latestRun,
    latestSession: {
      id: session.id,
      tool: session.tool,
      mode: session.mode,
      externalSessionId: session.externalSessionId ?? null,
      followupSupported: session.followupSupported ?? false,
      findings: session.findings ?? [],
      findingDecisions: session.findingDecisions ?? [],
    },
    latestHandoff: handoff
      ? {
          artifact: {
            sessionId: handoff.artifact.sessionId,
            nextCommand: handoff.artifact.nextCommand,
            openBlockers: handoff.artifact.openBlockers,
          },
          recommendedNextCommand: handoff.recommendedNextCommand,
        }
      : null,
  });

  const recommendation = recommendResumeAction({
    latestRun,
    latestSession: {
      id: session.id,
      tool: session.tool,
      mode: session.mode,
      projectDir,
      externalSessionId: session.externalSessionId ?? null,
      followupSupported: session.followupSupported ?? false,
      findings: session.findings ?? [],
      summary: session.summary,
    },
    latestHandoff: handoff
      ? {
          artifact: {
            sessionId: handoff.artifact.sessionId,
            nextCommand: handoff.artifact.nextCommand,
            openBlockers: handoff.artifact.openBlockers,
          },
          recommendedNextCommand: handoff.recommendedNextCommand,
        }
      : null,
    gateResult,
  });

  const preview = summarizePreview({
    session,
    sourceSession,
    recommendation,
    gateWarnings: gateResult.warnings,
    handoff,
  });

  const canFollowup = Boolean(session.followupSupported && session.externalSessionId);
  const availableActions = new Set<ResumeAction>(['rerun', 'bridge-rerun']);
  if (canFollowup) {
    availableActions.add('followup');
  }

  if (options.action && !availableActions.has(options.action)) {
    exitWithError(`Action "${options.action}" is not valid for session ${session.id}.`);
  }

  let chosenAction: ResumeAction | null = options.action ?? recommendation.recommended?.action ?? null;

  if (!options.action && !options.yes && process.stdin.isTTY && process.stdout.isTTY && chosenAction) {
    const { cancel, intro, isCancel, outro, select } = await import('@clack/prompts');
    intro('mmbridge resume');
    process.stdout.write(`${preview}\n\n`);
    const selection = await select({
      message: 'Choose the next action',
      options: [
        ...(canFollowup
          ? [{ value: 'followup', label: 'followup', hint: 'Continue the existing external session thread' }]
          : []),
        { value: 'rerun', label: 'rerun', hint: 'Run the latest review tool again against the current diff' },
        { value: 'bridge-rerun', label: 'bridge-rerun', hint: 'Run a fresh bridge-backed review' },
        { value: 'preview', label: 'preview only', hint: 'Show the recommendation and stop' },
      ],
      initialValue: chosenAction,
    });

    if (isCancel(selection) || selection === 'preview') {
      cancel('Resume cancelled.');
      return;
    }

    chosenAction = selection as ResumeAction;
    outro(`Executing ${chosenAction}`);
  }

  if (!chosenAction || (!options.yes && !options.action && !(process.stdin.isTTY && process.stdout.isTTY))) {
    if (options.json) {
      jsonOutput({
        status: 'preview',
        summary: preview,
        recommended: recommendation.recommended,
        alternatives: recommendation.alternatives,
        gate: gateResult,
      });
    } else {
      process.stdout.write(`${preview}\n`);
    }
    return;
  }

  async function executeReviewAction(action: 'rerun' | 'bridge-rerun'): Promise<ReviewConsoleReport> {
    const tool = action === 'bridge-rerun' || sourceSession.tool === 'bridge' ? 'all' : sourceSession.tool;
    const bridge = action === 'bridge-rerun' || sourceSession.tool === 'bridge' ? 'standard' : 'none';
    const recall = await memoryStore.buildRecall(projectDir, {
      mode: effectiveMode,
      tool: tool === 'all' ? 'bridge' : tool,
      sessionId: session.id,
      queryText: handoff?.recommendedNextPrompt ?? session.summary,
    });
    let lastRunId: string | null = null;
    let lastRunDiffDigest: string | null = diffDigest;

    const saveSession = (data: Parameters<typeof sessionStore.save>[0]) =>
      sessionStore.save({
        ...data,
        recalledMemoryIds: recall.recalledMemoryIds,
        contextDigest: data.contextIndex ? formatContextDigest(data.contextIndex) : null,
        resumeSourceSessionId: session.id,
        resumeAction: action,
      });
    const persistRun = async (run: ReviewRun): Promise<void> => {
      const savedRun = await runStore.save(run);
      lastRunId = savedRun.id;
      lastRunDiffDigest = savedRun.diffDigest;
    };

    try {
      const result = await runReviewPipeline({
        tool,
        mode: effectiveMode,
        projectDir,
        baseRef: baseRef ?? undefined,
        bridge,
        recallPromptContext: recall.promptContext,
        recallSummary: recall.summary,
        runAdapter: runReviewAdapter,
        listInstalledTools: () => defaultRegistry.listInstalled(),
        saveSession,
        persistRun,
        onContextReady: () => {},
      });
      const nextHandoff = await memoryStore.createOrUpdateHandoff(
        projectDir,
        result.sessionId,
        recall.recalledMemoryIds,
      );
      return {
        tool: result.toolResults?.length ? 'bridge' : tool === 'all' ? 'bridge' : tool,
        mode: effectiveMode,
        status: 'complete',
        localSessionId: result.sessionId,
        summary: result.summary,
        findings: result.findings,
        resultIndex: result.resultIndex,
        externalSessionId: result.externalSessionId ?? undefined,
        followupSupported: result.followupSupported,
        toolResults: result.toolResults,
        interpretation: result.interpretation ?? undefined,
        recalledMemorySummary: recall.summary,
        recalledMemoryHits: recall.memoryHits,
        handoff: nextHandoff.artifact,
        handoffPath: nextHandoff.artifact.markdownPath,
        nextPrompt: nextHandoff.recommendedNextPrompt,
        nextCommand: nextHandoff.recommendedNextCommand,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failedSession = await sessionStore.save({
        tool: tool === 'all' ? 'bridge' : tool,
        mode: effectiveMode,
        projectDir,
        workspace: projectDir,
        runId: lastRunId,
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
        diffDigest: lastRunDiffDigest,
        resumeSourceSessionId: session.id,
        resumeAction: action,
      });
      process.exitCode = 1;
      return {
        tool: tool === 'all' ? 'bridge' : tool,
        mode: effectiveMode,
        status: 'error',
        localSessionId: failedSession.id,
        summary: message,
        findings: [],
        resultIndex: failedSession.resultIndex ?? undefined,
        recalledMemorySummary: recall.summary,
        recalledMemoryHits: recall.memoryHits,
        nextCommand: recommendation.alternatives[0]
          ? `mmbridge resume --project ${JSON.stringify(projectDir)} --action ${recommendation.alternatives[0]}`
          : undefined,
      };
    }
  }

  async function executeFollowupAction(): Promise<ReviewConsoleReport> {
    if (!session.externalSessionId) {
      exitWithError(`Session ${session.id} does not have an external session id for follow-up.`);
    }

    const followupPrompt =
      handoff?.recommendedNextPrompt ??
      `Re-check the latest blocker for session ${session.id} and propose the smallest safe fix.`;
    const recall = await memoryStore.buildRecall(projectDir, {
      mode: 'followup',
      tool: session.tool,
      queryText: followupPrompt,
      sessionId: session.id,
    });
    const finalPrompt = recall.promptContext
      ? ['# Recall', recall.promptContext, '', '# Follow-up', followupPrompt].join('\n\n')
      : followupPrompt;
    const startedAt = new Date().toISOString();
    let run = await runStore.save({
      tool: session.tool,
      mode: 'followup',
      projectDir,
      baseRef,
      diffDigest,
      changedFiles: changedFilesCount,
      status: 'running',
      phase: 'review',
      startedAt,
      completedAt: null,
      findingsSoFar: 0,
      warnings: [],
      sessionId: null,
      lanes: [
        {
          tool: session.tool,
          status: 'running',
          attempt: 1,
          startedAt,
          completedAt: null,
          error: null,
          findingCount: 0,
          externalSessionId: session.externalSessionId,
          followupSupported: true,
        },
      ],
    });

    try {
      const result = await runFollowupAdapter(session.tool, {
        workspace: projectDir,
        cwd: projectDir,
        sessionId: session.externalSessionId,
        prompt: finalPrompt,
      });

      const findings = core.parseFindings(result.text);
      const resultIndex = buildResultIndex({
        summary: result.text,
        findings,
        followupSupported: result.followupSupported,
        rawOutput: result.text,
        parseState: 'raw',
      });

      if (!result.ok) {
        throw new Error(result.text || 'Follow-up adapter returned a failure state.');
      }

      const savedSession = await sessionStore.save({
        tool: session.tool,
        mode: 'followup',
        projectDir,
        workspace: projectDir,
        runId: run.id,
        externalSessionId: result.externalSessionId ?? session.externalSessionId,
        parentSessionId: session.id,
        resumeSourceSessionId: session.id,
        resumeAction: 'followup',
        summary: result.text,
        findings,
        resultIndex,
        recalledMemoryIds: recall.recalledMemoryIds,
        diffDigest,
        followupSupported: result.followupSupported,
        status: 'complete',
      });

      run = await runStore.save({
        ...run,
        status: 'completed',
        phase: 'handoff',
        completedAt: new Date().toISOString(),
        findingsSoFar: findings.length,
        sessionId: savedSession.id,
        lanes: run.lanes.map((lane) => ({
          ...lane,
          status: 'done',
          completedAt: new Date().toISOString(),
          findingCount: findings.length,
          externalSessionId: result.externalSessionId ?? session.externalSessionId ?? null,
          followupSupported: result.followupSupported,
        })),
      });

      const nextHandoff = await memoryStore.createOrUpdateHandoff(
        projectDir,
        savedSession.id,
        recall.recalledMemoryIds,
      );
      return {
        tool: session.tool,
        mode: 'followup',
        status: 'complete',
        localSessionId: savedSession.id,
        externalSessionId: result.externalSessionId ?? session.externalSessionId ?? undefined,
        summary: result.text,
        findings,
        resultIndex,
        followupSupported: result.followupSupported,
        recalledMemorySummary: recall.summary,
        recalledMemoryHits: recall.memoryHits,
        handoff: nextHandoff.artifact,
        handoffPath: nextHandoff.artifact.markdownPath,
        nextPrompt: nextHandoff.recommendedNextPrompt,
        nextCommand: nextHandoff.recommendedNextCommand,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      run = await runStore.save({
        ...run,
        status: 'failed',
        completedAt: new Date().toISOString(),
        warnings: [...run.warnings, message],
        lanes: run.lanes.map((lane) => ({
          ...lane,
          status: 'error',
          completedAt: new Date().toISOString(),
          error: message,
        })),
      });
      const failedSession = await sessionStore.save({
        tool: session.tool,
        mode: 'followup',
        projectDir,
        workspace: projectDir,
        runId: run.id,
        externalSessionId: session.externalSessionId,
        parentSessionId: session.id,
        resumeSourceSessionId: session.id,
        resumeAction: 'followup',
        summary: message,
        findings: [],
        resultIndex: buildResultIndex({
          summary: message,
          findings: [],
          rawOutput: message,
          parseState: 'error',
        }),
        recalledMemoryIds: recall.recalledMemoryIds,
        diffDigest,
        followupSupported: false,
        status: 'error',
      });
      process.exitCode = 1;
      return {
        tool: session.tool,
        mode: 'followup',
        status: 'error',
        localSessionId: failedSession.id,
        externalSessionId: session.externalSessionId ?? undefined,
        summary: message,
        findings: [],
        resultIndex: failedSession.resultIndex ?? undefined,
        recalledMemorySummary: recall.summary,
        recalledMemoryHits: recall.memoryHits,
        nextCommand: recommendation.alternatives[0]
          ? `mmbridge resume --project ${JSON.stringify(projectDir)} --action ${recommendation.alternatives[0]}`
          : undefined,
      };
    }
  }

  const report = chosenAction === 'followup' ? await executeFollowupAction() : await executeReviewAction(chosenAction);

  if (options.json) {
    jsonOutput(report);
    return;
  }

  await renderReviewConsole(report);
}
