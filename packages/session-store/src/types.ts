import type { ContextIndex, Finding, InterpretResult, ResultIndex } from '@mmbridge/core';

export interface SessionToolResult {
  tool: string;
  findingCount: number;
  skipped: boolean;
  error?: string;
}

export type FindingDecisionStatus = 'accepted' | 'dismissed';

export interface SessionFindingDecision {
  key: string;
  status: FindingDecisionStatus;
  updatedAt: string;
}

export interface Session {
  id: string;
  tool: string;
  mode: string;
  batchId?: string | null;
  createdAt: string;
  projectDir: string;
  workspace: string;
  externalSessionId?: string | null;
  parentSessionId?: string | null;
  runId?: string | null;
  resumeSourceSessionId?: string | null;
  resumeAction?: 'followup' | 'rerun' | 'bridge-rerun' | null;
  command?: string;
  args?: string[];
  baseRef?: string;
  head?: { sha: string; branch: string };
  rawOutput?: string;
  summary?: string;
  findings?: Finding[];
  contextIndex?: ContextIndex | null;
  resultIndex?: ResultIndex | null;
  toolResults?: SessionToolResult[];
  interpretation?: InterpretResult | null;
  findingDecisions?: SessionFindingDecision[];
  recalledMemoryIds?: string[];
  handoffId?: string | null;
  handoffPath?: string | null;
  contextDigest?: string | null;
  diffDigest?: string | null;
  handoffSummary?: string | null;
  followupSupported?: boolean;
  status?: string;
}

export interface SessionListOptions {
  tool?: string;
  projectDir?: string;
  mode?: string;
  query?: string;
  file?: string;
  severity?: string;
  limit?: number;
}

export interface ProjectState {
  id: string;
  projectDir: string;
  intent?: string | null;
  defaultMode?: string;
  bridgeAgent?: string;
  preferredBaseRef?: string;
  updatedAt: string;
}

export type MemoryEntryType = 'decision' | 'finding' | 'fix' | 'blocker' | 'command' | 'file_hotspot' | 'followup_goal';

export interface HandoffArtifact {
  id: string;
  sessionId: string;
  projectKey: string;
  createdAt: string;
  markdownPath: string;
  jsonPath: string;
  summary: string;
  objective: string;
  nextPrompt: string;
  nextCommand: string;
  openBlockers: string[];
}

export interface HandoffDocument {
  artifact: HandoffArtifact;
  tool: string;
  mode: string;
  status?: string;
  projectDir: string;
  baseRef?: string;
  head?: { sha: string; branch: string };
  summary: string;
  findings: Finding[];
  contextDigest?: string | null;
  contextSummary?: string | null;
  bridgeSummary?: string | null;
  interpretationSummary?: string | null;
  recalledMemoryIds: string[];
  recalledMemorySummary?: string | null;
  recalledMemory: MemoryEntry[];
  recommendedNextPrompt: string;
  recommendedNextCommand: string;
}

export interface MemoryEntry {
  id: string;
  projectKey: string;
  type: MemoryEntryType;
  title: string;
  content: string;
  createdAt: string;
  sessionId?: string | null;
  handoffId?: string | null;
  file?: string | null;
  line?: number | null;
  severity?: string | null;
  branch?: string | null;
  metadata?: Record<string, unknown>;
}

export interface MemorySearchOptions {
  projectDir: string;
  query: string;
  type?: MemoryEntryType;
  limit?: number;
}

export interface MemoryTimelineOptions {
  projectDir: string;
  sessionId?: string;
  query?: string;
  limit?: number;
}

export interface RecallEntrySummary {
  id: string;
  type: MemoryEntryType;
  title: string;
  file?: string | null;
  severity?: string | null;
}

export interface RecallResult {
  projectKey: string;
  latestHandoff: HandoffArtifact | null;
  latestHandoffDocument: HandoffDocument | null;
  recalledMemoryIds: string[];
  memoryHits: RecallEntrySummary[];
  blockers: RecallEntrySummary[];
  summary: string;
  promptContext: string;
}
