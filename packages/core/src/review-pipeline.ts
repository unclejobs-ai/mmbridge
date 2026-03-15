import { runBridge } from './bridge.js';
import { loadConfig } from './config.js';
import { cleanupContext, createContext } from './context.js';
import { parseFindings } from './finding-parser.js';
import { orchestrateReview } from './orchestrate.js';
import { enrichFindings } from './report.js';
import { buildContextIndex, buildResultIndex } from './session-index.js';
import type { ContextWorkspace, Finding, InterpretResult, MmbridgeConfig, ResultIndex } from './types.js';

interface ReviewToolSummary {
  tool: string;
  findingCount: number;
  skipped: boolean;
  error?: string;
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
  /** Called at each pipeline phase for progress updates */
  onProgress?: (phase: string, detail: string) => void;
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
    externalSessionId?: string | null;
    summary: string;
    findings: Finding[];
    contextIndex: ReturnType<typeof buildContextIndex>;
    resultIndex: ResultIndex;
    toolResults?: ReviewToolSummary[];
    interpretation?: InterpretResult | null;
    followupSupported?: boolean;
    status?: string;
  }) => Promise<{ id: string }>;
}

export interface ReviewPipelineResult {
  sessionId: string;
  summary: string;
  findings: Finding[];
  externalSessionId?: string | null;
  followupSupported?: boolean;
  toolResults?: Array<{ tool: string; findingCount: number; skipped: boolean; error?: string }>;
  interpretation?: InterpretResult | null;
  resultIndex: ResultIndex;
}

// ─── Pipeline ────────────────────────────────────────────────────────────────

function buildCtxIndex(ctx: ContextWorkspace, projectDir: string, mode: string): ReturnType<typeof buildContextIndex> {
  const { workspace, baseRef, head, changedFiles, copiedFileCount, redaction } = ctx;
  return buildContextIndex({ workspace, projectDir, mode, baseRef, head, changedFiles, copiedFileCount, redaction });
}

export async function runReviewPipeline(options: ReviewPipelineOptions): Promise<ReviewPipelineResult> {
  const { tool, mode, projectDir, onProgress, onStdout } = options;
  const config: MmbridgeConfig = await loadConfig(projectDir).catch(() => ({}));
  const defaultBridgeMode = config.bridge?.mode ?? 'standard';
  const bridge = options.bridge ?? (tool === 'all' ? defaultBridgeMode : 'none');
  const bridgeProfile = options.bridgeProfile ?? config.bridge?.profile ?? 'standard';

  // Phase 1: Create context
  onProgress?.('context', 'Building review context...');
  const ctx = await createContext({
    projectDir,
    mode,
    baseRef: options.baseRef,
    commit: options.commit,
  });

  try {
    const contextIndex = buildCtxIndex(ctx, projectDir, mode);

    // Bridge mode (tool='all' or explicit bridge)
    if (tool === 'all' || bridge !== 'none') {
      return await runBridgePipeline(options, ctx, contextIndex, bridge, bridgeProfile);
    }

    // Single tool mode
    return await runSingleToolPipeline(options, ctx, contextIndex);
  } finally {
    await cleanupContext(ctx.workspace).catch(() => {});
  }
}

async function runSingleToolPipeline(
  options: ReviewPipelineOptions,
  ctx: ContextWorkspace,
  contextIndex: ReturnType<typeof buildContextIndex>,
): Promise<ReviewPipelineResult> {
  const { tool, mode, projectDir, onProgress, onStdout, runAdapter, saveSession } = options;

  // Phase 2: Run adapter
  onProgress?.('review', `Running ${tool}...`);
  const adapterResult = await runAdapter(tool, {
    workspace: ctx.workspace,
    cwd: projectDir,
    mode,
    baseRef: ctx.baseRef,
    changedFiles: ctx.changedFiles,
    onStdout: onStdout ? (chunk: string) => onStdout(tool, chunk) : undefined,
  });

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
        externalSessionId: adapterResult.externalSessionId,
        summary: enriched.summary ?? `${enriched.findings.length} findings`,
        findings: enriched.findings,
        contextIndex,
        resultIndex,
        followupSupported: adapterResult.followupSupported,
        status: 'complete',
      })
    : { id: 'unsaved' };

  return {
    sessionId: session.id,
    summary: enriched.summary ?? `${enriched.findings.length} findings`,
    findings: enriched.findings,
    externalSessionId: adapterResult.externalSessionId,
    followupSupported: adapterResult.followupSupported,
    resultIndex,
  };
}

async function runBridgePipeline(
  options: ReviewPipelineOptions,
  ctx: ContextWorkspace,
  contextIndex: ReturnType<typeof buildContextIndex>,
  bridge: 'none' | 'standard' | 'interpreted',
  bridgeProfile: 'standard' | 'strict' | 'relaxed',
): Promise<ReviewPipelineResult> {
  const { mode, projectDir, onProgress, onStdout, runAdapter, listInstalledTools, saveSession } = options;

  const installedTools = listInstalledTools ? await listInstalledTools() : [];

  if (installedTools.length === 0) {
    throw new Error('No review tools installed. Run `mmbridge doctor` to check.');
  }

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
    onToolProgress: (tool, status) => {
      onProgress?.('review', `${tool}: ${status}`);
    },
  });

  // Phase 3: Bridge consensus
  onProgress?.('bridge', 'Running bridge consensus...');
  const isInterpreted = bridge === 'interpreted';
  const bridgeResult = await runBridge({
    profile: bridgeProfile,
    interpret: isInterpreted,
    workspace: ctx.workspace,
    changedFiles: ctx.changedFiles,
    results: orchResult.results.map((r) => ({
      tool: r.tool,
      findings: r.findings,
      summary: r.summary,
      skipped: r.skipped,
    })),
  });

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
      })
    : { id: 'unsaved' };

  return {
    sessionId: session.id,
    summary: bridgeResult.summary,
    findings: bridgeResult.findings,
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
