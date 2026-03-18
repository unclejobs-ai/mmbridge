export type Severity = 'CRITICAL' | 'WARNING' | 'INFO' | 'REFACTOR';

/** Canonical tool list — single source of truth across all packages */
export const ADAPTER_NAMES = ['kimi', 'qwen', 'codex', 'gemini', 'droid', 'claude'] as const;
export type AdapterName = (typeof ADAPTER_NAMES)[number];

export interface Finding {
  severity: Severity;
  file: string;
  line: number | null;
  message: string;
  raw?: string;
  sources?: string[];
  confidence?: 'high' | 'medium';
  scopeHint?: string;
}

export interface HeadMeta {
  sha: string;
  branch: string;
}

export interface RunResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
  combined: string;
}

export interface RunCommandOptions {
  cwd?: string;
  input?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  killGraceMs?: number;
  /** Called with each stdout chunk as it arrives */
  onStdout?: (chunk: string) => void;
  /** Called with each stderr chunk as it arrives */
  onStderr?: (chunk: string) => void;
}

export interface ContextWorkspace {
  workspace: string;
  mode: string;
  projectDir: string;
  baseRef: string | undefined;
  diffDigest: string;
  changedFiles: string[];
  copiedFileCount: number;
  contextPath: string;
  diffPath: string;
  promptPaths: string[];
  redaction: RedactionResult;
  head: HeadMeta;
}

export interface CreateContextOptions {
  projectDir?: string;
  mode?: string;
  baseRef?: string;
  commit?: string;
  maxContextBytes?: number;
  tools?: string[];
  recallPromptContext?: string;
  recallSummary?: string;
}

export interface RedactionResult {
  changedFiles: number;
  usedRuleCount: number;
}

export interface RedactContentResult {
  redacted: string;
  stats: string[];
}

export interface GitStatusSummary {
  staged: number;
  unstaged: number;
  untracked: number;
  clean: boolean;
}

export interface ProjectContext {
  projectDir: string;
  head: HeadMeta;
  baseRef: string;
  gitStatus: GitStatusSummary;
  uncommittedCount: number;
  baseDiffCount: number;
  totalSessions: number;
  modeCount: Record<string, number>;
  toolCount: Record<string, number>;
  lastSessionAt: string | null;
}

export interface ContextIndex {
  workspaceId: string | null;
  projectDir: string | null;
  projectSlug: string | null;
  mode: string | null;
  baseRef: string | null;
  diffDigest: string | null;
  head: HeadMeta | null;
  changedFiles: number;
  copiedFiles: number;
  categoryCounts: Record<string, number>;
  changedSample: string[];
  redaction: RedactionResult | null;
}

export interface SeverityCounts {
  CRITICAL: number;
  WARNING: number;
  INFO: number;
  REFACTOR: number;
}

export interface TopFile {
  file: string;
  count: number;
}

export interface ResultIndex {
  summary: string;
  parseState: string;
  findingsTotal: number;
  severityCounts: SeverityCounts;
  filesTouched: number;
  topFiles: TopFile[];
  filteredCount: number;
  promotedCount: number;
  followupSupported: boolean;
  outputDigest: string | null;
  hasBridge: boolean;
  bridgeSummary: string | null;
}

export interface InterpretResult {
  validated: Finding[];
  falsePositives: Array<{ finding: Finding; reason: string }>;
  promoted: Finding[];
  actionPlan: string;
  interpreterTool: string;
}

export interface BridgeResult {
  profile: string;
  totalInputs: number;
  consensusFindings: number;
  counts: Record<string, number>;
  findings: Finding[];
  summary: string;
  interpretation?: InterpretResult;
}

export interface BridgeOptions {
  profile?: string;
  projectContext?: Partial<ProjectContext>;
  interpret?: boolean;
  workspace?: string;
  changedFiles?: string[];
  results?: Array<{
    tool: string;
    findings?: Finding[];
    summary?: string;
    skipped?: boolean;
  }>;
}

export interface EnrichResult {
  findings: Finding[];
  filteredCount: number;
  promotedCount: number;
  summary: string;
}

export interface BuildContextIndexInput {
  workspace?: string;
  projectDir?: string;
  mode?: string;
  baseRef?: string;
  diffDigest?: string;
  head?: HeadMeta;
  changedFiles?: string[];
  copiedFileCount?: number;
  redaction?: RedactionResult;
}

export interface BuildResultIndexInput {
  summary?: string;
  findings?: Finding[];
  filteredCount?: number;
  promotedCount?: number;
  followupSupported?: boolean;
  rawOutput?: string;
  parseState?: string;
  bridgeSummary?: string;
}

export interface BuildProjectContextOptions {
  projectDir?: string;
  sessions?: Array<{ tool?: string; mode?: string; createdAt?: string }>;
  preferredBaseRef?: string;
}

export interface FileClassifierRule {
  pattern: string;
  category: string;
}

