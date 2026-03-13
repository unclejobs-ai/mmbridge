export type {
  Severity,
  Finding,
  HeadMeta,
  RunResult,
  RunCommandOptions,
  ContextWorkspace,
  CreateContextOptions,
  RedactionResult,
  RedactContentResult,
  GitStatusSummary,
  ProjectContext,
  ContextIndex,
  SeverityCounts,
  TopFile,
  ResultIndex,
  BridgeResult,
  BridgeOptions,
  EnrichResult,
  BuildContextIndexInput,
  BuildResultIndexInput,
  BuildProjectContextOptions,
  FileCategory,
} from './types.js';

export {
  runCommand,
  commandExists,
  ensureDir,
  projectSlug,
  classifyFile,
  isPotentialSecretFile,
  isBinaryExtension,
  safeRead,
  limitBytes,
  nowIso,
} from './utils.js';

export {
  getHead,
  getChangedFiles,
  getStagedFiles,
  getUnstagedFiles,
  getUntrackedFiles,
  getGitStatusSummary,
  getDiff,
  getDefaultBaseRef,
  getDiffFileCount,
} from './git.js';

export { redactContent, redactFile, redactWorkspace } from './redaction.js';

export {
  sortFindings,
  deduplicateFindings,
  filterScopeFindings,
  promoteLowConfidence,
  enrichFindings,
  formatFindingsText,
} from './report.js';

export { buildProjectContext, formatProjectContext } from './project-context.js';

export { buildContextIndex, buildResultIndex } from './session-index.js';

export { createContext, cleanupContext } from './context.js';

export { runBridge, mergeBridgeFindings } from './bridge.js';
