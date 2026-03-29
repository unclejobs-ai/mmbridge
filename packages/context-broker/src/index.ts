export { ContextTree, projectKeyFromDir } from './context-tree.js';
export { RecallEngine } from './recall-engine.js';
export { ContextAssembler } from './context-assembler.js';
export { BrokerEventBus } from './events.js';
export { compactSubtree, autoCompact } from './compaction.js';
export { DEFAULT_RECALL_BUDGETS } from './types.js';

export type {
  AssembleOptions,
  BrokerEvent,
  BrokerEventHandler,
  ContextNode,
  ContextNodeType,
  ContextPacket,
  RecallBudgets,
  RecallEntry,
} from './types.js';

export type {
  CompactionAdapter,
  CompactSubtreeOptions,
  AutoCompactOptions,
} from './compaction.js';