export interface MmbridgeConfig {
  /** Custom file classifier rules (matched by path prefix) */
  classifiers?: FileClassifierRule[];
  /** If true (default), custom classifiers are prepended to built-in defaults. Set false to replace entirely. */
  extendDefaultClassifiers?: boolean;
  /** Adapter-specific configuration overrides */
  adapters?: Record<
    string,
    {
      /** Override the binary/command name */
      command?: string;
      /** Override default CLI arguments */
      args?: string[];
      /** npm package or file path to load as a third-party adapter */
      module?: string;
    }
  >;
  /** Extra redaction rules beyond built-in patterns */
  redaction?: {
    extraRules?: Array<{ pattern: string; replacement: string; label: string }>;
  };
  /** Context workspace limits */
  context?: {
    maxBytes?: number;
  };
  /** Bridge defaults for multi-tool review */
  bridge?: {
    mode?: 'standard' | 'interpreted';
    profile?: 'standard' | 'strict' | 'relaxed';
  };
}

export type ReviewRunStatus = 'queued' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled';

export type ReviewRunPhase = 'recall' | 'context' | 'review' | 'bridge' | 'interpret' | 'enrich' | 'handoff';

export type ToolLaneStatus = 'queued' | 'running' | 'done' | 'error' | 'timed_out' | 'skipped' | 'cancelled';

export interface ToolLane {
  tool: string;
  status: ToolLaneStatus;
  attempt: number;
  startedAt: string | null;
  completedAt: string | null;
  error?: string | null;
  findingCount: number;
  externalSessionId: string | null;
  followupSupported: boolean;
}

export interface ReviewRun {
  id: string;
  tool: string;
  mode: string;
  projectDir: string;
  baseRef: string | null;
  diffDigest: string | null;
  changedFiles: number;
  status: ReviewRunStatus;
  phase: ReviewRunPhase;
  startedAt: string;
  completedAt: string | null;
  findingsSoFar: number;
  warnings: string[];
  sessionId: string | null;
  lanes: ToolLane[];
}

export type GateStatus = 'pass' | 'warn';

export type GateWarningCode =
  | 'stale-review'
  | 'unresolved-critical'
  | 'coverage-gap'
  | 'bridge-gap'
  | 'unable-to-evaluate';

export interface GateWarning {
  code: GateWarningCode;
  message: string;
  nextCommand: string;
}

export interface GateResult {
  status: GateStatus;
  warnings: GateWarning[];
}

export interface GateCurrentSnapshot {
  projectDir: string;
  mode: string;
  baseRef: string | null;
  diffDigest: string | null;
  changedFilesCount: number;
  explicitMode: boolean;
}

export interface GateSessionSnapshot {
  id?: string;
  tool: string;
  mode: string;
  externalSessionId?: string | null;
  followupSupported?: boolean;
  findings: Finding[];
  findingDecisions?: Array<{ key: string; status: 'accepted' | 'dismissed' }>;
}

export interface GateHandoffSnapshot {
  artifact?: {
    sessionId: string;
    nextCommand: string;
    openBlockers: string[];
  };
  recommendedNextCommand?: string | null;
}

export interface GateEvaluationInput {
  current: GateCurrentSnapshot;
  latestRun: ReviewRun | null;
  latestSession: GateSessionSnapshot | null;
  latestHandoff: GateHandoffSnapshot | null;
}

export type ResumeAction = 'followup' | 'rerun' | 'bridge-rerun';

export interface ResumeRecommendation {
  action: ResumeAction;
  reason: string;
}

export interface ResumeSessionSnapshot {
  id: string;
  tool: string;
  mode: string;
  projectDir: string;
  externalSessionId: string | null;
  followupSupported?: boolean;
  findings: Finding[];
  summary?: string;
}

export interface ResumeRecommendationInput {
  latestRun: ReviewRun | null;
  latestSession: ResumeSessionSnapshot | null;
  latestHandoff: GateHandoffSnapshot | null;
  gateResult: GateResult;
}

export interface ResumeResult {
  recommended: ResumeRecommendation | null;
  alternatives: ResumeAction[];
  summary: string;
  readOnly: boolean;
}

// ─── Research Mode Types ─────────────────────────────────────────────────────

export type ResearchType = 'code-aware' | 'open';

export type InsightConfidence = 'high' | 'medium' | 'low';

export interface ResearchInsight {
  id: string;
  content: string;
  sources: string[];
  confidence: InsightConfidence;
  category: 'consensus' | 'unique' | 'contradiction';
  tags?: string[];
  positions?: Array<{ source: string; position: string }>;
}

export interface ResearchReport {
  topic: string;
  type: ResearchType;
  consensus: ResearchInsight[];
  uniqueInsights: Record<string, ResearchInsight[]>;
  contradictions: ResearchInsight[];
  summary: string;
  modelContributions: Record<string, { insightCount: number; uniqueCount: number }>;
  generatedAt: string;
}

