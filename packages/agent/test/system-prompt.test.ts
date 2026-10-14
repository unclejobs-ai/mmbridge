import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSystemPrompt } from '../dist/system-prompt.js';
import type { AgentTool } from '../dist/types.js';

function fakeTool(name: string, description: string): AgentTool {
  return { name, description, inputSchema: { type: 'object' }, execute: async () => 'ok' };
}

test('buildSystemPrompt includes identity and default language instruction', () => {
  const prompt = buildSystemPrompt();
  assert.match(prompt, /You are mmbridge/);
  assert.match(prompt, /Respond in the same language the user writes in\./);
  assert.doesNotMatch(prompt, /## Available Tools/);
  assert.doesNotMatch(prompt, /## Project Context/);
});

test('buildSystemPrompt lists tools under Available Tools', () => {
  const prompt = buildSystemPrompt({
    tools: [fakeTool('mmbridge_review', 'Run a review'), fakeTool('mmbridge_gate', 'Check coverage')],
  });
  assert.match(prompt, /## Available Tools/);
  assert.match(prompt, /- \*\*mmbridge_review\*\*: Run a review/);
  assert.match(prompt, /- \*\*mmbridge_gate\*\*: Check coverage/);
});

test('buildSystemPrompt renders branch and changed-file context', () => {
  const prompt = buildSystemPrompt({
    projectContext: { branch: 'feat/demo', changedFiles: ['src/a.ts', 'src/b.ts'] },
  });
  assert.match(prompt, /## Project Context/);
  assert.match(prompt, /- Branch: `feat\/demo`/);
  assert.match(prompt, /- Changed files:\n {2}- src\/a\.ts\n {2}- src\/b\.ts/);
});

test('buildSystemPrompt omits empty context fields', () => {
  const prompt = buildSystemPrompt({ projectContext: { branch: '', changedFiles: [] } });
  assert.doesNotMatch(prompt, /Branch:/);
  assert.doesNotMatch(prompt, /Changed files:/);
});

test('buildSystemPrompt honors explicit language and falls back on empty string', () => {
  assert.match(buildSystemPrompt({ language: 'Korean' }), /Respond in Korean\./);
  assert.match(buildSystemPrompt({ language: '' }), /Respond in the same language the user writes in\./);
});
