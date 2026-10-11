import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { assessQuota, parseCodexbarUsage, parseOmpUsageReport } from '../dist/index.js';

const ompFixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/omp-usage.json', import.meta.url)), 'utf8'),
);
const codexbarFixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/codexbar-usage.json', import.meta.url)), 'utf8'),
);

const NOW = 1791722135746; // omp-usage.json generatedAt

test('parseOmpUsageReport normalises every fixture limit', () => {
  const windows = parseOmpUsageReport(ompFixture);
  assert.equal(windows.length, 24);
  assert.ok(windows.every((w) => w.source === 'omp'));

  // accountId wins over email when present.
  assert.equal(windows.find((w) => w.provider === 'openai-codex')?.account, '82*');

  // zai report has accountId null → falls back to email.
  const zai = windows.filter((w) => w.provider === 'zai');
  assert.equal(zai.length, 2);
  assert.equal(zai[0].account, 'pa*');
  const exhausted = zai.find((w) => w.label === 'ZAI 5 Hours Token Quota');
  assert.equal(exhausted?.usedFraction, 1);
  assert.equal(exhausted?.resetsAt, 1791737075165);
  assert.equal(exhausted?.durationMs, 18000000);

  // opencode-go report (index 6) has neither email nor accountId → `#<index>`.
  assert.equal(windows.find((w) => w.provider === 'opencode-go')?.account, '#6');

  // monthly opencode limit has no durationMs → null.
  const monthly = windows.find((w) => w.label === 'Monthly limit');
  assert.equal(monthly?.durationMs, null);
  assert.equal(monthly?.resetsAt, 1792945253000);
});

test('parseCodexbarUsage maps providers and minute-labelled windows', () => {
  const windows = parseCodexbarUsage(codexbarFixture);
  assert.ok(windows.every((w) => w.source === 'codexbar'));
  // 'pi' is not in CODEXBAR_PROVIDERS → only codex (1) + claude (2) windows.
  assert.equal(windows.length, 3);

  const codex = windows.find((w) => w.provider === 'openai-codex');
  assert.equal(codex?.label, '43200m');
  assert.equal(codex?.usedFraction, 1);
  assert.equal(codex?.account, 'user@example.com');
  assert.equal(codex?.durationMs, 43200 * 60_000);
  assert.equal(codex?.resetsAt, Date.parse('2026-11-08T06:56:21Z'));

  const claude = windows.filter((w) => w.provider === 'anthropic');
  assert.deepEqual(
    claude.map((w) => w.label),
    ['300m', '10080m'],
  );
  assert.deepEqual(
    claude.map((w) => w.usedFraction),
    [0.09, 0.5],
  );
});

test('assessQuota blocks zai on remaining and openai-codex on pace', () => {
  const quotas = assessQuota(parseOmpUsageReport(ompFixture), NOW);
  assert.deepEqual(
    quotas.map((q) => q.provider),
    quotas.map((q) => q.provider).sort((a, b) => a.localeCompare(b)),
  );

  const zai = quotas.find((q) => q.provider === 'zai');
  assert.equal(zai?.blocked, true);
  assert.match(zai?.reason ?? '', /^ZAI 5 Hours Token Quota: 0% left/);
  assert.equal(zai?.remainingFraction, 0);

  const codex = quotas.find((q) => q.provider === 'openai-codex');
  assert.equal(codex?.blocked, true);
  assert.match(codex?.reason ?? '', /^7 days: pace runs out \S+ before reset \S+$/);

  const devin = quotas.find((q) => q.provider === 'devin');
  assert.equal(devin?.blocked, false);
  assert.equal(devin?.reason, null);
  assert.equal(devin?.remainingFraction, 1);

  const week = quotas.find((q) => q.provider === 'anthropic')?.windows.find((w) => w.label === 'Claude 7 Day');
  assert.equal(week?.accounts, 3);
  assert.ok(Math.abs((week?.usedFraction ?? 0) - 0.35) < 1e-9);
});

