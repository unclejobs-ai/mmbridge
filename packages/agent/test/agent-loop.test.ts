import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentLoop, parseToolInputJson, resolveAgentAuthKey } from '../dist/agent-loop.js';

test('resolveAgentAuthKey prefers the explicit key over the environment', () => {
  assert.deepEqual(resolveAgentAuthKey('explicit-key', 'env-key'), { key: 'explicit-key', isOAuthToken: false });
});

test('resolveAgentAuthKey falls back to the environment then to an empty key', () => {
  assert.deepEqual(resolveAgentAuthKey(undefined, 'env-key'), { key: 'env-key', isOAuthToken: false });
  assert.deepEqual(resolveAgentAuthKey(undefined, undefined), { key: '', isOAuthToken: false });
});

test('resolveAgentAuthKey classifies OAuth tokens and plain API keys', () => {
  assert.equal(resolveAgentAuthKey('sk-ant-oat01-example', undefined).isOAuthToken, true);
  assert.equal(resolveAgentAuthKey('eyJhbGciOiJub25lIn0.payload.sig', undefined).isOAuthToken, true);
  assert.equal(resolveAgentAuthKey('sk-ant-api03-example', undefined).isOAuthToken, false);
  assert.equal(resolveAgentAuthKey('', '').isOAuthToken, false);
});

test('parseToolInputJson parses accumulated tool-input JSON deltas', () => {
  assert.deepEqual(parseToolInputJson('{"file":"a.ts"}'), { file: 'a.ts' });
  assert.deepEqual(parseToolInputJson('[1,2,3]'), [1, 2, 3]);
  assert.deepEqual(parseToolInputJson('"raw"'), 'raw');
});

test('parseToolInputJson yields an empty object for empty or malformed input', () => {
  assert.deepEqual(parseToolInputJson(''), {});
  assert.deepEqual(parseToolInputJson('{"file":'), {});
  assert.deepEqual(parseToolInputJson('not json'), {});
});

test('AgentLoop initialises an empty session without network access', () => {
  const loop = new AgentLoop({
    model: 'claude-test',
    apiKey: 'test-key',
    systemPrompt: 'test prompt',
    tools: [],
    maxTurns: 3,
  });
  assert.deepEqual(loop.getSession(), { messages: [], totalTokens: { input: 0, output: 0 }, turnCount: 0 });
});
