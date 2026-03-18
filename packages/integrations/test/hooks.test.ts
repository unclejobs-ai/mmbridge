import assert from 'node:assert/strict';
import test from 'node:test';
import { generateHookConfig } from '../dist/hooks.js';

test('generateHookConfig uses warn-only gate commands', () => {
  const config = generateHookConfig() as Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
  const userPromptHook = config.UserPromptSubmit?.[0]?.hooks?.[0]?.command ?? '';
  const preToolUseHook = config.PreToolUse?.[0]?.hooks?.[0]?.command ?? '';

  assert.match(userPromptHook, /mmbridge gate --format compact --project "\$PWD" \|\| true/);
  assert.match(preToolUseHook, /mmbridge gate --format compact --project "\$PWD" \|\| true/);
  assert.doesNotMatch(userPromptHook, /mmbridge review/);
});
