import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadFixturesFromDir } from '../lib/fixtures.mjs';
import { compareWithBaseline, findingKey, scoreFindingSets } from '../lib/scoring.mjs';

const finding = (overrides = {}) => ({
  severity: 'WARNING',
  file: 'src/app.ts',
  line: 12,
  message: 'Potential null dereference',
  ...overrides,
});

test('findingKey: normalizes nullable line values', () => {
  const withNull = finding({ line: null });
  const withUndefined = finding({ line: undefined });

  assert.equal(findingKey(withNull), 'WARNING|src/app.ts||Potential null dereference');
  assert.equal(findingKey(withUndefined), 'WARNING|src/app.ts||Potential null dereference');
});

test('scoreFindingSets: returns perfect score for exact set match', () => {
  const expected = [finding()];
  const actual = [finding()];

  const score = scoreFindingSets(expected, actual);
  assert.equal(score.truePositives, 1);
  assert.equal(score.falsePositives, 0);
  assert.equal(score.falseNegatives, 0);
  assert.equal(score.precision, 1);
  assert.equal(score.recall, 1);
  assert.equal(score.f1, 1);
  assert.equal(score.exactMatch, true);
});

test('scoreFindingSets: captures false positives and false negatives', () => {
  const expected = [finding({ message: 'Expected issue' })];
  const actual = [finding({ message: 'Unexpected issue' })];

  const score = scoreFindingSets(expected, actual);
  assert.equal(score.truePositives, 0);
  assert.equal(score.falsePositives, 1);
  assert.equal(score.falseNegatives, 1);
  assert.equal(score.precision, 0);
  assert.equal(score.recall, 0);
  assert.equal(score.f1, 0);
  assert.equal(score.exactMatch, false);
});

test('compareWithBaseline: reports metric and fixture regressions', () => {
  const current = {
    overall: { meanF1: 0.74, exactRate: 0.8 },
    suites: {
      parser: { meanF1: 0.81, exactRate: 0.8 },
      bridge: { meanF1: 0.67, exactRate: 0.5 },
    },
    fixtures: [
      { id: 'parser/basic-tag', kind: 'parser', score: { f1: 0.9 } },
      { id: 'bridge/consensus', kind: 'bridge', score: { f1: 0.6 } },
    ],
  };

  const baseline = {
    schemaVersion: 1,
    metrics: {
      overall: { minMeanF1: 0.8, minExactRate: 0.85 },
      parser: { minMeanF1: 0.8, minExactRate: 0.75 },
      bridge: { minMeanF1: 0.7, minExactRate: 0.5 },
    },
    fixtures: {
      'bridge/consensus': { minF1: 0.7 },
    },
  };

  const regressions = compareWithBaseline(current, baseline);
  assert.equal(regressions.length, 4);
  assert.deepEqual(
    regressions.map((entry) => entry.code),
    ['overall.meanF1', 'overall.exactRate', 'bridge.meanF1', 'bridge/consensus.f1'],
  );
});

test('loadFixturesFromDir: loads fixtures and rejects duplicate ids', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mmbridge-bench-'));
  const parserFixture = {
    id: 'parser/basic',
    kind: 'parser',
    input: { rawText: '[WARNING] src/app.ts:1 - issue' },
    expected: { findings: [finding({ line: 1, message: 'src/app.ts:1 - issue' })] },
  };
  const parserFixtureDuplicate = {
    id: 'parser/basic',
    kind: 'parser',
    input: { rawText: '[INFO] hello' },
    expected: { findings: [finding({ severity: 'INFO', file: '', line: null, message: 'hello' })] },
  };

  await writeFile(path.join(root, 'fixture-a.json'), JSON.stringify(parserFixture, null, 2));
  await writeFile(path.join(root, 'fixture-b.json'), JSON.stringify(parserFixtureDuplicate, null, 2));

  await assert.rejects(() => loadFixturesFromDir(root), /Duplicate fixture id: parser\/basic/);
});
