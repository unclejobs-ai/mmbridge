import assert from 'node:assert/strict';
import test from 'node:test';
import { selectSetupAuthStrategy } from '../dist/setup.js';

test('selectSetupAuthStrategy uses Claude setup-token only for anthropic OAuth without env key', () => {
  assert.equal(selectSetupAuthStrategy('anthropic', 'oauth', false), 'claude-setup-token');
  assert.equal(selectSetupAuthStrategy('openai', 'oauth', false), 'oauth-browser');
});

test('selectSetupAuthStrategy prefers env key when present', () => {
  assert.equal(selectSetupAuthStrategy('anthropic', 'oauth', true), 'env-api-key');
  assert.equal(selectSetupAuthStrategy('openai', 'oauth', true), 'env-api-key');
});

test('selectSetupAuthStrategy uses api-key flow for api-key providers', () => {
  assert.equal(selectSetupAuthStrategy('qwen', 'api-key', false), 'api-key');
});
