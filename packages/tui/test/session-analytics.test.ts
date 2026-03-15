import assert from 'node:assert/strict';
import test from 'node:test';
import type { Session } from '@mmbridge/session-store';
import {
  buildAncestryChain,
  computeSessionStats,
  groupFindingsByFile,
  parseContextIndex,
  parseResultIndex,
} from '../dist/hooks/session-analytics.js';

function makeSession(overrides: Partial<Session> & { id: string; tool: string }): Session {
  return {
    mode: 'review',
    createdAt: new Date().toISOString(),
    projectDir: '/test',
    workspace: '/tmp/test',
    summary: '',
    findings: [],
    ...overrides,
  } as Session;
}

// ─── computeSessionStats ─────────────────────────────────────────────────────

test('computeSessionStats: empty sessions', () => {
  const stats = computeSessionStats([]);
  assert.equal(stats.totalFindings, 0);
  assert.equal(stats.dailyCounts.length, 7);
  assert.ok(stats.dailyCounts.every((c) => c === 0));
  assert.deepEqual(stats.toolDistribution, {});
});

test('computeSessionStats: counts today sessions', () => {
  const sessions = [
    makeSession({ id: '1', tool: 'kimi', createdAt: new Date().toISOString() }),
    makeSession({ id: '2', tool: 'qwen', createdAt: new Date().toISOString() }),
  ];
  const stats = computeSessionStats(sessions);
  assert.equal(stats.dailyCounts[0], 2); // today
  assert.equal(stats.toolDistribution.kimi, 1);
  assert.equal(stats.toolDistribution.qwen, 1);
});

test('computeSessionStats: aggregates severity', () => {
  const sessions = [
    makeSession({
      id: '1',
      tool: 'kimi',
      findings: [
        { severity: 'CRITICAL', file: 'a.ts', line: null, message: 'c' },
        { severity: 'WARNING', file: 'b.ts', line: null, message: 'w' },
        { severity: 'INFO', file: 'c.ts', line: null, message: 'i' },
        { severity: 'REFACTOR', file: 'd.ts', line: null, message: 'r' },
      ],
    }),
  ];
  const stats = computeSessionStats(sessions);
  assert.equal(stats.aggregateSeverity.critical, 1);
  assert.equal(stats.aggregateSeverity.warning, 1);
  assert.equal(stats.aggregateSeverity.info, 1);
  assert.equal(stats.aggregateSeverity.refactor, 1);
  assert.equal(stats.totalFindings, 4);
});

test('computeSessionStats: sessions older than 7 days excluded from daily counts', () => {
  const oldDate = new Date();
  oldDate.setDate(oldDate.getDate() - 10);
  const sessions = [makeSession({ id: '1', tool: 'kimi', createdAt: oldDate.toISOString() })];
  const stats = computeSessionStats(sessions);
  assert.ok(stats.dailyCounts.every((c) => c === 0));
  // But tool distribution still counts
  assert.equal(stats.toolDistribution.kimi, 1);
});

// ─── buildAncestryChain ──────────────────────────────────────────────────────

test('buildAncestryChain: single session', () => {
  const sessions = [makeSession({ id: 'a', tool: 'kimi' })];
  const chain = buildAncestryChain(sessions, 'a');
  assert.deepEqual(chain, ['a']);
});

test('buildAncestryChain: follows externalSessionId links', () => {
  const sessions = [
    makeSession({ id: 'a', tool: 'kimi', externalSessionId: undefined }),
    makeSession({ id: 'b', tool: 'kimi', externalSessionId: 'a' }),
    makeSession({ id: 'c', tool: 'kimi', externalSessionId: 'b' }),
  ];
  const chain = buildAncestryChain(sessions, 'c');
  // c → b → a, reversed to [a, b, c]
  assert.deepEqual(chain, ['a', 'b', 'c']);
});

