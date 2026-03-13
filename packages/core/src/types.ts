export type Severity = 'CRITICAL' | 'WARNING' | 'INFO' | 'REFACTOR';

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

export interface BridgeResult {
  profile: string;
  totalInputs: number;
  consensusFindings: number;
  counts: Record<string, number>;
  findings: Finding[];
  summary: string;
}

export interface BridgeOptions {
  profile?: string;
  projectContext?: Partial<ProjectContext>;
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

export type FileCategory = 'Backend' | 'API Route' | 'UI Component' | 'State' | 'Library' | 'Page/Layout' | 'Other';