test('assessQuota keeps only omp windows when a provider reports from both sources', () => {
  const mixed = [...parseOmpUsageReport(ompFixture), ...parseCodexbarUsage(codexbarFixture)];
  const quotas = assessQuota(mixed, NOW);

  const anthropic = quotas.find((q) => q.provider === 'anthropic');
  assert.equal(anthropic?.source, 'omp');
  assert.deepEqual(
    anthropic?.windows.map((w) => w.label),
    ['Claude 5 Hour', 'Claude 7 Day', 'Claude 7 Day (Fable)'],
  );

  const codex = quotas.find((q) => q.provider === 'openai-codex');
  assert.equal(codex?.source, 'omp');
  assert.deepEqual(
    codex?.windows.map((w) => w.label),
    ['7 days'],
  );
});

test('assessQuota reports codexbar-only providers with source codexbar', () => {
  const quotas = assessQuota(parseCodexbarUsage(codexbarFixture), NOW);
  assert.equal(quotas.find((q) => q.provider === 'openai-codex')?.source, 'codexbar');
  assert.equal(quotas.find((q) => q.provider === 'anthropic')?.source, 'codexbar');
});

test('assessQuota projects exhaustion from pace inside a window', () => {
  const now = 1_000_000;
  const quotas = assessQuota(
    [
      {
        provider: 'p',
        source: 'omp',
        account: 'a',
        label: '4h',
        usedFraction: 0.5,
        resetsAt: now + 3 * 3_600_000,
        durationMs: 4 * 3_600_000,
      },
    ],
    now,
  );
  const summary = quotas[0].windows[0];
  assert.equal(summary.runsOutBeforeReset, true);
  assert.equal(summary.exhaustsAt, now + 3_600_000);
  assert.equal(quotas[0].blocked, true);
  assert.match(quotas[0].reason ?? '', /^4h: pace runs out \d{4}-\d{2}-\d{2}T/);
});

test('assessQuota ignores pace before minElapsed of the window has passed', () => {
  const now = 1_000_000;
  const quotas = assessQuota(
    [
      {
        provider: 'p',
        source: 'omp',
        account: 'a',
        label: '4h',
        usedFraction: 0.5,
        resetsAt: now + 0.99 * 4 * 3_600_000,
        durationMs: 4 * 3_600_000,
      },
    ],
    now,
  );
  const summary = quotas[0].windows[0];
  assert.equal(summary.runsOutBeforeReset, false);
  assert.equal(summary.exhaustsAt, null);
  assert.equal(quotas[0].blocked, false);
  assert.equal(quotas[0].reason, null);
});

test('assessQuota paces a fast burn but not a few percent early in a long window (live Devin 2026-10-11)', () => {
  const week = 7 * 86_400_000;
  const now = 1_000_000_000;
  const window = (provider: string, usedFraction: number) => ({
    provider,
    source: 'omp' as const,
    account: 'a',
    label: '7d',
    usedFraction,
    resetsAt: now + 0.97 * week,
    durationMs: week,
  });
  const quotas = assessQuota([window('devin', 0.05), window('codex', 0.32)], now);
  assert.deepEqual(
    quotas.map((quota) => [quota.provider, quota.blocked]),
    [
      ['codex', true],
      ['devin', false],
    ],
  );
});

test('parseOmpUsageReport clamps usedFraction into [0,1]', () => {
  const windows = parseOmpUsageReport({
    reports: [
      {
        provider: 'p',
        metadata: {},
        limits: [
          { label: 'over', amount: { usedFraction: 1.7 }, window: {} },
          { label: 'under', amount: { usedFraction: -0.4 }, window: {} },
        ],
      },
    ],
  });
  assert.equal(windows[0].usedFraction, 1);
  assert.equal(windows[1].usedFraction, 0);
});

test('parsers return [] on malformed input and skip windows without finite usage numbers', () => {
  for (const bad of [null, undefined, 42, 'x', [], { reports: 'nope' }, { reports: [null, 7] }]) {
    assert.deepEqual(parseOmpUsageReport(bad), []);
  }
  for (const bad of [null, undefined, 42, 'x', {}, [null], [{ provider: 'unknown-svc', usage: {} }]]) {
    assert.deepEqual(parseCodexbarUsage(bad), []);
  }
  assert.deepEqual(
    parseOmpUsageReport({
      reports: [
        {
          provider: 'p',
          limits: [
            { label: 'x', amount: {} },
            { label: 'y', amount: { usedFraction: 'half' } },
          ],
        },
      ],
    }),
    [],
  );
  assert.deepEqual(
    parseCodexbarUsage([{ provider: 'codex', usage: { primary: { usedPercent: 'high' }, secondary: null } }]),
    [],
  );
});
