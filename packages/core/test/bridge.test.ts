import test from 'node:test';
import assert from 'node:assert/strict';
import { runBridge, mergeBridgeFindings } from '../dist/bridge.js';
import type { Finding } from '../dist/types.js';

const f = (overrides: Partial<Finding> & { severity: Finding['severity']; file: string; message: string }): Finding => ({
  line: null,
  ...overrides,
});

// runBridge — empty inputs
test('runBridge: empty results returns 0 findings', async () => {
  const result = await runBridge({ results: [] });
  assert.equal(result.totalInputs, 0);
  assert.equal(result.consensusFindings, 0);
  assert.deepEqual(result.findings, []);
  assert.equal(result.summary, 'No inputs to bridge.');
});

test('runBridge: undefined options returns empty result', async () => {
  const result = await runBridge();
  assert.equal(result.totalInputs, 0);
  assert.equal(result.findings.length, 0);
});

test('runBridge: skipped results are ignored', async () => {
  const result = await runBridge({
    results: [
      { tool: 'a', findings: [f({ severity: 'WARNING', file: 'a.ts', message: 'w' })], skipped: true },
    ],
  });
  assert.equal(result.totalInputs, 0);
  assert.equal(result.findings.length, 0);
});

// runBridge — single tool findings
test('runBridge: standard profile requires 2 tools for consensus', async () => {
  // single tool, WARNING — should not pass standard threshold of 2
  const result = await runBridge({
    profile: 'standard',
    results: [
      { tool: 'tool1', findings: [f({ severity: 'WARNING', file: 'a.ts', message: 'w' })] },
    ],
  });
  // WARNING from 1 tool shouldn't meet threshold=2
  assert.equal(result.findings.filter((x) => x.severity === 'WARNING').length, 0);
});

test('runBridge: CRITICAL always passes regardless of threshold', async () => {
  const result = await runBridge({
    profile: 'standard',
    results: [
      { tool: 'tool1', findings: [f({ severity: 'CRITICAL', file: 'a.ts', message: 'crit' })] },
    ],
  });
  const criticals = result.findings.filter((x) => x.severity === 'CRITICAL');
  assert.equal(criticals.length, 1);
  assert.equal(criticals[0].message, 'crit');
});

// runBridge — multi-tool consensus
test('runBridge: finding from 2 tools passes standard threshold', async () => {
  const finding = f({ severity: 'WARNING', file: 'a.ts', message: 'shared warning' });
  const result = await runBridge({
    profile: 'standard',
    results: [
      { tool: 'tool1', findings: [finding] },
      { tool: 'tool2', findings: [finding] },
    ],
  });
  const warnings = result.findings.filter((x) => x.severity === 'WARNING');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].message, 'shared warning');
});

test('runBridge: sources array contains all contributing tools', async () => {
  const finding = f({ severity: 'WARNING', file: 'a.ts', message: 'shared' });
  const result = await runBridge({
    profile: 'standard',
    results: [
      { tool: 'toolA', findings: [finding] },
      { tool: 'toolB', findings: [finding] },
    ],
  });
  assert.equal(result.findings.length, 1);
  const sources = result.findings[0].sources ?? [];
  assert.ok(sources.includes('toolA'));
  assert.ok(sources.includes('toolB'));
});

test('runBridge: strict profile threshold is 1 (every finding passes)', async () => {
  const result = await runBridge({
    profile: 'strict',
    results: [
      { tool: 'tool1', findings: [f({ severity: 'INFO', file: 'a.ts', message: 'info' })] },
    ],
  });
  assert.equal(result.findings.length, 1);
});

test('runBridge: relaxed profile threshold is 3', async () => {
  const finding = f({ severity: 'WARNING', file: 'a.ts', message: 'w' });
  // 2 tools — should not meet threshold of 3
  const result2 = await runBridge({
    profile: 'relaxed',
    results: [
      { tool: 'a', findings: [finding] },
      { tool: 'b', findings: [finding] },
    ],
  });
  assert.equal(result2.findings.filter((x) => x.severity === 'WARNING').length, 0);

  // 3 tools — meets threshold
  const result3 = await runBridge({
    profile: 'relaxed',
    results: [
      { tool: 'a', findings: [finding] },
      { tool: 'b', findings: [finding] },
      { tool: 'c', findings: [finding] },
    ],
  });
  assert.equal(result3.findings.filter((x) => x.severity === 'WARNING').length, 1);
});

test('runBridge: profile defaults to standard', async () => {
  const result = await runBridge({
    results: [
      { tool: 't', findings: [f({ severity: 'WARNING', file: 'a.ts', message: 'w' })] },
    ],
  });
  assert.equal(result.profile, 'standard');
});

test('runBridge: counts map severity to total unique findings seen', async () => {
  const result = await runBridge({
    profile: 'strict',
    results: [
      {
        tool: 'tool1',
        findings: [
          f({ severity: 'CRITICAL', file: 'a.ts', message: 'c' }),
          f({ severity: 'WARNING', file: 'b.ts', message: 'w' }),
          f({ severity: 'INFO', file: 'c.ts', message: 'i' }),
        ],
      },
    ],
  });
  assert.equal(result.counts['CRITICAL'], 1);
  assert.equal(result.counts['WARNING'], 1);
  assert.equal(result.counts['INFO'], 1);
});

test('runBridge: summary includes profile name and finding count', async () => {
  const result = await runBridge({
    profile: 'strict',
    results: [
      { tool: 'tool1', findings: [f({ severity: 'WARNING', file: 'a.ts', message: 'w' })] },
    ],
  });
  assert.ok(result.summary.includes('strict'));
  assert.ok(result.summary.includes('1 consensus finding'));
});

// mergeBridgeFindings
test('mergeBridgeFindings: deduplicates identical findings', () => {
  const dup = f({ severity: 'WARNING', file: 'a.ts', line: 5, message: 'dup' });
  const result = mergeBridgeFindings([dup, dup]);
  assert.equal(result.length, 1);
});

test('mergeBridgeFindings: keeps distinct findings', () => {
  const findings: Finding[] = [
    f({ severity: 'WARNING', file: 'a.ts', message: 'first' }),
    f({ severity: 'WARNING', file: 'a.ts', message: 'second' }),
  ];
  const result = mergeBridgeFindings(findings);
  assert.equal(result.length, 2);
});

test('mergeBridgeFindings: empty array returns empty', () => {
  assert.deepEqual(mergeBridgeFindings([]), []);
});

test('mergeBridgeFindings: keeps first occurrence of duplicate', () => {
  const first = { ...f({ severity: 'WARNING' as const, file: 'a.ts', message: 'msg' }), raw: 'first' };
  const second = { ...f({ severity: 'WARNING' as const, file: 'a.ts', message: 'msg' }), raw: 'second' };
  const result = mergeBridgeFindings([first, second]);
  assert.equal(result.length, 1);
  assert.equal(result[0].raw, 'first');
});
