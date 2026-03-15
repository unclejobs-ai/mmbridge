import assert from 'node:assert/strict';
import test from 'node:test';
import { buildContextIndex, buildResultIndex } from '../dist/session-index.js';
import type { BuildContextIndexInput, BuildResultIndexInput, Finding } from '../dist/types.js';

const f = (
  overrides: Partial<Finding> & { severity: Finding['severity']; file: string; message: string },
): Finding => ({
  line: null,
  ...overrides,
});

// buildContextIndex
test('buildContextIndex: constructs from full input', () => {
  const input: BuildContextIndexInput = {
    workspace: 'ws-123',
    projectDir: '/home/user/project',
    mode: 'review',
    baseRef: 'main',
    head: { sha: 'abc123', branch: 'feat/x' },
    changedFiles: ['src/api/users.ts', 'src/components/Button.tsx'],
    copiedFileCount: 5,
    redaction: { changedFiles: 1, usedRuleCount: 2 },
  };

  const result = buildContextIndex(input);

  assert.equal(result.workspaceId, 'ws-123');
  assert.equal(result.projectDir, '/home/user/project');
  assert.equal(result.mode, 'review');
  assert.equal(result.baseRef, 'main');
  assert.deepEqual(result.head, { sha: 'abc123', branch: 'feat/x' });
  assert.equal(result.changedFiles, 2);
  assert.equal(result.copiedFiles, 5);
  assert.deepEqual(result.redaction, { changedFiles: 1, usedRuleCount: 2 });
});

test('buildContextIndex: handles empty input', () => {
  const result = buildContextIndex({});
  assert.equal(result.workspaceId, null);
  assert.equal(result.projectDir, null);
  assert.equal(result.projectSlug, null);
  assert.equal(result.mode, null);
  assert.equal(result.baseRef, null);
  assert.equal(result.head, null);
  assert.equal(result.changedFiles, 0);
  assert.equal(result.copiedFiles, 0);
  assert.deepEqual(result.categoryCounts, {});
  assert.deepEqual(result.changedSample, []);
  assert.equal(result.redaction, null);
});

test('buildContextIndex: classifies changed files into categories', () => {
  const input: BuildContextIndexInput = {
    changedFiles: ['src/api/route.ts', 'src/api/other.ts', 'src/components/Button.tsx', 'lib/helper.ts'],
  };
  const result = buildContextIndex(input);
  assert.equal(result.categoryCounts.API, 2);
  assert.equal(result.categoryCounts.Component, 1);
  assert.equal(result.categoryCounts.Library, 1);
});

