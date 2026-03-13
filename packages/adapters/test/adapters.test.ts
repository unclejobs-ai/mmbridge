import { describe, it, expect } from 'vitest';
import { normalizeUuid } from '../src/qwen.js';
import { parseExternalSessionId } from '../src/utils.js';
import {
  buildCodexExecArgs,
  buildCodexResumeArgs,
  requireCodexWorkspace,
} from '../src/codex.js';

describe('normalizeUuid', () => {
  it('returns a valid UUID unchanged', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    expect(normalizeUuid(uuid)).toBe(uuid);
  });

  it('generates a new UUID when input is not a valid UUID', () => {
    const result = normalizeUuid('not-a-uuid');
    expect(result).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('generates a new UUID when input is empty', () => {
    const result = normalizeUuid('');
    expect(result).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('generates a new UUID when input is null', () => {
    const result = normalizeUuid(null);
    expect(result).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });
});

describe('parseExternalSessionId', () => {
  it('returns fallback when output is empty', () => {
    expect(parseExternalSessionId('', 'fallback-id')).toBe('fallback-id');
  });

  it('extracts thread_id from thread.started JSON line', () => {
    const raw = 'some noise\n{"type":"thread.started","thread_id":"abc-123"}\nmore noise';
    expect(parseExternalSessionId(raw, null)).toBe('abc-123');
  });

  it('extracts session id via regex pattern', () => {
    const raw = 'Session ID: sess-abc123';
    expect(parseExternalSessionId(raw, null)).toBe('sess-abc123');
  });

  it('returns null when no session id found and fallback is null', () => {
    expect(parseExternalSessionId('no session here', null)).toBeNull();
  });
});

describe('buildCodexExecArgs', () => {
  it('returns expected codex exec argument list', () => {
    const args = buildCodexExecArgs({
      workspace: '/tmp/ws',
      prompt: 'review this',
      outputPath: '/tmp/ws/.codex-review-uuid.txt',
    });
    expect(args).toEqual([
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
});

describe('buildCodexResumeArgs', () => {
  it('returns expected codex resume argument list', () => {
    const args = buildCodexResumeArgs({
      workspace: '/tmp/ws',
      sessionId: 'sess-xyz',
      outputPath: '/tmp/ws/.codex-followup-uuid.txt',
    });
    expect(args).toEqual([
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
});

describe('requireCodexWorkspace', () => {
  it('throws when workspace directory does not exist', async () => {
    await expect(requireCodexWorkspace('/nonexistent/path/xyz')).rejects.toThrow(
      'Codex follow-up workspace is no longer available',
    );
  });

  it('returns workspace path when directory exists', async () => {
    const result = await requireCodexWorkspace('/tmp');
    expect(result).toBe('/tmp');
  });
});
