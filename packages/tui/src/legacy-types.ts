// ─── Legacy domain interfaces (preserved for backward compatibility) ──────────

export interface DashboardModel {
  tool: string;
  binary: string;
  installed: boolean | null;
  totalSessions: number;
  latestMode: string | null;
  latestCreatedAt: string | null;
  latestSummary: string | null;
  latestExternalSessionId: string | null;
  latestResultIndex: Record<string, unknown> | null;
  latestContextIndex: Record<string, unknown> | null;
  latestBatchId: string | null;
  latestFollowupSupported?: boolean;
  latestFollowupLocalSessionId?: string | null;
  latestFollowupExternalSessionId?: string | null;
  aggregateStats: Record<string, number> | null;
}

export interface DashboardSession {
  id: string;
  tool: string;
  mode: string;
  batchId?: string | null;
  projectDir?: string;
  externalSessionId?: string | null;
  parentSessionId?: string | null;
  createdAt?: string;
  summary?: string;
  findings?: Array<{ severity?: string; file?: string; line?: number; message?: string }>;
  contextIndex?: Record<string, unknown> | null;
  resultIndex?: Record<string, unknown> | null;
}

export interface DashboardData {
  modeFilter: string;
  models: DashboardModel[];
  sessions: DashboardSession[];
  projectDir: string;
  projectState: Record<string, unknown> | null;
  projectContext: Record<string, unknown> | null;
}

export interface DashboardPayload {
  sessions?: DashboardSession[];
  models?: DashboardModel[];
  modeFilter?: string;
  projectDir?: string;
  projectState?: Record<string, unknown>;
  projectContext?: Record<string, unknown>;
  ui?: string;
}

export interface SummaryRow {
  key: string;
  value: string;
}

export interface DoctorReport {
  generatedAt: string;
  checks: Array<{ binary: string; installed: boolean }>;
  mmbridgeHome: string;
  claudeAgentsDir: string;
  runtimeAuthModel: string;
  sessionFileHints: Record<string, string>;
}

export interface ReviewReport {
  localSessionId?: string;
  externalSessionId?: string;
  workspace?: string;
  summary?: string;
  findings?: Array<{ severity?: string; file?: string; line?: number; message?: string }>;
  resultIndex?: Record<string, unknown>;
  changedFiles?: string | number;
  copiedFiles?: string | number;
  followupSupported?: boolean;
}
