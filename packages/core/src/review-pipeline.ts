import { randomUUID } from 'node:crypto';
import { runBridge } from './bridge.js';
import { loadConfig } from './config.js';
import { cleanupContext, createContext } from './context.js';
import { parseFindings } from './finding-parser.js';
import { interpretFindings } from './interpret.js';
import { deriveRunStatus } from './operations.js';
import { orchestrateReview } from './orchestrate.js';
import { enrichFindings } from './report.js';
import { buildContextIndex, buildResultIndex } from './session-index.js';
import type { ContextWorkspace, Finding, InterpretResult, MmbridgeConfig, ResultIndex, ReviewRun } from './types.js';
import { nowIso } from './utils.js';

interface ReviewToolSummary {
  tool: string;
  findingCount: number;
  skipped: boolean;
  error?: string;
}

function countFindingsAcrossLanes(run: ReviewRun): number {
  return run.lanes.reduce((total, lane) => total + lane.findingCount, 0);
}

async function persistRun(
  options: ReviewPipelineOptions,
  run: ReviewRun,
  patch?: Partial<ReviewRun>,
): Promise<ReviewRun> {
  const nextRun: ReviewRun = {
    ...run,
    ...(patch ?? {}),
  };
  nextRun.findingsSoFar = countFindingsAcrossLanes(nextRun);
  nextRun.status = deriveRunStatus(nextRun.lanes);
  await options.persistRun?.(nextRun);
  return nextRun;
}

// ─── Public interfaces ──────────────────────────────────────────────────────

export interface ReviewPipelineOptions {
  tool: string;
  mode: string;
  projectDir: string;
  baseRef?: string;
  commit?: string;
  bridge?: 'none' | 'standard' | 'interpreted';
  bridgeProfile?: 'standard' | 'strict' | 'relaxed';
  recallPromptContext?: string;
  recallSummary?: string;
  /** Called at each pipeline phase for progress updates */
  onProgress?: (phase: string, detail: string) => void;
  onContextReady?: (contextIndex: ReturnType<typeof buildContextIndex>) => void;
  /** Called with raw stdout chunks from adapter processes */
  onStdout?: (tool: string, chunk: string) => void;
  /** Adapter runner — injected to avoid circular dependency on @mmbridge/adapters */
  runAdapter: (
    tool: string,
    options: {
      workspace: string;
      cwd: string;
      mode: string;
      baseRef?: string;
      changedFiles: string[];
      sessionId?: string;
      onStdout?: (chunk: string) => void;
      onStderr?: (chunk: string) => void;
    },
  ) => Promise<{
    text: string;
    externalSessionId: string | null;
    followupSupported: boolean;
  }>;
  /** List installed tool names (for bridge/all mode) */
  listInstalledTools?: () => Promise<string[]>;
  /** Session save callback — injected to avoid dependency on @mmbridge/session-store */
  saveSession?: (data: {
    tool: string;
    mode: string;
    projectDir: string;
    workspace: string;
    runId?: string | null;
    externalSessionId?: string | null;
    summary: string;
    findings: Finding[];
    contextIndex: ReturnType<typeof buildContextIndex>;
    resultIndex: ResultIndex;
    toolResults?: ReviewToolSummary[];
    interpretation?: InterpretResult | null;
    followupSupported?: boolean;
    status?: string;
    diffDigest?: string | null;
  }) => Promise<{ id: string }>;
  /** Persist the current review-run snapshot */
  persistRun?: (run: ReviewRun) => Promise<void>;
}

export interface ReviewPipelineResult {
  runId: string;
  sessionId: string;
  summary: string;
  findings: Finding[];
  externalSessionId?: string | null;
  followupSupported?: boolean;
  contextIndex: ReturnType<typeof buildContextIndex>;
  toolResults?: Array<{ tool: string; findingCount: number; skipped: boolean; error?: string }>;
  interpretation?: InterpretResult | null;
  resultIndex: ResultIndex;
}

// ─── Pipeline ────────────────────────────────────────────────────────────────

function buildCtxIndex(ctx: ContextWorkspace, projectDir: string, mode: string): ReturnType<typeof buildContextIndex> {
  const { workspace, baseRef, diffDigest, head, changedFiles, copiedFileCount, redaction } = ctx;
  return buildContextIndex({
    workspace,
    projectDir,
    mode,
    baseRef,
    diffDigest,
    head,
    changedFiles,
    copiedFileCount,
    redaction,
  });
}

