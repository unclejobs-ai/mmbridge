import type {
  Finding,
  GateEvaluationInput,
  GateResult,
  GateWarning,
  ResumeAction,
  ResumeRecommendationInput,
  ResumeResult,
  ReviewRun,
  ReviewRunStatus,
  ToolLane,
  ToolLaneStatus,
} from './types.js';

const FRESH_RUN_STATUSES = new Set<ReviewRunStatus>(['completed', 'partial']);
const TERMINAL_LANE_STATUSES = new Set<ToolLaneStatus>(['done', 'error', 'timed_out', 'skipped', 'cancelled']);
const FAILED_LANE_STATUSES = new Set<ToolLaneStatus>(['error', 'timed_out', 'cancelled']);

function findingKey(finding: Finding): string {
  return `${finding.severity}:${finding.file}:${finding.line ?? ''}:${finding.message}`;
}

function formatBaseRef(baseRef: string | null): string {
  return baseRef ? ` --base-ref ${baseRef}` : '';
}

function buildReviewCommand(input: {
  projectDir: string;
  mode: string;
  baseRef: string | null;
  tool?: string;
  bridge?: boolean;
}): string {
  const tool = input.tool ?? 'all';
  const parts = [
    `mmbridge review --tool ${tool}`,
    `--mode ${input.mode}`,
    `--project ${JSON.stringify(input.projectDir)}`,
  ];
  if (input.bridge) {
    parts.push('--bridge standard');
  }
  if (input.baseRef) {
    parts.push(`--base-ref ${input.baseRef}`);
  }
  return parts.join(' ');
}

export function isFreshRun(current: GateEvaluationInput['current'], run: ReviewRun | null): boolean {
  if (!run) return false;
  if (!FRESH_RUN_STATUSES.has(run.status)) return false;
  return (
    run.projectDir === current.projectDir &&
    run.mode === current.mode &&
    (run.baseRef ?? null) === current.baseRef &&
    (run.diffDigest ?? null) === current.diffDigest
  );
}

export function hasUnresolvedCritical(
  latestSession: GateEvaluationInput['latestSession'],
  latestHandoff: GateEvaluationInput['latestHandoff'],
): boolean {
  const findings = latestSession?.findings ?? [];
  const decisions = new Map((latestSession?.findingDecisions ?? []).map((decision) => [decision.key, decision.status]));
  const hasCriticalFinding = findings.some((finding) => {
    if (finding.severity !== 'CRITICAL') return false;
    return decisions.get(findingKey(finding)) !== 'dismissed';
  });

  if (hasCriticalFinding) {
    return true;
  }

  return Boolean(latestHandoff?.artifact?.openBlockers.some((blocker) => blocker.includes('[CRITICAL]')));
}

function buildWarning(code: GateWarning['code'], message: string, nextCommand: string): GateWarning {
  return { code, message, nextCommand };
}

export function evaluateGate(input: GateEvaluationInput): GateResult {
  const warnings: GateWarning[] = [];
  const nextReviewCommand = buildReviewCommand({
    projectDir: input.current.projectDir,
    mode: input.current.mode,
    baseRef: input.current.baseRef,
  });
  const fresh = isFreshRun(input.current, input.latestRun);

  if (!input.current.baseRef || !input.current.diffDigest) {
    warnings.push(
      buildWarning(
        'unable-to-evaluate',
        'Unable to build a stable diff fingerprint for this project state.',
        nextReviewCommand,
      ),
    );
  }

  if (!fresh) {
    warnings.push(
      buildWarning(
        'stale-review',
        'No fresh review matches the current diff, base ref, and review mode.',
        nextReviewCommand,
      ),
    );
  }

  if (input.current.explicitMode && !fresh) {
    warnings.push(
      buildWarning('coverage-gap', `No fresh ${input.current.mode} review covers the current diff.`, nextReviewCommand),
    );
  }

  if (hasUnresolvedCritical(input.latestSession, input.latestHandoff)) {
    warnings.push(
      buildWarning(
        'unresolved-critical',
        'A critical finding is still unresolved and should be revisited before shipping.',
        `mmbridge resume --project ${JSON.stringify(input.current.projectDir)}`,
      ),
    );
  }

  if (fresh && input.current.changedFilesCount >= 8 && input.latestRun?.tool !== 'bridge') {
    warnings.push(
      buildWarning(
        'bridge-gap',
        'Large diffs should have a fresh bridge-backed review rather than a single-tool pass.',
        buildReviewCommand({
          projectDir: input.current.projectDir,
          mode: input.current.mode,
          baseRef: input.current.baseRef,
          tool: 'all',
          bridge: true,
        }),
      ),
    );
  }

  return {
    status: warnings.length > 0 ? 'warn' : 'pass',
    warnings,
  };
}

export function recommendResumeAction(input: ResumeRecommendationInput): ResumeResult {
  const warnings = new Set(input.gateResult.warnings.map((warning) => warning.code));
  const alternatives: ResumeAction[] = [];
  const summary =
    input.latestHandoff?.artifact?.openBlockers[0] ?? input.latestSession?.summary ?? 'No resume action needed.';

  const canFollowup = Boolean(input.latestSession?.followupSupported && input.latestSession.externalSessionId);
  const needsBridge = warnings.has('unresolved-critical') || warnings.has('bridge-gap');
  const needsRerun = warnings.has('stale-review') || warnings.has('coverage-gap');

  if (canFollowup) alternatives.push('followup');
  if (needsBridge) alternatives.push('bridge-rerun');
  if (needsRerun) alternatives.push('rerun');

  if (canFollowup) {
    return {
      recommended: {
        action: 'followup',
        reason: 'The latest session supports follow-up and can continue the same external thread.',
      },
      alternatives: alternatives.filter((action) => action !== 'followup'),
      summary,
      readOnly: false,
    };
  }

  if (needsBridge) {
    return {
      recommended: {
        action: 'bridge-rerun',
        reason: 'Critical risk or missing bridge coverage makes a fresh bridge run the safest next step.',
      },
      alternatives: alternatives.filter((action) => action !== 'bridge-rerun'),
      summary,
      readOnly: false,
    };
  }

  if (needsRerun) {
    return {
      recommended: {
        action: 'rerun',
        reason: 'The latest review is stale for the current diff and should be rerun.',
      },
      alternatives: alternatives.filter((action) => action !== 'rerun'),
      summary,
      readOnly: false,
    };
  }

  return {
    recommended: null,
    alternatives: [],
    summary,
    readOnly: true,
  };
}

export function deriveRunStatus(lanes: ToolLane[]): ReviewRunStatus {
  if (lanes.length === 0) {
    return 'running';
  }

  const terminal = lanes.every((lane) => TERMINAL_LANE_STATUSES.has(lane.status));
  if (!terminal) {
    return 'running';
  }

  const successCount = lanes.filter((lane) => lane.status === 'done').length;
  const failedCount = lanes.filter((lane) => FAILED_LANE_STATUSES.has(lane.status)).length;

  if (successCount === lanes.length) {
    return 'completed';
  }
  if (successCount > 0 && failedCount > 0) {
    return 'partial';
  }
  if (successCount === 0) {
    return 'failed';
  }
  return 'cancelled';
}
