import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildCodexExecArgs,
  buildCodexResumeArgs,
  buildCodexReviewPrompt,
  buildCodexTaskArgs,
  requireCodexWorkspace,
  runCodexTask,
} from '../dist/codex.js';
import { buildGeminiReviewArgs } from '../dist/gemini.js';
import { runTaskAdapter } from '../dist/index.js';
import { normalizeUuid } from '../dist/qwen.js';
import { parseExternalSessionId } from '../dist/utils.js';

test('normalizeUuid returns a valid UUID unchanged', () => {
  const uuid = '550e8400-e29b-41d4-a716-446655440000';
  assert.equal(normalizeUuid(uuid), uuid);
});

test('normalizeUuid generates a new UUID for invalid input', () => {
  const result = normalizeUuid('not-a-uuid');
  assert.match(result, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
});

test('normalizeUuid generates a new UUID for empty string', () => {
  const result = normalizeUuid('');
  assert.match(result, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
});

test('normalizeUuid generates a new UUID for null', () => {
  const result = normalizeUuid(null);
  assert.match(result, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
});

test('parseExternalSessionId returns fallback when output is empty', () => {
  assert.equal(parseExternalSessionId('', 'fallback-id'), 'fallback-id');
});

test('parseExternalSessionId extracts thread_id from thread.started JSON line', () => {
  const raw = 'some noise\n{"type":"thread.started","thread_id":"abc-123"}\nmore noise';
  assert.equal(parseExternalSessionId(raw, null), 'abc-123');
});

test('parseExternalSessionId extracts session id via regex pattern', () => {
  const raw = 'Session ID: sess-abc123';
  assert.equal(parseExternalSessionId(raw, null), 'sess-abc123');
});

test('parseExternalSessionId returns null when no session id found and fallback is null', () => {
  assert.equal(parseExternalSessionId('no session here', null), null);
});

test('buildCodexExecArgs returns expected codex exec argument list', () => {
  const args = buildCodexExecArgs({
    workspace: '/tmp/ws',
    outputPath: '/tmp/ws/.codex-review-uuid.txt',
  });
  assert.deepEqual(args, [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
    '-C',
    '/tmp/ws',
    '-o',
    '/tmp/ws/.codex-review-uuid.txt',
    '-',
  ]);
});

test('buildCodexTaskArgs isolates a read-only one-shot task', () => {
  const args = buildCodexTaskArgs({
    cwd: '/tmp/repo',
    outputPath: '/tmp/mmbridge-output.txt',
  });
  assert.deepEqual(args, [
    'exec',
    '--ignore-user-config',
    '--ephemeral',
    '--json',
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
    '-C',
    '/tmp/repo',
    '-o',
    '/tmp/mmbridge-output.txt',
    '-',
  ]);
});

test('buildCodexResumeArgs returns expected codex resume argument list', () => {
  const args = buildCodexResumeArgs({
    workspace: '/tmp/ws',
    sessionId: 'sess-xyz',
    outputPath: '/tmp/ws/.codex-followup-uuid.txt',
  });
  assert.deepEqual(args, [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
    '-C',
    '/tmp/ws',
    '-o',
    '/tmp/ws/.codex-followup-uuid.txt',
    'resume',
    'sess-xyz',
    '-',
  ]);
});

test('requireCodexWorkspace throws when workspace directory does not exist', async () => {
  await assert.rejects(requireCodexWorkspace('/nonexistent/path/xyz'), {
    message: /Codex follow-up workspace is no longer available/,
  });
});

test('requireCodexWorkspace returns workspace path when directory exists', async () => {
  const result = await requireCodexWorkspace('/tmp');
  assert.equal(result, '/tmp');
});

test('buildCodexReviewPrompt points changed file mirrors at workspace files', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mmbridge-codex-prompt-'));
  try {
    await fs.mkdir(path.join(tmpDir, 'prompt'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'prompt', 'codex.md'), '# Base prompt', 'utf8');
    await fs.writeFile(path.join(tmpDir, 'context.md'), '# Context', 'utf8');

    const prompt = await buildCodexReviewPrompt({
      workspace: tmpDir,
      changedFiles: ['src/user-log.ts'],
    });

    assert.match(prompt, /files\/src\/user-log\.ts/);
    assert.doesNotMatch(prompt, /changed-files\/src\/user-log\.ts/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('buildGeminiReviewArgs puts the prompt before file attachments', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mmbridge-gemini-args-'));
  try {
    await fs.mkdir(path.join(tmpDir, 'files', 'src'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'files', 'src', 'user-log.ts'), 'export const x = 1;\n', 'utf8');

    const args = await buildGeminiReviewArgs({
      workspace: tmpDir,
      changedFiles: ['src/user-log.ts'],
      prompt: '# Review prompt',
    });

    assert.equal(args[0], 'run');
    assert.equal(args[1], '# Review prompt');
    assert.ok(args.indexOf('# Review prompt') < args.indexOf('-f'));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('runTaskAdapter enforces the read-only capability at the public API boundary', async () => {
  await assert.rejects(
    runTaskAdapter('pi', { cwd: '/tmp', task: 'inspect', readonly: true }),
    /does not support declared read-only task runs/,
  );
});

test('runCodexTask times out without leaking its temporary directory', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'mmbridge-codex-timeout-'));
  const binary = path.join(cwd, 'slow-codex.mjs');
  await fs.writeFile(
    binary,
    `#!${process.execPath}\nawait new Promise((resolve) => setTimeout(resolve, 10_000));\n`,
    'utf8',
  );
  await fs.chmod(binary, 0o755);

  try {
    const result = await runCodexTask({ cwd, task: 'inspect', readonly: true, binary, timeoutMs: 25 });
    assert.equal(result.ok, false);
    assert.equal(result.code, -1);
    const outputIndex = result.args.indexOf('-o');
    assert.ok(outputIndex >= 0);
    await assert.rejects(fs.access(path.dirname(result.args[outputIndex + 1])));
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('runCodexTask fails instead of exposing a raw transcript when no final message exists', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'mmbridge-codex-empty-'));
  const binary = path.join(cwd, 'empty-codex.mjs');
  await fs.writeFile(
    binary,
    `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'private file contents' } }) + '\\n');\n`,
    'utf8',
  );
  await fs.chmod(binary, 0o755);

  try {
    const result = await runCodexTask({ cwd, task: 'inspect', readonly: true, binary });
    assert.equal(result.ok, false);
    assert.equal(result.text, '');
    assert.doesNotMatch(result.text, /private file contents/);
    assert.match(result.stderr, /without a final agent message/);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('buildGeminiReviewArgs attaches changed files from workspace files directory', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mmbridge-gemini-files-'));
  try {
    await fs.mkdir(path.join(tmpDir, 'files', 'src'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'files', 'src', 'user-log.ts'), 'export const x = 1;\n', 'utf8');

    const args = await buildGeminiReviewArgs({
      workspace: tmpDir,
      changedFiles: ['src/user-log.ts'],
      prompt: '# Review prompt',
    });

    const argText = args.join(' ');
    assert.match(argText, /files\/src\/user-log\.ts/);
    assert.doesNotMatch(argText, /changed-files\/src\/user-log\.ts/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
