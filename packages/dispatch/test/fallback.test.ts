import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { dispatch } from '../dist/index.js';
import { resolveRoleChain } from '../dist/roles.js';

const fakeOmp = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-omp.mjs');

async function setup(ompYaml: string, rolesJson?: unknown) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mmbridge-fallback-'));
  const ompConfigPath = path.join(dir, 'config.yml');
  await writeFile(ompConfigPath, ompYaml);
  if (rolesJson !== undefined) await writeFile(path.join(dir, 'roles.json'), JSON.stringify(rolesJson));
  return { dir, ompConfigPath, mmbridgeHome: dir };
}

const OMP =
  'modelRoles:\n  default: devin/swe-2:max\n  advisor: xai-oauth/grok-4.6:xhigh\n  smol: openai-codex/gpt-5.6-luna:medium\nretry:\n  fallbackChains:\n    openai-codex/gpt-5.6-luna: [zai/glm-5.3-flash]\n';

afterEach(() => {
  for (const key of [
    'FAKE_OMP_QUOTA',
    'FAKE_OMP_UNKNOWN',
    'FAKE_OMP_SPAWN_LOG',
    'FAKE_OMP_FORBIDDEN',
    'FAKE_OMP_INTERNAL_FALLBACK',
  ])
    Reflect.deleteProperty(process.env, key);
});

describe('resolveRoleChain', () => {
  it('seeds from omp: role model, its omp fallback chain, then the omp default model', async () => {
    const env = await setup(OMP);
    const chain = await resolveRoleChain('scout', env);
    assert.deepEqual(
      chain.map((ref) => `${ref.provider}/${ref.modelId}`),
      ['openai-codex/gpt-5.6-luna', 'zai/glm-5.3-flash', 'devin/swe-2'],
    );
  });

  it('prefers the mmbridge role table and drops denied providers', async () => {
    const env = await setup(OMP, {
      roles: { reviewer: ['openai-codex/gpt-5.6-sol:high', 'xai/grok-4.7', 'xai-oauth/grok-4.6:xhigh'] },
      deny: ['xai/'],
    });
    const chain = await resolveRoleChain('reviewer', env);
    assert.deepEqual(chain, [
      { provider: 'openai-codex', modelId: 'gpt-5.6-sol', thinking: 'high' },
      { provider: 'xai-oauth', modelId: 'grok-4.6', thinking: 'xhigh' },
    ]);
  });
});

describe('dispatch fallback', () => {
  it('moves to the next model on a quota error and records the provider cooldown', async () => {
    const env = await setup(OMP, { roles: { reviewer: ['openai-codex/gpt-5.6-sol', 'zai/glm-5.3'] } });
    process.env.FAKE_OMP_QUOTA = 'openai-codex/gpt-5.6-sol';
    const before = Date.now();
    const result = await dispatch({ role: 'reviewer', task: 't', cwd: tmpdir(), binary: fakeOmp, ...env });
    assert.equal(result.provider, 'zai');
    assert.equal(result.stopReason, 'stop');
    assert.deepEqual(
      result.attempts.map((a) => [`${a.provider}/${a.modelId}`, a.outcome]),
      [
        ['openai-codex/gpt-5.6-sol', 'error'],
        ['zai/glm-5.3', 'ok'],
      ],
    );
    const health = JSON.parse(await readFile(path.join(env.mmbridgeHome, 'provider-health.json'), 'utf8'));
    assert.ok(health['openai-codex'].until >= before + 3_600_000);
    assert.match(health['openai-codex'].reason, /usage limit/);
  });

  it('skips a provider in cooldown without starting a worker for it', async () => {
    const env = await setup(OMP, { roles: { reviewer: ['openai-codex/gpt-5.6-sol', 'zai/glm-5.3'] } });
    await writeFile(
      path.join(env.mmbridgeHome, 'provider-health.json'),
      JSON.stringify({ 'openai-codex': { until: Date.now() + 60_000, reason: 'usage limit' } }),
    );
    const spawnLog = path.join(env.dir, 'spawns.log');
    process.env.FAKE_OMP_SPAWN_LOG = spawnLog;
    const result = await dispatch({ role: 'reviewer', task: 't', cwd: tmpdir(), binary: fakeOmp, ...env });
    assert.equal(result.provider, 'zai');
    assert.deepEqual(
      result.attempts.map((a) => a.outcome),
      ['skipped', 'ok'],
    );
    assert.equal((await readFile(spawnLog, 'utf8')).trim().split('\n').length, 1);
  });

  it('moves on when omp does not know the model', async () => {
    const env = await setup(OMP, { roles: { scout: ['nope/missing', 'zai/glm-5.3-flash'] } });
    process.env.FAKE_OMP_UNKNOWN = 'nope/missing';
    const result = await dispatch({ role: 'scout', task: 't', cwd: tmpdir(), binary: fakeOmp, ...env });
    assert.equal(result.modelId, 'glm-5.3-flash');
    assert.match(result.attempts[0]?.errorMessage ?? '', /Model not found/);
  });

  it('returns the last error with every attempt when the whole chain fails', async () => {
    const env = await setup(OMP, { roles: { reviewer: ['openai-codex/gpt-5.6-sol', 'zai/glm-5.3'] } });
    process.env.FAKE_OMP_QUOTA = 'openai-codex/gpt-5.6-sol,zai/glm-5.3';
    const result = await dispatch({ role: 'reviewer', task: 't', cwd: tmpdir(), binary: fakeOmp, ...env });
    assert.equal(result.stopReason, 'error');
    assert.equal(result.attempts.length, 2);
  });

  it('does not fall back from a pinned model', async () => {
    const env = await setup(OMP);
    process.env.FAKE_OMP_QUOTA = 'openai-codex/gpt-5.6-sol';
    const result = await dispatch({
      role: 'reviewer',
      task: 't',
      cwd: tmpdir(),
      binary: fakeOmp,
      model: 'openai-codex/gpt-5.6-sol',
      ...env,
    });
    assert.equal(result.stopReason, 'error');
    assert.equal(result.attempts.length, 1);
  });

  it('turns off omp internal model fallback so the model mmbridge chose is the one that answers', async () => {
    const env = await setup(OMP);
    process.env.FAKE_OMP_INTERNAL_FALLBACK = 'zai/glm-5.2';
    const result = await dispatch({
      role: 'designer',
      task: 't',
      cwd: tmpdir(),
      binary: fakeOmp,
      model: 'kimi-code/k3',
      ...env,
    });
    assert.equal(`${result.provider}/${result.modelId}`, 'kimi-code/k3');
  });

  it('cools a provider down for an hour on a permission error and moves on', async () => {
    const env = await setup(OMP, { roles: { designer: ['kimi-code/k3', 'zai/glm-5.2'] } });
    process.env.FAKE_OMP_FORBIDDEN = 'kimi-code/k3';
    const before = Date.now();
    const result = await dispatch({ role: 'designer', task: 't', cwd: tmpdir(), binary: fakeOmp, ...env });
    assert.equal(result.modelId, 'glm-5.2');
    const health = JSON.parse(await readFile(path.join(env.mmbridgeHome, 'provider-health.json'), 'utf8'));
    assert.ok(health['kimi-code'].until >= before + 3_600_000);
    assert.match(health['kimi-code'].reason, /permission_error/);
  });
});
