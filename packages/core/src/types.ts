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
