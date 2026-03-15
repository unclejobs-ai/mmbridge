import type { ContextIndex, ResultIndex } from '@mmbridge/core';
import type { Session } from '@mmbridge/session-store';
import type { FindingItem } from '../store.js';

// ─── Public interfaces ────────────────────────────────────────────────────────

export interface SessionStats {
  /** Session counts for the last 7 days: [0] = today, [6] = 6 days ago */
  dailyCounts: number[];
  totalFindings: number;
  aggregateSeverity: { critical: number; warning: number; info: number; refactor: number };
  /** Map of tool name → number of sessions using that tool */
  toolDistribution: Record<string, number>;
}

export interface GroupedFindings {
  file: string;
  findings: FindingItem[];
}

// ─── computeSessionStats ─────────────────────────────────────────────────────

/**
 * Compute 7-day rolling statistics from a list of sessions.
 * dailyCounts[0] = today, dailyCounts[6] = 6 days ago.
 */
export function computeSessionStats(sessions: Session[]): SessionStats {
  const now = new Date();
  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

  const dailyCounts = new Array<number>(7).fill(0);
  const aggregateSeverity = { critical: 0, warning: 0, info: 0, refactor: 0 };
  const toolDistribution: Record<string, number> = {};

  for (const session of sessions) {
    // --- daily bucketing ---
    const sessionDate = new Date(session.createdAt);
    const sessionMidnight = new Date(
      sessionDate.getFullYear(),
      sessionDate.getMonth(),
      sessionDate.getDate(),
    ).getTime();

    const daysAgo = Math.round((todayMidnight - sessionMidnight) / 86_400_000);
    if (daysAgo >= 0 && daysAgo < 7) {
      dailyCounts[daysAgo] = (dailyCounts[daysAgo] ?? 0) + 1;
    }

    // --- tool distribution ---
    toolDistribution[session.tool] = (toolDistribution[session.tool] ?? 0) + 1;

    // --- severity aggregation ---
    const findings = session.findings ?? [];
    for (const f of findings) {
      const sev = (f.severity ?? 'INFO').toUpperCase();
      if (sev === 'CRITICAL') {
        aggregateSeverity.critical++;
      } else if (sev === 'WARNING') {
        aggregateSeverity.warning++;
      } else if (sev === 'REFACTOR') {
        aggregateSeverity.refactor++;
      } else {
        aggregateSeverity.info++;
      }
    }
  }

  const totalFindings =
    aggregateSeverity.critical + aggregateSeverity.warning + aggregateSeverity.info + aggregateSeverity.refactor;

  return { dailyCounts, totalFindings, aggregateSeverity, toolDistribution };
}

// ─── buildAncestryChain ──────────────────────────────────────────────────────

/**
 * Follow externalSessionId links backward through the sessions list,
 * returning the ordered chain of session IDs from oldest ancestor to current.
 * The currentId is always included as the last element.
 */
export function buildAncestryChain(sessions: Session[], currentId: string): string[] {
  const byId = new Map<string, Session>(sessions.map((s) => [s.id, s]));

  const chain: string[] = [];
  let cursor: string | null | undefined = currentId;

  // Guard against cycles with a visited set.
  const visited = new Set<string>();

  while (cursor != null) {
    if (visited.has(cursor)) break;
    visited.add(cursor);
    chain.push(cursor);

    const session = byId.get(cursor);
    if (session?.parentSessionId) {
      cursor = session.parentSessionId;
      continue;
    }

    const externalSessionId = session?.externalSessionId ?? null;
    if (externalSessionId) {
      cursor = externalSessionId;
      continue;
    }

    cursor = null;
  }

  // Reverse so the oldest ancestor comes first.
  chain.reverse();
  return chain;
}

// ─── groupFindingsByFile ──────────────────────────────────────────────────────

/**
 * Group FindingItem[] by the `file` field.
 * Groups are sorted by finding count, descending.
 */
export function groupFindingsByFile(findings: FindingItem[]): GroupedFindings[] {
  const map = new Map<string, FindingItem[]>();

  for (const finding of findings) {
    const bucket = map.get(finding.file) ?? [];
    bucket.push(finding);
    map.set(finding.file, bucket);
  }

  return Array.from(map.entries())
    .map(([file, items]) => ({ file, findings: items }))
    .sort((a, b) => b.findings.length - a.findings.length);
}

// ─── parseContextIndex ───────────────────────────────────────────────────────

