export { ADAPTER_NAMES } from './types.js';
export type {
  AdapterName,
  Severity,
  Finding,
  HeadMeta,
  RunResult,
  RunCommandOptions,
  ContextWorkspace,
  CreateContextOptions,
  RedactionResult,
  RedactContentResult,
  GitStatusSummary,
  ProjectContext,
  ContextIndex,
  SeverityCounts,
  TopFile,
  ResultIndex,
  BridgeResult,
  BridgeOptions,
  InterpretResult,
  EnrichResult,
  BuildContextIndexInput,
  BuildResultIndexInput,
  BuildProjectContextOptions,
  FileClassifierRule,
  MmbridgeConfig,
  ReviewRunStatus,
  ReviewRunPhase,
  ToolLaneStatus,
  ToolLane,
  ReviewRun,
  GateStatus,
  GateWarningCode,
  GateWarning,
  GateResult,
  GateCurrentSnapshot,
  GateSessionSnapshot,
  GateHandoffSnapshot,
  GateEvaluationInput,
  ResumeAction,
  ResumeRecommendation,
  ResumeSessionSnapshot,
  ResumeRecommendationInput,
  ResumeResult,
  ResearchType,
  InsightConfidence,
  ResearchInsight,
  ResearchReport,
  ResearchRunPhase,
  DebateRoundType,
  DebatePosition,
  DebateRound,
  DebateVerdict,
  DebateTranscript,
  DebateRunPhase,
  SecuritySeverity,
  SecurityScope,
  CweMapping,
  SecurityFinding,
  AttackSurfaceEntry,
  SecurityReport,
  SecurityRunPhase,
} from './types.js';

export {
  runCommand,
  commandExists,
  ensureDir,
  projectSlug,
  classifyFile,
  isPotentialSecretFile,
  isBinaryExtension,
  safeRead,
  limitBytes,
  nowIso,
  shortDigest,
  parseCodexAgentMessages,
} from './utils.js';

export {
  getHead,
  getChangedFiles,
  getStagedFiles,
  getUnstagedFiles,
  getUntrackedFiles,
  getGitStatusSummary,
  getDiff,
  getDefaultBaseRef,
  getDiffFileCount,
} from './git.js';

export { redactContent, redactFile, redactWorkspace } from './redaction.js';

export {
  sortFindings,
  deduplicateFindings,
  filterScopeFindings,
  promoteLowConfidence,
  enrichFindings,
  formatFindingsText,
} from './report.js';

export { buildProjectContext, formatProjectContext } from './project-context.js';

export { buildContextIndex, buildResultIndex } from './session-index.js';

export { createContext, cleanupContext } from './context.js';

export { runBridge, mergeBridgeFindings } from './bridge.js';

export { parseFindings, detectParseState } from './finding-parser.js';

export { orchestrateReview } from './orchestrate.js';
export type { OrchestrateOptions, OrchestrateResult, ToolResult } from './orchestrate.js';

export { runReviewPipeline } from './review-pipeline.js';
export type { ReviewPipelineOptions, ReviewPipelineResult } from './review-pipeline.js';

export { runResearchPipeline } from './research-pipeline.js';
export type { ResearchPipelineOptions, ResearchPipelineResult } from './research-pipeline.js';

export { runDebatePipeline } from './debate-pipeline.js';
export type { DebatePipelineOptions, DebatePipelineResult } from './debate-pipeline.js';

export { buildRoundPrompt, parsePositions, computeVerdict } from './debate-rounds.js';

export { synthesizeResearch } from './research-synthesize.js';
export type { SynthesizeInput } from './research-synthesize.js';

export {
  deriveRunStatus,
  evaluateGate,
  hasUnresolvedCritical,
  isFreshRun,
  recommendResumeAction,
} from './operations.js';

export { interpretFindings } from './interpret.js';

export { exportReport } from './export.js';
export type { ExportableReport } from './export.js';

export {
  loadConfig,
  saveConfig,
  resolveClassifiers,
  classifyFileWithRules,
  DEFAULT_CLASSIFIERS,
} from './config.js';

export { writeLiveState, readLiveState, clearLiveState, getLiveStatePath } from './live-state.js';
export type { LiveState } from './live-state.js';

export { runSecurityPipeline } from './security-pipeline.js';
export type { SecurityPipelineOptions, SecurityPipelineResult } from './security-pipeline.js';

export { classifyFindings, buildAttackSurface, CWE_DATABASE } from './security-cwe.js';
export type { CweEntry } from './security-cwe.js';

export { runEmbracePipeline } from './embrace-pipeline.js';
export type { EmbracePipelineOptions, EmbracePipelineResult } from './embrace-pipeline.js';

// Embrace types
export type {
  EmbracePhaseType,
  EmbracePhaseStatus,
  EmbracePhaseGate,
  EmbracePhase,
  EmbraceCheckpoint,
  EmbraceConfig,
  EmbraceRun,
  EmbraceReport,
} from './types.js';