test('buildAncestryChain: follows link to missing ancestor and includes it', () => {
  const sessions = [makeSession({ id: 'b', tool: 'kimi', externalSessionId: 'missing' })];
  const chain = buildAncestryChain(sessions, 'b');
  // b → externalSessionId:'missing' → not found → stop
  // chain is [b, missing] reversed = ['missing', 'b']
  assert.deepEqual(chain, ['missing', 'b']);
});

test('buildAncestryChain: prevents infinite cycle', () => {
  const sessions = [
    makeSession({ id: 'a', tool: 'kimi', externalSessionId: 'b' }),
    makeSession({ id: 'b', tool: 'kimi', externalSessionId: 'a' }),
  ];
  const chain = buildAncestryChain(sessions, 'a');
  assert.ok(chain.length <= 2);
});

// ─── groupFindingsByFile ─────────────────────────────────────────────────────

test('groupFindingsByFile: empty findings', () => {
  assert.deepEqual(groupFindingsByFile([]), []);
});

test('groupFindingsByFile: groups by file', () => {
  const findings = [
    { severity: 'WARNING', file: 'a.ts', line: 1, message: 'w1' },
    { severity: 'INFO', file: 'a.ts', line: 2, message: 'i1' },
    { severity: 'CRITICAL', file: 'b.ts', line: 3, message: 'c1' },
  ];
  const grouped = groupFindingsByFile(findings);
  assert.equal(grouped.length, 2);
  // a.ts has 2 findings — should come first (sorted by count desc)
  assert.equal(grouped[0].file, 'a.ts');
  assert.equal(grouped[0].findings.length, 2);
  assert.equal(grouped[1].file, 'b.ts');
  assert.equal(grouped[1].findings.length, 1);
});

// ─── parseContextIndex ───────────────────────────────────────────────────────

test('parseContextIndex: null for missing fields', () => {
  assert.equal(parseContextIndex(null), null);
  assert.equal(parseContextIndex(undefined), null);
  assert.equal(parseContextIndex({}), null);
  assert.equal(parseContextIndex('string'), null);
});

test('parseContextIndex: valid context index', () => {
  const raw = {
    workspaceId: 'ws-1',
    projectDir: '/test',
    projectSlug: 'test',
    mode: 'review',
    baseRef: 'main',
    head: { sha: 'abc123', branch: 'main' },
    changedFiles: 5,
    copiedFiles: 3,
    categoryCounts: { src: 3, test: 2 },
    changedSample: ['a.ts', 'b.ts'],
    redaction: { changedFiles: 2, usedRuleCount: 1 },
  };
  const parsed = parseContextIndex(raw);
  assert.notEqual(parsed, null);
  assert.equal(parsed?.changedFiles, 5);
  assert.equal(parsed?.head?.sha, 'abc123');
  assert.equal(parsed?.redaction?.usedRuleCount, 1);
});

// ─── parseResultIndex ────────────────────────────────────────────────────────

test('parseResultIndex: null for invalid input', () => {
  assert.equal(parseResultIndex(null), null);
  assert.equal(parseResultIndex(undefined), null);
  assert.equal(parseResultIndex({ summary: 'x' }), null); // missing fields
});

test('parseResultIndex: valid result index', () => {
  const raw = {
    summary: 'test',
    parseState: 'structured',
    findingsTotal: 5,
    severityCounts: { CRITICAL: 1, WARNING: 2, INFO: 1, REFACTOR: 1 },
    filesTouched: 3,
    topFiles: [{ file: 'a.ts', count: 2 }],
    filteredCount: 0,
    promotedCount: 0,
    followupSupported: true,
    outputDigest: 'abc123',
    hasBridge: false,
    bridgeSummary: null,
  };
  const parsed = parseResultIndex(raw);
  assert.notEqual(parsed, null);
  assert.equal(parsed?.findingsTotal, 5);
  assert.equal(parsed?.severityCounts.CRITICAL, 1);
  assert.equal(parsed?.followupSupported, true);
});
