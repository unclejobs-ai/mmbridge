import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApsInputError,
  DEFAULT_WORKERS,
  type ProviderQuota,
  type WorkerSpec,
  classifyFailure,
  parseWorkerRegistry,
  rankWorkers,
} from '../dist/index.js';

test('DEFAULT_WORKERS is frozen and matches the specification', () => {
  assert.ok(Object.isFrozen(DEFAULT_WORKERS));
  assert.strictEqual(DEFAULT_WORKERS.length, 11);
  for (const w of DEFAULT_WORKERS) {
    assert.ok(Object.isFrozen(w));
    assert.ok(Object.isFrozen(w.roles));
  }
  assert.strictEqual(DEFAULT_WORKERS[0]?.id, 'devin-swe2');
  assert.strictEqual(DEFAULT_WORKERS[1]?.id, 'gemini-flash');
  assert.strictEqual(DEFAULT_WORKERS[2]?.id, 'deepseek-flash');
  assert.strictEqual(DEFAULT_WORKERS[3]?.id, 'grok');
  assert.strictEqual(DEFAULT_WORKERS[4]?.id, 'glm');
  assert.strictEqual(DEFAULT_WORKERS[5]?.id, 'kimi');
  assert.strictEqual(DEFAULT_WORKERS[6]?.id, 'qwen');
  assert.strictEqual(DEFAULT_WORKERS[7]?.id, 'sol');
  assert.strictEqual(DEFAULT_WORKERS[8]?.id, 'opus-med');
  assert.strictEqual(DEFAULT_WORKERS[9]?.id, 'qa-vision');
  assert.strictEqual(DEFAULT_WORKERS[10]?.id, 'astra-vision');
});

test('rankWorkers: default ordering (L3 mech -> devin-swe2 first)', () => {
  const res = rankWorkers(DEFAULT_WORKERS, {
    tier: 'L3',
    role: 'mech',
    quota: [],
    vendorLoad: {},
  });
  assert.strictEqual(res.skipped.length, 0);
  assert.strictEqual(res.candidates[0]?.id, 'devin-swe2');
  assert.deepEqual(
    res.candidates.map((c) => c.id),
    ['devin-swe2', 'gemini-flash', 'deepseek-flash', 'grok', 'glm', 'kimi', 'qwen'],
  );
});

test('rankWorkers: vendor spread (devin load 2, google 0 -> gemini-flash first, devin-swe2 after zero-load)', () => {
  const res = rankWorkers(DEFAULT_WORKERS, {
    tier: 'L3',
    role: 'mech',
    quota: [],
    vendorLoad: { devin: 2 },
  });
  assert.strictEqual(res.candidates[0]?.id, 'gemini-flash');
  const ids = res.candidates.map((c) => c.id);
  const zeroLoadIds = ['gemini-flash', 'deepseek-flash', 'grok', 'glm', 'kimi', 'qwen'];
  assert.deepEqual(ids.slice(0, 6), zeroLoadIds);
  assert.strictEqual(ids[6], 'devin-swe2');
});

test('rankWorkers: quota block skip with reason', () => {
  const quota: ProviderQuota[] = [
    {
      provider: 'devin',
      source: 'omp',
      windows: [],
      remainingFraction: 0,
      blocked: true,
      reason: '7 days exhausted',
    },
  ];
  const res = rankWorkers(DEFAULT_WORKERS, {
    tier: 'L3',
    role: 'mech',
    quota,
    vendorLoad: {},
  });
  assert.strictEqual(res.candidates[0]?.id, 'gemini-flash');
  assert.deepEqual(res.skipped, [{ id: 'devin-swe2', reason: 'quota: 7 days exhausted' }]);
});

test('rankWorkers: ignoreQuota keeps blocked worker', () => {
  const quota: ProviderQuota[] = [
    {
      provider: 'devin',
      source: 'omp',
      windows: [],
      remainingFraction: 0,
      blocked: true,
      reason: '7 days exhausted',
    },
  ];
  const res = rankWorkers(DEFAULT_WORKERS, {
    tier: 'L3',
    role: 'mech',
    quota,
    vendorLoad: {},
    ignoreQuota: true,
  });
  assert.strictEqual(res.candidates[0]?.id, 'devin-swe2');
  assert.strictEqual(res.skipped.length, 0);
});

