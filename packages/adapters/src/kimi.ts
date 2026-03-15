import path from 'node:path';
import fs from 'node:fs/promises';
import { ensureBinary, invoke, assertSafeSessionId, assertCliSuccess } from './utils.js';
import type { AdapterDefinition, AdapterResult } from './types.js';

export async function runKimiReview({
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
  if (sessionId) assertSafeSessionId(sessionId);
  await ensureBinary('kimi');
  const prompt = await fs.readFile(path.join(workspace, 'prompt', 'kimi.md'), 'utf8');
  const args = ['-w', workspace, ...(sessionId ? ['-S', sessionId] : []), '--quiet', '-p', prompt];
  const result = await invoke('kimi', args, { cwd: workspace, timeoutMs: 300000, onStdout, onStderr });
  assertCliSuccess('kimi', result);
  return {
    tool: 'kimi',
    externalSessionId: sessionId ?? null,
    followupSupported: Boolean(sessionId),
    command: 'kimi',
    args,
    ...result,
    text: result.combined,
  };
}

export async function runKimiFollowup({
  workspace,
  sessionId,
  prompt,
}: {
  workspace: string;
  sessionId: string;
  prompt: string;
}): Promise<AdapterResult> {
  assertSafeSessionId(sessionId);
  await ensureBinary('kimi');
  const args = ['-w', workspace, '-S', sessionId, '--quiet', '-p', prompt];
  const result = await invoke('kimi', args, { cwd: workspace, timeoutMs: 300000 });
  assertCliSuccess('kimi', result);
  return {
    tool: 'kimi',
    externalSessionId: sessionId,
    followupSupported: true,
    command: 'kimi',
    args,
    ...result,
    text: result.combined,
  };
}

export const kimiAdapter: AdapterDefinition = {
  name: 'kimi',
  binary: 'kimi',
  review: (options) => runKimiReview(options),
  followup: (options) => runKimiFollowup(options),
};
