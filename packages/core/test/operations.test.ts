import assert from 'node:assert/strict';
import test from 'node:test';
import type { ReviewRun } from '../dist/index.js';
import { evaluateGate, recommendResumeAction } from '../dist/index.js';

function makeRun(overrides: Partial<ReviewRun> = {}): ReviewRun {
  return {
    id: 'run-1',
    tool: 'codex',
    mode: 'review',
    projectDir: '/repo',
    baseRef: 'HEAD~1',
    diffDigest: 'digest-1',
    changedFiles: 3,
    status: 'completed',
    phase: 'handoff',
    startedAt: '2026-03-18T00:00:00.000Z',
    completedAt: '2026-03-18T00:01:00.000Z',
    findingsSoFar: 1,
    warnings: [],
    sessionId: 'session-1',
    lanes: [
      {
        tool: 'codex',
        status: 'done',
        attempt: 1,
        startedAt: '2026-03-18T00:00:00.000Z',
        completedAt: '2026-03-18T00:01:00.000Z',
        findingCount: 1,
        externalSessionId: 'ext-1',
        followupSupported: true,
      },
    ],
    ...overrides,
  };
}

test('evaluateGate: warns when no fresh review matches the current diff', () => {
  const result = evaluateGate({
    current: {
      projectDir: '/repo',
      mode: 'review',
      baseRef: 'HEAD~1',
      diffDigest: 'digest-2',
      changedFilesCount: 2,
      explicitMode: false,
    },
    latestRun: makeRun({ diffDigest: 'digest-1' }),
    latestSession: null,
    latestHandoff: null,
  });

  assert.equal(result.status, 'warn');
  assert.ok(result.warnings.some((warning) => warning.code === 'stale-review'));
});

test('evaluateGate: unresolved critical ignores accepted but honors dismissed', () => {
  const run = makeRun();
  const withAccepted = evaluateGate({
    current: {
      projectDir: '/repo',
      mode: 'review',
      baseRef: 'HEAD~1',
      diffDigest: 'digest-1',
      changedFilesCount: 2,
      explicitMode: false,
    },
    latestRun: run,
    latestSession: {
      tool: 'codex',
      mode: 'review',
      followupSupported: true,
      externalSessionId: 'ext-1',
      findings: [{ severity: 'CRITICAL', file: 'src/a.ts', line: 10, message: 'Path traversal risk' }],
      findingDecisions: [{ key: 'CRITICAL:src/a.ts:10:Path traversal risk', status: 'accepted' }],
    },
    latestHandoff: null,
  });

  assert.ok(withAccepted.warnings.some((warning) => warning.code === 'unresolved-critical'));

  const withDismissed = evaluateGate({
    current: {
      projectDir: '/repo',
      mode: 'review',
      baseRef: 'HEAD~1',
      diffDigest: 'digest-1',
      changedFilesCount: 2,
      explicitMode: false,
    },
    latestRun: run,
    latestSession: {
      tool: 'codex',
      mode: 'review',
      followupSupported: true,
      externalSessionId: 'ext-1',
      findings: [{ severity: 'CRITICAL', file: 'src/a.ts', line: 10, message: 'Path traversal risk' }],
      findingDecisions: [{ key: 'CRITICAL:src/a.ts:10:Path traversal risk', status: 'dismissed' }],
    },
    latestHandoff: null,
  });

  assert.ok(!withDismissed.warnings.some((warning) => warning.code === 'unresolved-critical'));
});

test('evaluateGate: warns about bridge gap for large diffs with single-tool fresh runs', () => {
  const result = evaluateGate({
    current: {
      projectDir: '/repo',
      mode: 'review',
      baseRef: 'HEAD~1',
      diffDigest: 'digest-1',
      changedFilesCount: 8,
      explicitMode: false,
    },
    latestRun: makeRun({ tool: 'codex', changedFiles: 8 }),
    latestSession: null,
    latestHandoff: null,
  });

  assert.ok(result.warnings.some((warning) => warning.code === 'bridge-gap'));
});

test('recommendResumeAction: followup wins when an external session can continue', () => {
  const result = recommendResumeAction({
    latestRun: makeRun(),
    latestSession: {
      id: 'session-1',
      tool: 'codex',
      mode: 'review',
      projectDir: '/repo',
      externalSessionId: 'ext-1',
      followupSupported: true,
      findings: [],
      summary: 'latest',
    },
    latestHandoff: {
      artifact: {
        id: 'handoff-1',
        sessionId: 'session-1',
        projectKey: '-repo',
        createdAt: '2026-03-18T00:00:00.000Z',
        markdownPath: '/tmp/handoff.md',
        jsonPath: '/tmp/handoff.json',
        summary: 'latest',
        objective: 'objective',
        nextPrompt: 'next prompt',
        nextCommand: 'mmbridge followup ...',
        openBlockers: [],
      },
      tool: 'codex',
      mode: 'review',
      projectDir: '/repo',
      summary: 'latest',
      findings: [],
      recalledMemoryIds: [],
      recalledMemory: [],
      recommendedNextPrompt: 'next prompt',
      recommendedNextCommand: 'mmbridge followup ...',
    },
    gateResult: { status: 'pass', warnings: [] },
  });

  assert.equal(result.recommended.action, 'followup');
});

test('recommendResumeAction: bridge-rerun beats rerun when critical risk remains', () => {
  const result = recommendResumeAction({
    latestRun: makeRun({ diffDigest: 'digest-1' }),
    latestSession: {
      id: 'session-1',
      tool: 'codex',
      mode: 'review',
      projectDir: '/repo',
      externalSessionId: null,
      followupSupported: false,
      findings: [{ severity: 'CRITICAL', file: 'src/a.ts', line: 10, message: 'Path traversal risk' }],
      summary: 'latest',
    },
    latestHandoff: null,
    gateResult: {
      status: 'warn',
      warnings: [{ code: 'unresolved-critical', message: 'critical remains', nextCommand: 'mmbridge resume' }],
    },
  });

  assert.equal(result.recommended.action, 'bridge-rerun');
});