test('rankWorkers: only-chain order + unknown id skipped', () => {
  const res = rankWorkers(DEFAULT_WORKERS, {
    tier: 'L3',
    role: 'mech',
    quota: [],
    vendorLoad: {},
    only: ['glm', 'unknown-id', 'gemini-flash', 'sol'],
  });
  assert.deepEqual(
    res.candidates.map((c) => c.id),
    ['glm', 'gemini-flash'],
  );
  assert.deepEqual(res.skipped, [
    { id: 'unknown-id', reason: 'not a L3 mech worker' },
    { id: 'sol', reason: 'not a L3 mech worker' },
  ]);
});

test('rankWorkers: exclude drops worker', () => {
  const res = rankWorkers(DEFAULT_WORKERS, {
    tier: 'L3',
    role: 'mech',
    quota: [],
    vendorLoad: {},
    exclude: ['devin-swe2', 'grok'],
  });
  assert.deepEqual(
    res.candidates.map((c) => c.id),
    ['gemini-flash', 'deepseek-flash', 'glm', 'kimi', 'qwen'],
  );
  assert.deepEqual(res.skipped, [
    { id: 'devin-swe2', reason: 'excluded' },
    { id: 'grok', reason: 'excluded' },
  ]);
});

test('rankWorkers: L2 vision -> [qa-vision, astra-vision]', () => {
  const res = rankWorkers(DEFAULT_WORKERS, {
    tier: 'L2',
    role: 'vision',
    quota: [],
    vendorLoad: {},
  });
  assert.deepEqual(
    res.candidates.map((c) => c.id),
    ['qa-vision', 'astra-vision'],
  );
  assert.strictEqual(res.skipped.length, 0);
});

test('parseWorkerRegistry: happy path for array and {workers:[...]}', () => {
  const sample: WorkerSpec[] = [
    {
      id: 'worker-1',
      tier: 'L3',
      vendor: 'google',
      provider: 'google-antigravity',
      harness: 'omp',
      model: 'model-a',
      agent: 'agent-1',
      roles: ['mech'],
    },
  ];
  const parsedArray = parseWorkerRegistry(sample);
  assert.deepEqual(parsedArray, sample);

  const parsedWrapped = parseWorkerRegistry({ workers: sample });
  assert.deepEqual(parsedWrapped, sample);
});

test('parseWorkerRegistry: 3 refusals (bad id, bad harness, duplicate id)', () => {
  assert.throws(
    () =>
      parseWorkerRegistry([
        {
          id: 'Bad_ID!',
          tier: 'L3',
          vendor: 'google',
          provider: 'p',
          harness: 'omp',
          model: 'm',
          agent: null,
          roles: ['mech'],
        },
      ]),
    (err: unknown) =>
      err instanceof ApsInputError && /worker registry: Bad_ID!: invalid id/.test((err as Error).message),
  );

  assert.throws(
    () =>
      parseWorkerRegistry([
        {
          id: 'worker-1',
          tier: 'L3',
          vendor: 'google',
          provider: 'p',
          harness: 'invalid-harness',
          model: 'm',
          agent: null,
          roles: ['mech'],
        },
      ]),
    (err: unknown) =>
      err instanceof ApsInputError && /worker registry: worker-1: invalid harness/.test((err as Error).message),
  );

  assert.throws(
    () =>
      parseWorkerRegistry([
        {
          id: 'worker-1',
          tier: 'L3',
          vendor: 'google',
          provider: 'p',
          harness: 'omp',
          model: 'm',
          agent: null,
          roles: ['mech'],
        },
        {
          id: 'worker-1',
          tier: 'L3',
          vendor: 'google',
          provider: 'p',
          harness: 'omp',
          model: 'm',
          agent: null,
          roles: ['mech'],
        },
      ]),
    (err: unknown) =>
      err instanceof ApsInputError && /worker registry: worker-1: duplicate id/.test((err as Error).message),
  );
});

test('classifyFailure: categorization of failures', () => {
  assert.strictEqual(classifyFailure('You have hit your usage limit'), 'usage-limit');
  assert.strictEqual(classifyFailure('HTTP 429 Too Many Requests'), 'usage-limit');
  assert.strictEqual(classifyFailure('OAuth token expired'), 'auth');
  assert.strictEqual(classifyFailure('Error: untrusted workspace'), 'auth');
  assert.strictEqual(classifyFailure('503 Service Unavailable'), 'outage');
  assert.strictEqual(classifyFailure('TypeError: x is undefined'), null);
});
