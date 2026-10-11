import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseOmpUsage } from '../dist/index.js';

const fixture = readFileSync(fileURLToPath(new URL('./fixtures/omp-session.jsonl', import.meta.url)), 'utf8');

test('parseOmpUsage sums message.usage grouped by provider/model', () => {
  assert.deepEqual(parseOmpUsage(fixture), [
    {
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      input: 3000,
      output: 300,
      cacheRead: 1500,
      cacheWrite: 200,
      totalTokens: 5000,
      costUsd: 0.09375,
    },
    {
      provider: 'openai-codex',
      model: 'gpt-6.1-sol',
      input: 3500,
      output: 350,
      cacheRead: 0,
      cacheWrite: 800,
      totalTokens: 4650,
      costUsd: 0.1328125,
    },
  ]);
});

test('parseOmpUsage ignores malformed, non-message, and usage-less lines', () => {
  assert.deepEqual(parseOmpUsage(''), []);
  assert.deepEqual(parseOmpUsage('\n  \n'), []);
  assert.deepEqual(
    parseOmpUsage(
      [
        'not json at all {',
        '{"type":"session","id":"s1"}',
        '{"type":"compaction","tokensBefore":5000,"tokensAfter":2000}',
        '{"type":"message","message":{"role":"user","content":[]}}',
        '{"type":"message","message":{"role":"assistant","usage":"nope"}}',
      ].join('\n'),
    ),
    [],
  );
});

test('parseOmpUsage never throws on bad lines and groups missing provider/model under unknown', () => {
  const rows = parseOmpUsage(
    [
      'null',
      '[]',
      '42',
      '"just a string"',
      '{"type":"message","message":{"usage":{"input":5,"cost":{"total":0.5}}}}',
    ].join('\n'),
  );
  assert.deepEqual(rows, [
    {
      provider: 'unknown',
      model: 'unknown',
      input: 5,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      costUsd: 0.5,
    },
  ]);
});
