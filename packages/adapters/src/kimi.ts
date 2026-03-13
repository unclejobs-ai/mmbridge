import path from 'node:path';
import fs from 'node:fs/promises';
import { ensureBinary, invoke } from './utils.js';
import type { AdapterResult } from './types.js';

export async function runKimiReview({
  workspace,
  sessionId,
}: {
  workspace: string;
  sessionId?: string;
}): Promise<AdapterResult> {
  await ensureBinary('kimi');
  const prompt = await fs.readFile(path.join(workspace, 'prompt', 'kimi.md'), 'utf8');
  const args = ['-w', workspace, '-S', sessionId ?? '', '--quiet', '-p', prompt];
  const result = await invoke('kimi', args, { cwd: workspace, timeoutMs: 300000 });
  return {
    tool: 'kimi',
    externalSessionId: sessionId ?? null,
    followupSupported: true,
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
  await ensureBinary('kimi');
  const args = ['-w', workspace, '-S', sessionId, '--quiet', '-p', prompt];
  const result = await invoke('kimi', args, { cwd: workspace, timeoutMs: 300000 });
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
