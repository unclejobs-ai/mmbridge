import { randomUUID } from 'node:crypto';
import { runDebatePipeline } from './debate-pipeline.js';
import { runResearchPipeline } from './research-pipeline.js';
import { runReviewPipeline } from './review-pipeline.js';
import { runSecurityPipeline } from './security-pipeline.js';
import { type buildContextIndex, buildResultIndex } from './session-index.js';
import type {
  EmbraceCheckpoint,
  EmbraceConfig,
  EmbracePhase,
  EmbracePhaseStatus,
  EmbracePhaseType,
  EmbraceReport,
  EmbraceRun,
  Finding,
  InterpretResult,
  ResultIndex,
  SecurityFinding,
} from './types.js';
import { nowIso } from './utils.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const ESTIMATED_TOKENS_PER_INVOCATION = 1500;

// ─── Default config ───────────────────────────────────────────────────────────

const DEFAULT_EMBRACE_CONFIG: EmbraceConfig = {
  phases: ['research', 'debate', 'checkpoint', 'review', 'security', 'report'],
  gateThresholds: { research: 50, debate: 60, checkpoint: 0, review: 40, security: 70 },
  mandatoryCheckpoints: ['checkpoint'],
  toolPreferences: {},
  bridgeProfile: 'standard',
  adaptiveRouting: true,
};

// ─── Public interfaces ────────────────────────────────────────────────────────

export interface EmbracePipelineOptions {
  task: string;
  projectDir: string;
  baseRef?: string;
  tools?: string[];
  skipPhases?: EmbracePhaseType[];
  config?: Partial<EmbraceConfig>;
  resumeId?: string;
  resolveCheckpoint?: string;
  nonInteractive?: boolean;
  onProgress?: (phase: EmbracePhaseType, status: EmbracePhaseStatus, detail: string) => void;
  onCheckpoint?: (checkpoint: EmbraceCheckpoint) => Promise<string | null>;
  onStdout?: (tool: string, chunk: string) => void;
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
  ) => Promise<{ text: string; externalSessionId: string | null; followupSupported: boolean }>;
  listInstalledTools?: () => Promise<string[]>;
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
    toolResults?: Array<{ tool: string; findingCount: number; skipped: boolean; error?: string }>;
    interpretation?: InterpretResult | null;
    followupSupported?: boolean;
    status?: string;
    diffDigest?: string | null;
  }) => Promise<{ id: string }>;
  loadEmbraceRun?: (id: string) => Promise<EmbraceRun | null>;
  saveEmbraceRun?: (run: EmbraceRun) => Promise<void>;
}

export interface EmbracePipelineResult {
  runId: string;
  run: EmbraceRun;
  report: EmbraceReport;
}

// ─── Internal phase data ──────────────────────────────────────────────────────

interface ResearchPhaseData {
  consensusCount: number;
  uniqueCount: number;
  summary: string;
}

interface DebatePhaseData {
  agreementsCount: number;
  novelInsightsCount: number;
  summary: string;
}

interface ReviewPhaseData {
  findings: Finding[];
  criticalCount: number;
  warningCount: number;
  summary: string;
}

