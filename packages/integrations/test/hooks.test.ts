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

test('generateHookConfig reads Claude Code PreToolUse stdin JSON instead of TOOL_INPUT env only', () => {
  const config = generateHookConfig() as Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
  const preToolUseHook = config.PreToolUse?.[0]?.hooks?.[0]?.command ?? '';

  assert.match(preToolUseHook, /python3 -c/);
  assert.match(preToolUseHook, /import json,re,sys/);
  assert.match(preToolUseHook, /tool_input/);
  assert.match(preToolUseHook, /command/);
  assert.match(preToolUseHook, /git\\s\+\(\?:\\s\+-C\\s\+\\S\+\)\?\\s\+push/);
  assert.doesNotMatch(preToolUseHook, /TOOL_INPUT/);
});
