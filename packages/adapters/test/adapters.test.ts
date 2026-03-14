import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUuid } from '../dist/qwen.js';
import { parseExternalSessionId } from '../dist/utils.js';
import { buildCodexExecArgs, buildCodexResumeArgs, requireCodexWorkspace } from '../dist/codex.js';

test('normalizeUuid returns a valid UUID unchanged', () => {
  const uuid = '550e8400-e29b-41d4-a716-446655440000';
  assert.equal(normalizeUuid(uuid), uuid);
});

test('normalizeUuid generates a new UUID for invalid input', () => {
  const result = normalizeUuid('not-a-uuid');
  assert.match(
    result,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
});

test('normalizeUuid generates a new UUID for empty string', () => {
  const result = normalizeUuid('');
  assert.match(
    result,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
});

test('normalizeUuid generates a new UUID for null', () => {
  const result = normalizeUuid(null);
  assert.match(
    result,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
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
  await assert.rejects(
    requireCodexWorkspace('/nonexistent/path/xyz'),
    { message: /Codex follow-up workspace is no longer available/ },
  );
});

test('requireCodexWorkspace returns workspace path when directory exists', async () => {
  const result = await requireCodexWorkspace('/tmp');
  assert.equal(result, '/tmp');
});
