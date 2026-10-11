import type { ProviderQuota } from './quota.js';

/** L3 = mechanical worker models; premium = Opus/Sol/Astra/Fable (L0–L2 only); unknown = not attributable. */
export type ModelTier = 'L3' | 'premium' | 'unknown';

export interface ModelClass {
  tier: ModelTier;
  /** omp provider id from a `provider/model` selector, or inferred; null when unknown. */
  provider: string | null;
}

export interface AuditLane {
  /** herdr pane id or ledger run id. */
  id: string;
  source: 'herdr' | 'ledger';
  /** Harness/agent program: omp, pi, devin, grok, claude, codex, ... */
  harness: string;
  /** `provider/model` when known. */
  model: string | null;
  tier: ModelTier;
  provider: string | null;
  status: 'working' | 'idle' | 'done' | 'blocked' | 'unknown';
  cwd: string | null;
  title: string | null;
  /** Card kind when known (mech/design/review/vision/research). */
  cardKind: string | null;
  /** Where cardKind came from: ledger card row or title keyword heuristic. */
  cardKindSource: 'ledger' | 'title' | null;
  /** Epoch ms of last observed output (transcript/log mtime); null when unknown. */
  lastOutputAt: number | null;
  /** Work finished (report written / process exited / omp yielded) but the session is still open. */
  finished: boolean;
}

export interface VisionVerdict {
  card: string;
  auditorModel: string;
  auditorLayer: string;
}

export interface AuditInput {
  now: number;
  lanes: AuditLane[];
  quota: ProviderQuota[];
  visionVerdicts?: VisionVerdict[];
  /** Default 30 min. */
  stallMs?: number;
  /** Default 0.6 (APS §14 placement rule). */
  minL3Ratio?: number;
}

export type ViolationCode =
  | 'L3_RATIO'
  | 'MECH_ON_PREMIUM'
  | 'L3_VISION_VERDICT'
  | 'EXHAUSTED_PROVIDER'
  | 'STALLED'
  | 'FINISHED_OPEN';

export interface AuditViolation {
  code: ViolationCode;
  lane: string | null;
  card: string | null;
  detail: string;
}

export interface AuditReport {
  generatedAt: string;
  lanes: AuditLane[];
  byModel: Array<{ model: string; tier: ModelTier; working: number; idle: number }>;
  workingLanes: number;
  l3Working: number;
  /** l3Working / workingLanes; null when no working lanes. */
  l3Ratio: number | null;
  quota: ProviderQuota[];
  stalled: AuditLane[];
  finishedOpen: AuditLane[];
  violations: AuditViolation[];
}

export function classifyModel(_model: string | null): ModelClass {
  throw new Error('unimplemented: FOREMAN-L3-AUDIT');
}

export function mechanicalTitle(_title: string | null): boolean {
  throw new Error('unimplemented: FOREMAN-L3-AUDIT');
}

export function buildAudit(_input: AuditInput): AuditReport {
  throw new Error('unimplemented: FOREMAN-L3-AUDIT');
}

export function renderAuditMarkdown(_report: AuditReport): string {
  throw new Error('unimplemented: FOREMAN-L3-AUDIT');
}