/**
 * Validate and parse a raw unknown value into a ContextIndex.
 * Returns null if the value is missing required fields or has wrong types.
 */
export function parseContextIndex(raw: unknown): ContextIndex | null {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const obj = raw as Record<string, unknown>;

  // Required structural checks for ContextIndex
  if (
    !('changedFiles' in obj) ||
    typeof obj.changedFiles !== 'number' ||
    !('copiedFiles' in obj) ||
    typeof obj.copiedFiles !== 'number' ||
    !('categoryCounts' in obj) ||
    typeof obj.categoryCounts !== 'object' ||
    obj.categoryCounts === null ||
    Array.isArray(obj.categoryCounts) ||
    !('changedSample' in obj) ||
    !Array.isArray(obj.changedSample)
  ) {
    return null;
  }

  const redaction = obj.redaction;
  const parsedRedaction =
    redaction != null &&
    typeof redaction === 'object' &&
    !Array.isArray(redaction) &&
    typeof (redaction as Record<string, unknown>).changedFiles === 'number' &&
    typeof (redaction as Record<string, unknown>).usedRuleCount === 'number'
      ? (redaction as ContextIndex['redaction'])
      : null;

  const head = obj.head;
  const parsedHead =
    head != null &&
    typeof head === 'object' &&
    !Array.isArray(head) &&
    typeof (head as Record<string, unknown>).sha === 'string' &&
    typeof (head as Record<string, unknown>).branch === 'string'
      ? (head as ContextIndex['head'])
      : null;

  return {
    workspaceId: typeof obj.workspaceId === 'string' ? obj.workspaceId : null,
    projectDir: typeof obj.projectDir === 'string' ? obj.projectDir : null,
    projectSlug: typeof obj.projectSlug === 'string' ? obj.projectSlug : null,
    mode: typeof obj.mode === 'string' ? obj.mode : null,
    baseRef: typeof obj.baseRef === 'string' ? obj.baseRef : null,
    head: parsedHead,
    changedFiles: obj.changedFiles as number,
    copiedFiles: obj.copiedFiles as number,
    categoryCounts: obj.categoryCounts as Record<string, number>,
    changedSample: obj.changedSample as string[],
    redaction: parsedRedaction,
  };
}

// ─── parseResultIndex ────────────────────────────────────────────────────────

/**
 * Validate and parse a raw unknown value into a ResultIndex.
 * Returns null if the value is missing required fields or has wrong types.
 */
export function parseResultIndex(raw: unknown): ResultIndex | null {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const obj = raw as Record<string, unknown>;

  // Required structural checks for ResultIndex
  if (
    typeof obj.summary !== 'string' ||
    typeof obj.parseState !== 'string' ||
    typeof obj.findingsTotal !== 'number' ||
    typeof obj.filesTouched !== 'number' ||
    typeof obj.filteredCount !== 'number' ||
    typeof obj.promotedCount !== 'number' ||
    typeof obj.followupSupported !== 'boolean' ||
    typeof obj.hasBridge !== 'boolean'
  ) {
    return null;
  }

  const severityCounts = obj.severityCounts;
  if (
    severityCounts == null ||
    typeof severityCounts !== 'object' ||
    Array.isArray(severityCounts) ||
    typeof (severityCounts as Record<string, unknown>).CRITICAL !== 'number' ||
    typeof (severityCounts as Record<string, unknown>).WARNING !== 'number' ||
    typeof (severityCounts as Record<string, unknown>).INFO !== 'number' ||
    typeof (severityCounts as Record<string, unknown>).REFACTOR !== 'number'
  ) {
    return null;
  }

  if (!Array.isArray(obj.topFiles)) return null;

  return {
    summary: obj.summary as string,
    parseState: obj.parseState as string,
    findingsTotal: obj.findingsTotal as number,
    severityCounts: severityCounts as ResultIndex['severityCounts'],
    filesTouched: obj.filesTouched as number,
    topFiles: obj.topFiles as ResultIndex['topFiles'],
    filteredCount: obj.filteredCount as number,
    promotedCount: obj.promotedCount as number,
    followupSupported: obj.followupSupported as boolean,
    outputDigest: typeof obj.outputDigest === 'string' ? obj.outputDigest : null,
    hasBridge: obj.hasBridge as boolean,
    bridgeSummary: typeof obj.bridgeSummary === 'string' ? obj.bridgeSummary : null,
  };
}
