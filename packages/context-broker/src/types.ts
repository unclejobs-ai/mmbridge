export type ContextNodeType =
  | 'task'
  | 'recall'
  | 'review'
  | 'research'
  | 'debate'
  | 'handoff'
  | 'compaction'
  | 'security'
  | 'gate';

export interface ContextNode {
  id: string;
  parentId: string | null;
  timestamp: number;
  type: ContextNodeType;
  summary: string;
  data: Record<string, unknown>;
  projectKey: string;
}

export interface RecallEntry {
  source: 'session' | 'handoff' | 'memory' | 'tree';
  id: string;
  relevance: number;
  summary: string;
  tokenCount: number;
}

export interface ContextPacket {
  project: string;
  task: string;
  treeLeafId: string;
  projectState: {
    branch: string;
    recentDiff: string;
    fileHotspots: string[];
  };
  alwaysOnMemory: string;
  recalledSessions: RecallEntry[];
  recalledHandoffs: RecallEntry[];
  recalledMemory: RecallEntry[];
  recalledTree: RecallEntry[];
  totalRecallTokens: number;
  recallBudget: number;
  gateWarnings: string[];
  freshness: 'fresh' | 'stale' | 'expired';
  suggestedCommand: string;
  suggestedAdapters: string[];
}

export type RecallBudgets = Record<string, number>;

export const DEFAULT_RECALL_BUDGETS: RecallBudgets = {
  review: 2000,
  research: 4000,
  debate: 3000,
  embrace: 6000,
  security: 2000,
  default: 2000,
};

export type BrokerEvent = 'before_context' | 'after_context' | 'on_recall';

export type BrokerEventHandler = (event: BrokerEvent, data: Record<string, unknown>) => void | Promise<void>;

export interface AssembleOptions {
  projectDir: string;
  task: string;
  command: string;
  parentNodeId?: string;
  recallBudget?: number;
}
