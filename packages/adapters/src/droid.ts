import path from 'node:path';
import fs from 'node:fs/promises';
import { ensureBinary, invoke, parseExternalSessionId, assertCliSuccess } from './utils.js';
import type { AdapterDefinition, AdapterResult } from './types.js';

export async function runDroidReview({
  workspace,
  onStdout,
  onStderr,
}: {
  workspace: string;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}): Promise<AdapterResult> {
  await ensureBinary('droid');
  const prompt = await fs.readFile(path.join(workspace, 'prompt', 'droid.md'), 'utf8');
  const args = ['exec', '--auto', 'high', '--cwd', workspace, '-o', 'text', prompt];
  const result = await invoke('droid', args, { cwd: workspace, timeoutMs: 300_000, onStdout, onStderr });
  assertCliSuccess('droid', result);
  const externalSessionId = parseExternalSessionId(result.combined, null);
  return {
    tool: 'droid',
    externalSessionId,
    followupSupported: Boolean(externalSessionId),
    command: 'droid',
    args,
    ...result,
    text: result.combined,
  };
}

export async function runDroidFollowup({
  workspace,
  sessionId,
  prompt,
}: {
  workspace: string;
  sessionId: string;
  prompt: string;
}): Promise<AdapterResult> {
  await ensureBinary('droid');
  const args = ['exec', '-s', sessionId, '--cwd', workspace, prompt];
  const result = await invoke('droid', args, { cwd: workspace, timeoutMs: 300_000 });
  assertCliSuccess('droid', result);
  return {
    tool: 'droid',
    externalSessionId: sessionId,
    followupSupported: true,
    command: 'droid',
    args,
    ...result,
    text: result.combined,
  };
}

export const droidAdapter: AdapterDefinition = {
  name: 'droid',
  binary: 'droid',
  review: (options) => runDroidReview({ workspace: options.workspace, onStdout: options.onStdout, onStderr: options.onStderr }),
  followup: (options) => runDroidFollowup(options),
};