interface SecurityPhaseData {
  findings: SecurityFinding[];
  p0Count: number;
  p1Count: number;
  p2Count: number;
  summary: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildInitialPhase(type: EmbracePhaseType): EmbracePhase {
  return {
    type,
    status: 'pending',
    sessionId: null,
    startedAt: null,
    completedAt: null,
    gate: null,
    findings: [],
    summary: '',
    adapterInvocations: 0,
    estimatedTokens: 0,
  };
}

function computeGateThreshold(config: EmbraceConfig, phaseType: EmbracePhaseType): number {
  return config.gateThresholds[phaseType] ?? 0;
}

function detectSecurityConcernsInText(text: string): boolean {
  const keywords = ['vulnerability', 'injection', 'exploit', 'auth bypass'];
  const lower = text.toLowerCase();
  return keywords.some((kw) => lower.includes(kw));
}

// ─── Pipeline ─────────────────────────────────────────────────────────────────

export async function runEmbracePipeline(options: EmbracePipelineOptions): Promise<EmbracePipelineResult> {
  const {
    task,
    projectDir,
    baseRef,
    skipPhases = [],
    onProgress,
    onCheckpoint,
    onStdout,
    runAdapter,
    listInstalledTools,
    saveSession,
    loadEmbraceRun,
    saveEmbraceRun,
  } = options;

  const config: EmbraceConfig = {
    ...DEFAULT_EMBRACE_CONFIG,
    ...options.config,
    gateThresholds: {
      ...DEFAULT_EMBRACE_CONFIG.gateThresholds,
      ...(options.config?.gateThresholds ?? {}),
    },
  };

  const tools = options.tools ?? [];
  const resolvedTools = tools.length > 0 ? tools : listInstalledTools ? await listInstalledTools() : [];

  // Step 1: Init or resume
  let run: EmbraceRun;

  if (options.resumeId && !loadEmbraceRun) {
    throw new Error(`Cannot resume embrace run "${options.resumeId}": loadEmbraceRun is not provided.`);
  }

  if (options.resumeId && loadEmbraceRun) {
    const existing = await loadEmbraceRun(options.resumeId);
    if (!existing) {
      throw new Error(`Embrace run "${options.resumeId}" not found.`);
    }
    run = existing;
  } else {
    const phases: EmbracePhase[] = config.phases.map(buildInitialPhase);
    run = {
      id: randomUUID(),
      task,
      projectDir,
      baseRef: baseRef ?? null,
      status: 'running',
      phases,
      checkpoints: [],
      currentPhaseIndex: 0,
      startedAt: nowIso(),
      completedAt: null,
      totalAdapterInvocations: 0,
      totalEstimatedTokens: 0,
      adaptiveInsertions: [],
      config,
    };
    await saveEmbraceRun?.(run);
  }

  // Collected phase data for final report
  const researchData: ResearchPhaseData = { consensusCount: 0, uniqueCount: 0, summary: '' };
  const debateData: DebatePhaseData = { agreementsCount: 0, novelInsightsCount: 0, summary: '' };
  const reviewData: ReviewPhaseData = { findings: [], criticalCount: 0, warningCount: 0, summary: '' };
  const securityData: SecurityPhaseData = { findings: [], p0Count: 0, p1Count: 0, p2Count: 0, summary: '' };

  const phaseScores: Partial<Record<EmbracePhaseType, number>> = {};

  // Adaptive security sub-check tracking
  let adaptiveSecurityInserted = false;

  // Step 2: Execute each phase
  for (let i = 0; i < run.phases.length; i++) {
    const phase = run.phases[i];
    if (!phase) continue;

    const phaseType = phase.type;

    // Skip if already completed (resume scenario)
    if (phase.status === 'completed' || phase.status === 'skipped') {
      phaseScores[phaseType] = phase.gate?.score ?? 100;
      continue;
    }

    // Skip explicitly requested phases
    if (skipPhases.includes(phaseType)) {
      run.phases[i] = { ...phase, status: 'skipped', startedAt: nowIso(), completedAt: nowIso() };
      phaseScores[phaseType] = 100;
      await saveEmbraceRun?.(run);
      onProgress?.(phaseType, 'skipped', `Phase ${phaseType} skipped`);
      continue;
    }

    // Update to running
    run.phases[i] = { ...phase, status: 'running', startedAt: nowIso() };
    run.currentPhaseIndex = i;
    await saveEmbraceRun?.(run);
    onProgress?.(phaseType, 'running', `Starting phase: ${phaseType}`);

    let phaseScore = 0;
    let phaseSummary = '';
    let phaseFindings: Finding[] = [];
    let adapterInvocations = 0;
    let sessionId: string | null = null;

    try {
      if (phaseType === 'research') {
        // ── Research phase ──────────────────────────────────────────────────
        const researchResult = await runResearchPipeline({
          topic: task,
          type: 'code-aware',
          tools: resolvedTools,
          projectDir,
          baseRef,
          onProgress: (p, d) => onProgress?.(phaseType, 'running', `${p}: ${d}`),
          onStdout,
          runAdapter,
          listInstalledTools,
          saveSession,
        });

        const report = researchResult.report;
        const consensusCount = report.consensus.length;
        const uniqueCount = Object.values(report.uniqueInsights).reduce((sum, arr) => sum + arr.length, 0);

        researchData.consensusCount = consensusCount;
        researchData.uniqueCount = uniqueCount;
        researchData.summary = report.summary;

        phaseSummary = report.summary;
        sessionId = researchResult.sessionId;
        adapterInvocations = resolvedTools.length;
        phaseScore = Math.min(100, consensusCount * 10 + uniqueCount * 5);

        // Adaptive routing: check for security concerns
        if (config.adaptiveRouting && !adaptiveSecurityInserted && detectSecurityConcernsInText(report.summary)) {
          adaptiveSecurityInserted = true;
          run.adaptiveInsertions.push('security-sub-check');
          // Insert an extra security phase after security if not already present
          const hasSecurityAlready = run.phases.some((p) => p.type === 'security');
          if (!hasSecurityAlready) {
            run.phases.splice(i + 1, 0, buildInitialPhase('security'));
            onProgress?.(
              phaseType,
              'running',
              'Adaptive routing: security concerns detected, inserting security phase',
            );
          }
        }
      } else if (phaseType === 'debate') {
        // ── Debate phase ────────────────────────────────────────────────────
        const debateResult = await runDebatePipeline({
          proposition: task,
          rounds: 2,
          tools: resolvedTools,
          projectDir,
          baseRef,
          onProgress: (p, d) => onProgress?.(phaseType, 'running', `${p}: ${d}`),
          onStdout,
          runAdapter,
          listInstalledTools,
          saveSession,
        });

        const transcript = debateResult.transcript;
        const agreementsCount = transcript.verdict.agreements.length;
        const novelInsightsCount = transcript.verdict.novelInsights.length;

        debateData.agreementsCount = agreementsCount;
        debateData.novelInsightsCount = novelInsightsCount;
        debateData.summary = `Debate "${task}": ${agreementsCount} agreements, ${transcript.verdict.disagreements.length} disagreements, ${novelInsightsCount} novel insights`;

        phaseSummary = debateData.summary;
        sessionId = debateResult.sessionId;
        adapterInvocations = resolvedTools.length * 2; // rounds
        phaseScore = Math.min(100, agreementsCount * 15 + novelInsightsCount * 10);
      } else if (phaseType === 'checkpoint') {
        // ── Checkpoint phase ────────────────────────────────────────────────
        const contextParts: string[] = [];
        if (researchData.summary) contextParts.push(`Research: ${researchData.summary}`);
        if (debateData.summary) contextParts.push(`Debate: ${debateData.summary}`);
        const contextText =
          contextParts.length > 0
            ? `Based on research and debate, key considerations are: ${contextParts.join('. ')}`
            : 'No prior phase data available.';

        const checkpoint: EmbraceCheckpoint = {
          id: randomUUID(),
          phaseType: 'checkpoint',
          prompt: 'Review the findings and decide how to proceed.',
          context: contextText,
          options: ['Proceed with current approach', 'Adjust scope', 'Cancel'],
          resolvedAt: null,
          resolution: null,
        };

        run.checkpoints.push(checkpoint);
        await saveEmbraceRun?.(run);

        let resolution: string | null = null;

        if (options.nonInteractive) {
          resolution = 'Proceed with current approach';
        } else if (options.resolveCheckpoint && options.resumeId) {
          resolution = options.resolveCheckpoint;
        } else if (onCheckpoint) {
          resolution = await onCheckpoint(checkpoint);
        }

        if (resolution === null) {
          // Pause the run
          run.status = 'paused';
          run.currentPhaseIndex = i;
          await saveEmbraceRun?.(run);
          onProgress?.(phaseType, 'paused', 'Waiting for checkpoint resolution');

          // Return partial result
          const partialReport = buildEmbraceReport(
            task,
            researchData,
            debateData,
            reviewData,
            securityData,
            phaseScores,
          );
          return { runId: run.id, run, report: partialReport };
        }

        // Mark checkpoint as resolved
        const checkpointIndex = run.checkpoints.findIndex((c) => c.id === checkpoint.id);
        if (checkpointIndex !== -1) {
          run.checkpoints[checkpointIndex] = {
            ...checkpoint,
            resolvedAt: nowIso(),
            resolution,
          };
        }

        phaseSummary = `Checkpoint resolved: ${resolution}`;
        phaseScore = 100;
        adapterInvocations = 0;
      } else if (phaseType === 'review') {
        // ── Review phase ────────────────────────────────────────────────────
        const tool = config.toolPreferences.review ?? tools[0] ?? 'all';

        const reviewResult = await runReviewPipeline({
          tool,
          mode: 'review',
          projectDir,
          baseRef,
          bridge: tool === 'all' ? 'standard' : 'none',
          bridgeProfile: config.bridgeProfile,
          onProgress: (p, d) => onProgress?.(phaseType, 'running', `${p}: ${d}`),
          onStdout,
          runAdapter,
          listInstalledTools,
          saveSession,
        });

        const findings = reviewResult.findings;
        const criticalCount = findings.filter((f) => f.severity === 'CRITICAL').length;
        const warningCount = findings.filter((f) => f.severity === 'WARNING').length;

        reviewData.findings = findings;
        reviewData.criticalCount = criticalCount;
        reviewData.warningCount = warningCount;
        reviewData.summary = reviewResult.summary;
        phaseFindings = findings;

        phaseSummary = reviewResult.summary;
        sessionId = reviewResult.sessionId;
        adapterInvocations = reviewResult.toolResults?.length ?? 1;
        phaseScore = Math.max(0, 100 - criticalCount * 20 - warningCount * 5);
      } else if (phaseType === 'security') {
        // ── Security phase ──────────────────────────────────────────────────
        const securityResult = await runSecurityPipeline({
          scope: 'all',
          tools: resolvedTools,
          projectDir,
          baseRef,
          bridge: resolvedTools.length > 1 ? 'standard' : 'none',
          bridgeProfile: config.bridgeProfile,
          onProgress: (p, d) => onProgress?.(phaseType, 'running', `${p}: ${d}`),
          onStdout,
          runAdapter,
          listInstalledTools,
          saveSession,
        });

        const secFindings = securityResult.report.findings;
        const p0Count = securityResult.report.severityCounts.P0;
        const p1Count = securityResult.report.severityCounts.P1;
        const p2Count = securityResult.report.severityCounts.P2;

        securityData.findings = secFindings;
        securityData.p0Count = p0Count;
        securityData.p1Count = p1Count;
        securityData.p2Count = p2Count;
        securityData.summary = securityResult.report.summary;
        phaseFindings = secFindings;

        phaseSummary = securityResult.report.summary;
        sessionId = securityResult.sessionId;
        adapterInvocations = resolvedTools.length;
        phaseScore = Math.max(0, 100 - p0Count * 30 - p1Count * 15 - p2Count * 5);
      } else if (phaseType === 'report') {
        // ── Report phase ─────────────────────────────────────────────────────
        const scoreValues = Object.values(phaseScores).filter((s) => typeof s === 'number');
        phaseScore =
          scoreValues.length > 0 ? Math.round(scoreValues.reduce((sum, s) => sum + s, 0) / scoreValues.length) : 100;

        phaseSummary = `Overall embrace score: ${phaseScore}/100`;
        adapterInvocations = 0;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failedPhase = run.phases[i];
      run.phases[i] = {
        ...failedPhase,
        status: 'failed',
        completedAt: nowIso(),
        summary: message,
        error: message,
        gate: {
          score: 0,
          threshold: computeGateThreshold(config, phaseType),
          reasons: [`Phase failed: ${message}`],
          autoProceeded: false,
        },
      };
      run.status = 'failed';
      await saveEmbraceRun?.(run);
      throw error;
    }

    // Update phase totals
    run.totalAdapterInvocations += adapterInvocations;
    run.totalEstimatedTokens += adapterInvocations * ESTIMATED_TOKENS_PER_INVOCATION;

    // Evaluate gate
    const threshold = computeGateThreshold(config, phaseType);
    const autoProceeded = phaseScore >= threshold;
    const gate = {
      score: phaseScore,
      threshold,
      reasons: autoProceeded
        ? [`Score ${phaseScore} >= threshold ${threshold}`]
        : [`Score ${phaseScore} < threshold ${threshold}`],
      autoProceeded,
    };

    phaseScores[phaseType] = phaseScore;

    // Complete the phase
    const currentPhase = run.phases[i];
    run.phases[i] = {
      ...currentPhase,
      status: 'completed',
      completedAt: nowIso(),
      sessionId,
      gate,
      findings: phaseFindings,
      summary: phaseSummary,
      adapterInvocations,
      estimatedTokens: adapterInvocations * ESTIMATED_TOKENS_PER_INVOCATION,
    };

    await saveEmbraceRun?.(run);
    onProgress?.(phaseType, 'completed', phaseSummary);

    // Gate check: pause if below threshold (and not a mandatory checkpoint that already paused)
    if (!autoProceeded && phaseType !== 'checkpoint') {
      run.status = 'paused';
      run.currentPhaseIndex = i + 1;
      await saveEmbraceRun?.(run);
      onProgress?.(phaseType, 'paused', `Gate failed: score ${phaseScore} < threshold ${threshold}`);

      const partialReport = buildEmbraceReport(task, researchData, debateData, reviewData, securityData, phaseScores);
      return { runId: run.id, run, report: partialReport };
    }
  }

  // Step 3: Complete the run
  run.status = 'completed';
  run.completedAt = nowIso();
  await saveEmbraceRun?.(run);

  const report = buildEmbraceReport(task, researchData, debateData, reviewData, securityData, phaseScores);

  return { runId: run.id, run, report };
}

// ─── Report builder ───────────────────────────────────────────────────────────

function buildEmbraceReport(
  task: string,
  researchData: ResearchPhaseData,
  debateData: DebatePhaseData,
  reviewData: ReviewPhaseData,
  securityData: SecurityPhaseData,
  phaseScores: Partial<Record<EmbracePhaseType, number>>,
): EmbraceReport {
  const scoreValues = Object.values(phaseScores).filter((s) => typeof s === 'number');
  const overallScore =
    scoreValues.length > 0 ? Math.round(scoreValues.reduce((sum, s) => sum + s, 0) / scoreValues.length) : 0;

  const recommendations: string[] = [];

  if (reviewData.criticalCount > 0) {
    recommendations.push(`Address ${reviewData.criticalCount} critical review finding(s) before proceeding.`);
  }
  if (securityData.p0Count > 0) {
    recommendations.push(`Fix ${securityData.p0Count} P0 security vulnerability/vulnerabilities immediately.`);
  }
  if (securityData.p1Count > 0) {
    recommendations.push(`Resolve ${securityData.p1Count} P1 security finding(s) in the next sprint.`);
  }
  if (debateData.agreementsCount === 0 && debateData.novelInsightsCount === 0) {
    recommendations.push('Revisit the debate phase — no consensus or novel insights were generated.');
  }
  if (overallScore >= 80) {
    recommendations.push('Overall quality is high. Ready to proceed with confidence.');
  }

  return {
    task,
    researchSummary: researchData.summary || 'Research phase not completed.',
    debateOutcome: debateData.summary || 'Debate phase not completed.',
    reviewFindings: reviewData.findings,
    securityFindings: securityData.findings,
    overallScore,
    recommendations,
  };
}