export async function runReviewPipeline(options: ReviewPipelineOptions): Promise<ReviewPipelineResult> {
  const { tool, mode, projectDir, onProgress, onStdout } = options;
  const config: MmbridgeConfig = await loadConfig(projectDir).catch(() => ({}));
  const defaultBridgeMode = config.bridge?.mode ?? 'standard';
  const bridge = options.bridge ?? (tool === 'all' ? defaultBridgeMode : 'none');
  const bridgeProfile = options.bridgeProfile ?? config.bridge?.profile ?? 'standard';
  let run: ReviewRun = {
    id: randomUUID(),
    tool: tool === 'all' ? 'bridge' : tool,
    mode,
    projectDir,
    baseRef: options.baseRef ?? options.commit ?? null,
    diffDigest: null,
    changedFiles: 0,
    status: 'queued',
    phase: 'context',
    startedAt: nowIso(),
    completedAt: null,
    findingsSoFar: 0,
    warnings: [],
    sessionId: null,
    lanes:
      tool === 'all'
        ? []
        : [
            {
              tool,
              status: 'queued',
              attempt: 1,
              startedAt: null,
              completedAt: null,
              error: null,
              findingCount: 0,
              externalSessionId: null,
              followupSupported: false,
            },
          ],
  };
  await options.persistRun?.(run);

  // Phase 1: Create context
  onProgress?.('context', 'Building review context...');
  const ctx = await createContext({
    projectDir,
    mode,
    baseRef: options.baseRef,
    commit: options.commit,
    recallPromptContext: options.recallPromptContext,
    recallSummary: options.recallSummary,
  });

  try {
    const contextIndex = buildCtxIndex(ctx, projectDir, mode);
    run = await persistRun(options, run, {
      baseRef: ctx.baseRef ?? null,
      diffDigest: ctx.diffDigest,
      changedFiles: ctx.changedFiles.length,
      phase: 'review',
      status: 'running',
    });
    options.onContextReady?.(contextIndex);

    if (ctx.changedFiles.length === 0 && (options.baseRef || options.commit)) {
      onProgress?.('enrich', 'No changed files detected for this run.');
      const summary = 'No changed files to review for this run.';
      const resultIndex = buildResultIndex({
        summary,
        findings: [],
        parseState: 'empty',
        followupSupported: false,
      });
      const session = options.saveSession
        ? await options.saveSession({
            tool: tool === 'all' ? 'bridge' : tool,
            mode,
            projectDir,
            workspace: ctx.workspace,
            runId: run.id,
            summary,
            findings: [],
            contextIndex,
            resultIndex,
            followupSupported: false,
            status: 'complete',
            diffDigest: ctx.diffDigest,
          })
        : { id: 'unsaved' };
      run = await persistRun(options, run, {
        phase: 'handoff',
        completedAt: nowIso(),
        sessionId: session.id,
        lanes: run.lanes.map((lane) => ({
          ...lane,
          status: 'done',
          completedAt: nowIso(),
          findingCount: 0,
          followupSupported: false,
        })),
      });

      return {
        runId: run.id,
        sessionId: session.id,
        summary,
        findings: [],
        followupSupported: false,
        contextIndex,
        resultIndex,
      };
    }

    // Bridge mode (tool='all' or explicit bridge)
    if (tool === 'all' || bridge !== 'none') {
      if (run.lanes.length === 0) {
        const installedTools = options.listInstalledTools ? await options.listInstalledTools() : [];
        run = await persistRun(options, run, {
          lanes: installedTools.map((laneTool) => ({
            tool: laneTool,
            status: 'queued',
            attempt: 1,
            startedAt: null,
            completedAt: null,
            error: null,
            findingCount: 0,
            externalSessionId: null,
            followupSupported: false,
          })),
        });
      }
      return await runBridgePipeline(options, ctx, contextIndex, bridge, bridgeProfile, run);
    }

    // Single tool mode
    return await runSingleToolPipeline(options, ctx, contextIndex, run);
  } catch (error) {
    run = await persistRun(options, run, {
      phase: run.phase,
      status: 'failed',
      completedAt: nowIso(),
    });
    throw error;
  } finally {
    await cleanupContext(ctx.workspace).catch(() => {});
  }
}

