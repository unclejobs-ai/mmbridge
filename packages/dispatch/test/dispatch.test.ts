import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { dispatch, parseModelRef } from '../dist/index.js';
import { resolveRoleChain } from '../dist/roles.js';

const fakeOmp = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-omp.mjs');
// Isolated mmbridge state so the tests never read the developer's ~/.mmbridge.
const mmbridgeHome = await mkdtemp(path.join(tmpdir(), 'mmbridge-home-'));

async function writeOmpConfig(body: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mmbridge-dispatch-'));
  const file = path.join(dir, 'config.yml');
  await writeFile(file, body);
  return file;
}

describe('parseModelRef', () => {
  it('splits provider, model, and a known thinking suffix', () => {
    assert.deepEqual(parseModelRef('xai-oauth/grok-4.6:xhigh'), {
      provider: 'xai-oauth',
      modelId: 'grok-4.6',
      thinking: 'xhigh',
    });
  });

  it('keeps slashes and non-thinking colons inside the model id', () => {
    assert.deepEqual(parseModelRef('openrouter/qwen/qwen3-coder:free'), {
      provider: 'openrouter',
      modelId: 'qwen/qwen3-coder:free',
    });
  });

  it('rejects a selector without a provider', () => {
    assert.throws(() => parseModelRef('grok-4.6'), /Invalid model selector/);
  });
});

describe('resolveRoleChain', () => {
  it('maps mmbridge roles onto omp modelRoles keys', async () => {
    const config = await writeOmpConfig('modelRoles:\n  advisor: xai-oauth/grok-4.6:high\n  task: zai/glm-5.3\n');
    const sources = { ompConfigPath: config, mmbridgeHome };
    assert.deepEqual(await resolveRoleChain('reviewer', sources), [
      { provider: 'xai-oauth', modelId: 'grok-4.6', thinking: 'high' },
    ]);
    assert.deepEqual(await resolveRoleChain('worker', sources), [{ provider: 'zai', modelId: 'glm-5.3' }]);
  });

  it('fails loudly when the role has no model', async () => {
    const config = await writeOmpConfig('modelRoles:\n  task: zai/glm-5.3\n');
    await assert.rejects(
      resolveRoleChain('designer', { ompConfigPath: config, mmbridgeHome }),
      /No model configured for role "designer"/,
    );
  });
});

describe('dispatch', () => {
  it('resolves the role, sets model and thinking, and returns the final text with usage', async () => {
    const config = await writeOmpConfig('modelRoles:\n  advisor: xai-oauth/grok-4.6:high\n');
    const result = await dispatch({
      role: 'reviewer',
      task: 'check it',
      cwd: tmpdir(),
      ompConfigPath: config,
      binary: fakeOmp,
      mmbridgeHome,
    });
    assert.equal(result.role, 'reviewer');
    assert.equal(result.provider, 'xai-oauth');
    assert.equal(result.modelId, 'grok-4.6');
    assert.equal(result.stopReason, 'stop');
    assert.match(result.text, /^echo:high:You are the reviewer/);
    assert.match(result.text, /check it$/);
    assert.deepEqual(result.usage, { input: 10, output: 5, cacheRead: 1, cacheWrite: 0 });
    assert.equal(result.costUsd, 0.25);
    assert.ok(result.readyMs >= 0 && result.totalMs >= result.readyMs);
  });

  it('honours a pinned model over the role default', async () => {
    const result = await dispatch({
      role: 'scout',
      task: 't',
      cwd: tmpdir(),
      model: 'zai/glm-5.3-flash',
      binary: fakeOmp,
      mmbridgeHome,
    });
    assert.equal(result.provider, 'zai');
    assert.equal(result.modelId, 'glm-5.3-flash');
    assert.match(result.text, /^echo:none:/);
  });

  it('surfaces a provider error as stopReason error instead of throwing', async () => {
    process.env.FAKE_OMP_MODE = 'model-error';
    try {
      const result = await dispatch({
        role: 'scout',
        task: 't',
        cwd: tmpdir(),
        model: 'openai-codex/gpt-5.6-sol',
        binary: fakeOmp,
        mmbridgeHome,
      });
      assert.equal(result.stopReason, 'error');
      assert.equal(result.errorMessage, 'usage_limit_reached');
      assert.equal(result.text, '');
    } finally {
      Reflect.deleteProperty(process.env, 'FAKE_OMP_MODE');
    }
  });

  it('refuses blocking omp dialogs instead of hanging on them', async () => {
    process.env.FAKE_OMP_MODE = 'dialog';
    try {
      const result = await dispatch({
        role: 'scout',
        task: 't',
        cwd: tmpdir(),
        model: 'openai-codex/gpt-5.6-luna',
        binary: fakeOmp,
        mmbridgeHome,
        timeoutMs: 3000,
      });
      assert.equal(result.text, 'ui:cancelled');
      assert.equal(result.stopReason, 'error');
    } finally {
      Reflect.deleteProperty(process.env, 'FAKE_OMP_MODE');
    }
  });

  it('reports omp refusing a pinned model as an error attempt', async () => {
    process.env.FAKE_OMP_MODE = 'reject-model';
    try {
      await assert.rejects(
        dispatch({ role: 'scout', task: 't', cwd: tmpdir(), model: 'nope/missing', binary: fakeOmp, mmbridgeHome }),
        /No model could run role "scout" — nope\/missing: omp rejected set_model: Model not found/,
      );
    } finally {
      Reflect.deleteProperty(process.env, 'FAKE_OMP_MODE');
    }
  });

  it('rejects when omp cannot be started', async () => {
    await assert.rejects(
      dispatch({
        role: 'scout',
        task: 't',
        cwd: tmpdir(),
        model: 'zai/glm-5.3',
        binary: '/nonexistent/omp',
        mmbridgeHome,
      }),
      /No model could run role "scout" — zai\/glm-5.3: (Failed to start omp|omp exited)/,
    );
  });
});
