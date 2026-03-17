// ─── Legacy domain interfaces (preserved for backward compatibility) ──────────

import type { Finding, InterpretResult, ManagerResult, ResultIndex } from '@mmbridge/core';
import type { HandoffArtifact, RecallEntrySummary } from '@mmbridge/session-store';

export interface DoctorReport {
  generatedAt: string;
  checks: Array<{ binary: string; installed: boolean }>;
  mmbridgeHome: string;
  claudeAgentsDir: string;
  runtimeAuthModel: string;
  sessionFileHints: Record<string, string>;
}

export interface ReviewReport {
  tool?: string;
  mode?: string;
  status?: string;
  localSessionId?: string;
  externalSessionId?: string;
  workspace?: string;
  summary?: string;
  findings?: Finding[];
  resultIndex?: ResultIndex;
  changedFiles?: string | number;
  copiedFiles?: string | number;
  followupSupported?: boolean;
  toolResults?: Array<{
    tool: string;
    findingCount: number;
    skipped: boolean;
    error?: string;
  }>;
  interpretation?: InterpretResult;
  manager?: ManagerResult;
  recalledMemorySummary?: string;
  recalledMemoryHits?: RecallEntrySummary[];
  handoff?: HandoffArtifact | null;
  handoffPath?: string | null;
  nextPrompt?: string;
  nextCommand?: string;
}