export type ResearchRunPhase = 'context' | 'research' | 'synthesize' | 'report' | 'handoff';

// ─── Debate Mode Types ───────────────────────────────────────────────────────

export type DebateRoundType = 'position' | 'cross-examination' | 'synthesis';

export interface DebatePosition {
  source: string;
  stance: 'for' | 'against' | 'nuanced';
  arguments: string[];
  evidence: string[];
  confidence: InsightConfidence;
  rawText: string;
}

export interface DebateRound {
  roundNumber: number;
  type: DebateRoundType;
  positions: DebatePosition[];
  agreements?: string[];
  disagreements?: string[];
}

export interface DebateVerdict {
  conclusion: string;
  agreements: string[];
  disagreements: string[];
  novelInsights: string[];
  recommendedAction: string;
}

export interface DebateTranscript {
  proposition: string;
  teams?: { for: string[]; against: string[] };
  rounds: DebateRound[];
  verdict: DebateVerdict;
  totalRounds: number;
  generatedAt: string;
}

export type DebateRunPhase = 'context' | 'round' | 'verdict' | 'handoff';

// ─── Security Mode Types ─────────────────────────────────────────────────────

export type SecuritySeverity = 'P0' | 'P1' | 'P2' | 'P3';

export type SecurityScope = 'auth' | 'api' | 'infra' | 'all';

export interface CweMapping {
  id: string;
  name: string;
  owaspCategory?: string;
}

export interface SecurityFinding extends Finding {
  securitySeverity: SecuritySeverity;
  cwe: CweMapping[];
  attackVector?: string;
  exploitability: 'immediate' | 'with-effort' | 'theoretical' | 'best-practice';
  remediation: {
    description: string;
    codeSnippet?: string;
    effort: 'low' | 'medium' | 'high';
  };
  complianceTags?: Array<'GDPR' | 'HIPAA' | 'SOC2' | 'PCI-DSS'>;
  scope: SecurityScope;
  dataFlow?: string;
}

export interface AttackSurfaceEntry {
  entryPoint: string;
  type: 'api-route' | 'form-input' | 'file-upload' | 'websocket' | 'webhook' | 'cron' | 'config';
  authRequired: boolean;
  dataFlows: string[];
  trustBoundary: string;
}

export interface SecurityReport {
  profile: string;
  scope: SecurityScope;
  totalInputs: number;
  findings: SecurityFinding[];
  attackSurface: AttackSurfaceEntry[];
  summary: string;
  severityCounts: Record<SecuritySeverity, number>;
  complianceSummary: Record<string, number>;
  interpretation?: InterpretResult;
}

export type SecurityRunPhase = 'recall' | 'context' | 'scan' | 'bridge' | 'classify' | 'surface' | 'report' | 'handoff';

// ─── Embrace Mode Types ──────────────────────────────────────────────────────

export type EmbracePhaseType = 'research' | 'debate' | 'checkpoint' | 'review' | 'security' | 'report';

export type EmbracePhaseStatus = 'pending' | 'running' | 'completed' | 'paused' | 'skipped' | 'failed';

export interface EmbracePhaseGate {
  score: number;
  threshold: number;
  reasons: string[];
  autoProceeded: boolean;
}

export interface EmbracePhase {
  type: EmbracePhaseType;
  status: EmbracePhaseStatus;
  sessionId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  gate: EmbracePhaseGate | null;
  findings: Finding[];
  summary: string;
  adapterInvocations: number;
  estimatedTokens: number;
  error?: string;
}

export interface EmbraceCheckpoint {
  id: string;
  phaseType: EmbracePhaseType;
  prompt: string;
  context: string;
  options: string[];
  resolvedAt: string | null;
  resolution: string | null;
}

export interface EmbraceConfig {
  phases: EmbracePhaseType[];
  gateThresholds: Partial<Record<EmbracePhaseType, number>>;
  mandatoryCheckpoints: EmbracePhaseType[];
  toolPreferences: Partial<Record<EmbracePhaseType, string>>;
  bridgeProfile: 'standard' | 'strict' | 'relaxed';
  adaptiveRouting: boolean;
}

export interface EmbraceRun {
  id: string;
  task: string;
  projectDir: string;
  baseRef: string | null;
  status: 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  phases: EmbracePhase[];
  checkpoints: EmbraceCheckpoint[];
  currentPhaseIndex: number;
  startedAt: string;
  completedAt: string | null;
  totalAdapterInvocations: number;
  totalEstimatedTokens: number;
  adaptiveInsertions: string[];
  config: EmbraceConfig;
}

export interface EmbraceReport {
  task: string;
  researchSummary: string;
  debateOutcome: string;
  reviewFindings: Finding[];
  securityFindings: SecurityFinding[];
  overallScore: number;
  recommendations: string[];
}
