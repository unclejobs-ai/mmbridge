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
