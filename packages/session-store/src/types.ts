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
  findings?: Array<Record<string, unknown>>;
  contextIndex?: Record<string, unknown> | null;
  resultIndex?: Record<string, unknown> | null;
  followupSupported?: boolean;
  status?: string;
}

export interface SessionListOptions {
  tool?: string;
  projectDir?: string;
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
