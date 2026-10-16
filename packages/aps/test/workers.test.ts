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

test('DEFAULT_WORKERS is frozen and passes its own registry validation', () => {
  assert.ok(Object.isFrozen(DEFAULT_WORKERS));
  for (const w of DEFAULT_WORKERS) {
    assert.ok(Object.isFrozen(w));
    assert.ok(Object.isFrozen(w.roles));
  }
  assert.deepEqual(parseWorkerRegistry(JSON.parse(JSON.stringify(DEFAULT_WORKERS))), DEFAULT_WORKERS);
});

const ids = (workers: readonly WorkerSpec[]) => workers.map((w) => w.id);
const blocked = (provider: string, reason: string): ProviderQuota => ({
  provider,
  source: 'omp',
  windows: [],
  remainingFraction: 0,
  blocked: true,
  reason,
});

test('DEFAULT_WORKERS: L3 mech order is glm -> cursor-grok -> glmflash and nothing else auto-dispatches mech', () => {
  const res = rankWorkers(DEFAULT_WORKERS, { tier: 'L3', role: 'mech', quota: [], vendorLoad: {} });
  assert.strictEqual(res.skipped.length, 0);
  assert.deepEqual(ids(res.candidates), ['glm', 'cursor-grok', 'glmflash']);
  assert.deepEqual(ids(DEFAULT_WORKERS.filter((w) => w.roles.includes('mech'))), ['glm', 'cursor-grok', 'glmflash']);
});

test('DEFAULT_WORKERS: L2 never takes mech and L3 only takes mech', () => {
  for (const w of DEFAULT_WORKERS) {
    if (w.tier === 'L2') assert.ok(!w.roles.includes('mech'), `${w.id} is L2 with a mech role`);
    else assert.deepEqual([...w.roles], ['mech'], `${w.id} is L3 with a non-mech role`);
  }
  const res = rankWorkers(DEFAULT_WORKERS, { tier: 'L2', role: 'mech', quota: [], vendorLoad: {} });
  assert.deepEqual(res.candidates, []);
});

test('DEFAULT_WORKERS: L2 review is GPT Codex, design and vision are Opus high or above', () => {
  const rank = (role: 'review' | 'design' | 'vision') =>
    rankWorkers(DEFAULT_WORKERS, { tier: 'L2', role, quota: [], vendorLoad: {} }).candidates;
  const review = rank('review');
  assert.deepEqual(ids(review), ['sol', 'astra']);
  for (const w of review) assert.strictEqual(w.provider, 'openai-codex');
  for (const w of [...rank('design'), ...rank('vision')]) {
    assert.match(w.model, /^anthropic\/claude-opus-5-5:(high|xhigh|max)$/, w.id);
  }
  assert.deepEqual(ids(rank('design')), ['opus-high']);
  assert.deepEqual(ids(rank('vision')), ['opus-xhigh']);
  assert.match(rank('vision')[0]?.model ?? '', /:(xhigh|max)$/);
});

test('DEFAULT_WORKERS: harness, agent and model agree and retired routes are gone', () => {
  const retiredAgent = /^w-(opus-med|qa-vision|gemini|deepseek|fable)|^w-opus-api/;
  const retiredProvider = /^(devin|opencode-go|openrouter|google-antigravity|xai-oauth)$/;
  for (const w of DEFAULT_WORKERS) {
    assert.strictEqual(w.harness, 'omp', w.id);
    assert.ok(w.agent !== null && !retiredAgent.test(w.agent), `${w.id} agent ${w.agent}`);
    assert.ok(!retiredProvider.test(w.provider), `${w.id} provider ${w.provider}`);
    assert.ok(w.model.startsWith(`${w.provider}/`), `${w.id} model ${w.model} is not on provider ${w.provider}`);
    assert.ok(!/fable|fusion/.test(w.model), `${w.id} model ${w.model}`);
  }
});

test('rankWorkers: vendor spread moves a loaded vendor behind zero-load workers, registry order otherwise', () => {
  const res = rankWorkers(DEFAULT_WORKERS, { tier: 'L3', role: 'mech', quota: [], vendorLoad: { zai: 2 } });
  assert.deepEqual(ids(res.candidates), ['cursor-grok', 'glm', 'glmflash']);
});

test('rankWorkers: quota block skips every worker on that provider with reason', () => {
  const res = rankWorkers(DEFAULT_WORKERS, {
    tier: 'L3',
    role: 'mech',
    quota: [blocked('zai', '5 Hours exhausted')],
    vendorLoad: {},
  });
  assert.deepEqual(ids(res.candidates), ['cursor-grok']);
  assert.deepEqual(res.skipped, [
    { id: 'glm', reason: 'quota: 5 Hours exhausted' },
    { id: 'glmflash', reason: 'quota: 5 Hours exhausted' },
  ]);
});

test('rankWorkers: cursor quota block falls through to the zai workers', () => {
  const res = rankWorkers(DEFAULT_WORKERS, {
    tier: 'L3',
    role: 'mech',
    quota: [blocked('cursor', 'Other Models: 0% left')],
    vendorLoad: {},
  });
  assert.deepEqual(ids(res.candidates), ['glm', 'glmflash']);
  assert.deepEqual(res.skipped, [{ id: 'cursor-grok', reason: 'quota: Other Models: 0% left' }]);
});

test('rankWorkers: ignoreQuota keeps blocked worker', () => {
  const res = rankWorkers(DEFAULT_WORKERS, {
    tier: 'L3',
    role: 'mech',
    quota: [blocked('zai', '5 Hours exhausted')],
    vendorLoad: {},
    ignoreQuota: true,
  });
  assert.deepEqual(ids(res.candidates), ['glm', 'cursor-grok', 'glmflash']);
  assert.strictEqual(res.skipped.length, 0);
});

test('rankWorkers: only-chain order + unknown id and wrong-tier id skipped', () => {
  const res = rankWorkers(DEFAULT_WORKERS, {
    tier: 'L3',
    role: 'mech',
    quota: [],
    vendorLoad: {},
    only: ['glmflash', 'unknown-id', 'glm', 'sol'],
  });
  assert.deepEqual(ids(res.candidates), ['glmflash', 'glm']);
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
    exclude: ['glm'],
  });
  assert.deepEqual(ids(res.candidates), ['cursor-grok', 'glmflash']);
  assert.deepEqual(res.skipped, [{ id: 'glm', reason: 'excluded' }]);
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
