import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AdapterDefinition, AdapterResult } from './types.js';
import { assertCliSuccess, assertSafeSessionId, ensureBinary, invoke } from './utils.js';

export async function runQwenReview({
  workspace,
  sessionId,
  onStdout,
  onStderr,
}: {
  workspace: string;
  sessionId?: string;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}): Promise<AdapterResult> {
  await ensureBinary('qwen');
  const prompt = await fs.readFile(path.join(workspace, 'prompt', 'qwen.md'), 'utf8');
  const resolvedSessionId = normalizeUuid(sessionId);
  const args = ['--session-id', resolvedSessionId, '--chat-recording', '--yolo', '-p', prompt];
  const result = await invoke('qwen', args, { cwd: workspace, timeoutMs: 300000, onStdout, onStderr });
  assertCliSuccess('qwen', result);
  return {
    tool: 'qwen',
    externalSessionId: resolvedSessionId,
    followupSupported: true,
    command: 'qwen',
    args,
    ...result,
    text: result.combined,
  };
}

export async function runQwenFollowup({
  workspace,
  sessionId,
  prompt,
}: {
  workspace: string;
  sessionId: string;
  prompt: string;
}): Promise<AdapterResult> {
  assertSafeSessionId(sessionId);
  await ensureBinary('qwen');
  const args = ['--resume', sessionId, '--chat-recording', '--yolo', '-p', prompt];
  const result = await invoke('qwen', args, { cwd: workspace, timeoutMs: 300000 });
  assertCliSuccess('qwen', result);
  return {
    tool: 'qwen',
    externalSessionId: sessionId,
    followupSupported: true,
    command: 'qwen',
    args,
    ...result,
    text: result.combined,
  };
}

export function normalizeUuid(sessionId: string | undefined | null): string {
  const value = String(sessionId ?? '').trim();
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (uuidRegex.test(value)) return value;
  return randomUUID();
}

export const qwenAdapter: AdapterDefinition = {
  name: 'qwen',
  binary: 'qwen',
  review: (options) => runQwenReview(options),
  followup: (options) => runQwenFollowup(options),
};
