import fs from 'node:fs/promises';
import path from 'node:path';
import type { AdapterDefinition, AdapterResult } from './types.js';
import { assertCliSuccess, ensureBinary, invoke } from './utils.js';

async function resolvePiPromptPath(workspace: string): Promise<string> {
  const piPromptPath = path.join(workspace, 'prompt', 'pi.md');
  try {
    await fs.access(piPromptPath);
    return piPromptPath;
  } catch {
    return path.join(workspace, 'prompt', 'kimi.md');
  }
}

export async function runPiReview({
  workspace,
  onStdout,
  onStderr,
}: {
  workspace: string;
  _sessionId?: string;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}): Promise<AdapterResult> {
  await ensureBinary('acpx');
  const promptPath = await resolvePiPromptPath(workspace);
  const args = ['--format', 'text', '--approve-reads', 'pi', 'exec', '-f', promptPath];
  const result = await invoke('acpx', args, { cwd: workspace, timeoutMs: 600000, onStdout, onStderr });
  assertCliSuccess('pi', result);
  return {
    tool: 'pi',
    externalSessionId: null,
    followupSupported: false,
    command: 'acpx',
    args,
    ...result,
    text: result.combined,
  };
}

export async function runPiFollowup(_: {
  workspace: string;
  sessionId: string;
  prompt: string;
}): Promise<AdapterResult> {
  throw new Error('Pi adapter does not support follow-up sessions');
}

export const piAdapter: AdapterDefinition = {
  name: 'pi',
  binary: 'acpx',
  capabilities: { readOnly: false, followup: false },
  review: (options) => runPiReview(options),
  followup: (options) => runPiFollowup(options),
};