async function runSingleToolPipeline(
  options: ReviewPipelineOptions,
  ctx: ContextWorkspace,
  contextIndex: ReturnType<typeof buildContextIndex>,
  initialRun: ReviewRun,
): Promise<ReviewPipelineResult> {
  const { tool, mode, projectDir, onProgress, onStdout, runAdapter, saveSession } = options;
  const startedAt = nowIso();
  let run = await persistRun(options, initialRun, {
    phase: 'review',
    status: 'running',
    lanes: initialRun.lanes.map((lane) =>
      lane.tool === tool ? { ...lane, status: 'running', startedAt, error: null } : lane,
    ),
  });

  // Phase 2: Run adapter
  onProgress?.('review', `Running ${tool}...`);
  let adapterResult: { text: string; externalSessionId: string | null; followupSupported: boolean };
  try {
    adapterResult = await runAdapter(tool, {
      workspace: ctx.workspace,
      cwd: projectDir,
      mode,
      baseRef: ctx.baseRef,
      changedFiles: ctx.changedFiles,
      onStdout: onStdout ? (chunk: string) => onStdout(tool, chunk) : undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await persistRun(options, run, {
      completedAt: nowIso(),
      lanes: run.lanes.map((lane) =>
        lane.tool === tool ? { ...lane, status: 'error', completedAt: nowIso(), error: message } : lane,
      ),
    });
    throw error;
  }

  // Phase 3: Parse and enrich
  onProgress?.('enrich', 'Parsing findings...');
  const rawFindings = parseFindings(adapterResult.text);
  const enriched = enrichFindings(rawFindings, ctx.changedFiles);

  const resultIndex = buildResultIndex({
    summary: adapterResult.text,
    findings: enriched.findings,
    filteredCount: enriched.filteredCount,
    promotedCount: enriched.promotedCount,
    followupSupported: adapterResult.followupSupported,
    rawOutput: adapterResult.text,
    parseState: 'raw',
  });

  // Phase 4: Save session
  const session = saveSession
    ? await saveSession({
        tool,
        mode,
        projectDir,
        workspace: ctx.workspace,
        runId: run.id,
        externalSessionId: adapterResult.externalSessionId,
        summary: enriched.summary ?? `${enriched.findings.length} findings`,
        findings: enriched.findings,
        contextIndex,
        resultIndex,
        followupSupported: adapterResult.followupSupported,
        status: 'complete',
        diffDigest: ctx.diffDigest,
      })
    : { id: 'unsaved' };
  run = await persistRun(options, run, {
    phase: 'handoff',
    completedAt: nowIso(),
    sessionId: session.id,
    lanes: run.lanes.map((lane) =>
      lane.tool === tool
        ? {
            ...lane,
            status: 'done',
            completedAt: nowIso(),
            findingCount: enriched.findings.length,
            externalSessionId: adapterResult.externalSessionId,
            followupSupported: adapterResult.followupSupported,
          }
        : lane,
    ),
  });

  return {
    runId: run.id,
    sessionId: session.id,
    summary: enriched.summary ?? `${enriched.findings.length} findings`,
    findings: enriched.findings,
    externalSessionId: adapterResult.externalSessionId,
    followupSupported: adapterResult.followupSupported,
    contextIndex,
    resultIndex,
  };
}

async function runBridgePipeline(
  options: ReviewPipelineOptions,
  ctx: ContextWorkspace,
  contextIndex: ReturnType<typeof buildContextIndex>,
  bridge: 'none' | 'standard' | 'interpreted',
  bridgeProfile: 'standard' | 'strict' | 'relaxed',
  initialRun: ReviewRun,
): Promise<ReviewPipelineResult> {
  const { mode, projectDir, onProgress, onStdout, runAdapter, listInstalledTools, saveSession } = options;
  let run = initialRun;
  let runUpdateQueue: Promise<void> = Promise.resolve();

  const installedTools = listInstalledTools ? await listInstalledTools() : [];

  if (installedTools.length === 0) {
    throw new Error('No review tools installed. Run `mmbridge doctor` to check.');
  }

  const queueRunUpdate = (buildPatch: (currentRun: ReviewRun) => Partial<ReviewRun>): Promise<void> => {
    const next = runUpdateQueue.then(async () => {
      run = await persistRun(options, run, buildPatch(run));
    });
    runUpdateQueue = next.catch(() => {});
    return next;
  };

  // Phase 2: Orchestrate parallel reviews
  onProgress?.('review', `Running ${installedTools.length} tools in parallel...`);
  const orchResult = await orchestrateReview({
    tools: installedTools,
    workspace: ctx.workspace,
    mode,
    baseRef: ctx.baseRef,
    changedFiles: ctx.changedFiles,
    runAdapter: (t, opts) => runAdapter(t, opts),
    onStdout,
    onToolProgress: async (tool, status, result) => {
      onProgress?.('review', `${tool}: ${status}`);
      const resultPayload =
        result && typeof result === 'object'
          ? (result as {
              findings?: Finding[];
              error?: string;
              externalSessionId?: string | null;
              followupSupported?: boolean;
            })
          : null;
      if (status === 'start') {
        const startedAt = nowIso();
        await queueRunUpdate((currentRun) => ({
          phase: 'review',
          lanes: currentRun.lanes.map((lane) =>
            lane.tool === tool ? { ...lane, status: 'running', startedAt, error: null } : lane,
          ),
        }));
        return;
      }

      await queueRunUpdate((currentRun) => ({
        lanes: currentRun.lanes.map((lane) => {
          if (lane.tool !== tool) return lane;
          return {
            ...lane,
            status: status === 'done' ? 'done' : 'error',
            completedAt: nowIso(),
            error: status === 'error' ? (resultPayload?.error ?? 'Tool execution failed') : null,
            findingCount: resultPayload?.findings?.length ?? 0,
            externalSessionId: resultPayload?.externalSessionId ?? null,
            followupSupported: resultPayload?.followupSupported ?? false,
          };
        }),
      }));
    },
  });

  // Phase 3: Bridge consensus
  onProgress?.('bridge', 'Running bridge consensus...');
  run = await persistRun(options, run, { phase: 'bridge', status: 'running' });
  const bridgeResult = await runBridge({
    profile: bridgeProfile,
    interpret: false,
    workspace: ctx.workspace,
    changedFiles: ctx.changedFiles,
    results: orchResult.results.map((r) => ({
      tool: r.tool,
      findings: r.findings,
      summary: r.summary,
      skipped: r.skipped,
    })),
  });

  if (bridge === 'interpreted' && bridgeResult.findings.length > 0) {
    onProgress?.('interpret', 'Validating consensus findings...');
    run = await persistRun(options, run, { phase: 'interpret', status: 'running' });
    try {
      bridgeResult.interpretation = await interpretFindings({
        mergedFindings: bridgeResult.findings,
        changedFiles: ctx.changedFiles,
        projectContext: '',
        workspace: ctx.workspace,
      });
    } catch {
      // Interpretation failure is non-critical — consensus findings still stand.
    }
  }

  const resultIndex = buildResultIndex({
    summary: bridgeResult.summary,
    findings: bridgeResult.findings,
    bridgeSummary: bridgeResult.summary,
  });

  // Phase 4: Save session
  const session = saveSession
    ? await saveSession({
        tool: 'bridge',
        mode,
        projectDir,
        workspace: ctx.workspace,
        runId: run.id,
        summary: bridgeResult.summary,
        findings: bridgeResult.findings,
        contextIndex,
        resultIndex,
        toolResults: orchResult.results.map((r) => ({
          tool: r.tool,
          findingCount: r.findings.length,
          skipped: r.skipped,
          error: r.error,
        })),
        interpretation: bridgeResult.interpretation ?? null,
        diffDigest: ctx.diffDigest,
      })
    : { id: 'unsaved' };
  run = await persistRun(options, run, {
    phase: 'handoff',
    completedAt: nowIso(),
    sessionId: session.id,
  });

  return {
    runId: run.id,
    sessionId: session.id,
    summary: bridgeResult.summary,
    findings: bridgeResult.findings,
    contextIndex,
    toolResults: orchResult.results.map((r) => ({
      tool: r.tool,
      findingCount: r.findings.length,
      skipped: r.skipped,
      error: r.error,
    })),
    interpretation: bridgeResult.interpretation ?? null,
    resultIndex,
  };
}