test('buildContextIndex: changedSample contains at most 5 files', () => {
  const input: BuildContextIndexInput = {
    changedFiles: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts'],
  };
  const result = buildContextIndex(input);
  assert.equal(result.changedSample.length, 5);
  assert.deepEqual(result.changedSample, ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']);
});

test('buildContextIndex: projectSlug derived from projectDir', () => {
  const input: BuildContextIndexInput = {
    projectDir: '/home/user/my-project',
  };
  const result = buildContextIndex(input);
  assert.ok(typeof result.projectSlug === 'string');
  assert.ok(result.projectSlug?.includes('my-project'));
});

test('buildContextIndex: undefined changedFiles defaults to empty', () => {
  const result = buildContextIndex({ workspace: 'ws' });
  assert.equal(result.changedFiles, 0);
  assert.deepEqual(result.changedSample, []);
});

// buildResultIndex
test('buildResultIndex: constructs from full input', () => {
  const findings: Finding[] = [
    f({ severity: 'CRITICAL', file: 'a.ts', message: 'c' }),
    f({ severity: 'WARNING', file: 'b.ts', message: 'w' }),
    f({ severity: 'INFO', file: 'a.ts', message: 'i' }),
    f({ severity: 'REFACTOR', file: 'c.ts', message: 'r' }),
  ];

  const input: BuildResultIndexInput = {
    summary: 'test summary',
    findings,
    filteredCount: 2,
    promotedCount: 1,
    followupSupported: true,
    rawOutput: 'some output',
    parseState: 'ok',
    bridgeSummary: 'bridge ran',
  };

  const result = buildResultIndex(input);

  assert.equal(result.summary, 'test summary');
  assert.equal(result.findingsTotal, 4);
  assert.equal(result.filteredCount, 2);
  assert.equal(result.promotedCount, 1);
  assert.equal(result.followupSupported, true);
  assert.equal(result.parseState, 'ok');
  assert.equal(result.hasBridge, true);
  assert.equal(result.bridgeSummary, 'bridge ran');
  assert.ok(result.outputDigest !== null);
});

test('buildResultIndex: computes severity counts correctly', () => {
  const findings: Finding[] = [
    f({ severity: 'CRITICAL', file: 'a.ts', message: 'c1' }),
    f({ severity: 'CRITICAL', file: 'b.ts', message: 'c2' }),
    f({ severity: 'WARNING', file: 'c.ts', message: 'w' }),
    f({ severity: 'INFO', file: 'd.ts', message: 'i' }),
  ];
  const result = buildResultIndex({ findings });
  assert.equal(result.severityCounts.CRITICAL, 2);
  assert.equal(result.severityCounts.WARNING, 1);
  assert.equal(result.severityCounts.INFO, 1);
  assert.equal(result.severityCounts.REFACTOR, 0);
});

test('buildResultIndex: computes top files by finding count', () => {
  const findings: Finding[] = [
    f({ severity: 'CRITICAL', file: 'hot.ts', message: 'c1' }),
    f({ severity: 'WARNING', file: 'hot.ts', message: 'w' }),
    f({ severity: 'INFO', file: 'hot.ts', message: 'i' }),
    f({ severity: 'INFO', file: 'other.ts', message: 'i2' }),
  ];
  const result = buildResultIndex({ findings });
  assert.equal(result.topFiles[0].file, 'hot.ts');
  assert.equal(result.topFiles[0].count, 3);
  assert.equal(result.filesTouched, 2);
});

test('buildResultIndex: top files capped at 5', () => {
  const findings: Finding[] = Array.from({ length: 10 }, (_, i) =>
    f({ severity: 'INFO', file: `file${i}.ts`, message: 'i' }),
  );
  const result = buildResultIndex({ findings });
  assert.ok(result.topFiles.length <= 5);
});

test('buildResultIndex: outputDigest is null when no rawOutput', () => {
  const result = buildResultIndex({ findings: [] });
  assert.equal(result.outputDigest, null);
});

test('buildResultIndex: outputDigest is a 12-char hex string when rawOutput provided', () => {
  const result = buildResultIndex({ rawOutput: 'some content' });
  assert.ok(result.outputDigest !== null);
  const digest = result.outputDigest;
  assert.equal(digest?.length, 12);
  assert.ok(digest !== null && /^[0-9a-f]{12}$/.test(digest));
});

test('buildResultIndex: hasBridge is false when no bridgeSummary', () => {
  const result = buildResultIndex({});
  assert.equal(result.hasBridge, false);
  assert.equal(result.bridgeSummary, null);
});

test('buildResultIndex: empty input uses defaults', () => {
  const result = buildResultIndex({});
  assert.equal(result.summary, '');
  assert.equal(result.parseState, 'unknown');
  assert.equal(result.findingsTotal, 0);
  assert.equal(result.filteredCount, 0);
  assert.equal(result.promotedCount, 0);
  assert.equal(result.followupSupported, false);
  assert.equal(result.filesTouched, 0);
  assert.deepEqual(result.topFiles, []);
});

test('buildResultIndex: filesTouched counts unique files', () => {
  const findings: Finding[] = [
    f({ severity: 'INFO', file: 'a.ts', message: 'i1' }),
    f({ severity: 'INFO', file: 'a.ts', message: 'i2' }),
    f({ severity: 'INFO', file: 'b.ts', message: 'i3' }),
  ];
  const result = buildResultIndex({ findings });
  assert.equal(result.filesTouched, 2);
});
