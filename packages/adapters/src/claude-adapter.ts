import fs from 'node:fs/promises';
import path from 'node:path';
import type { AdapterDefinition, AdapterResult } from './types.js';
import { assertCliSuccess, ensureBinary, invoke, parseExternalSessionId } from './utils.js';

export async function runClaudeReview({
  workspace,
  onStdout,
  onStderr,
}: {
  workspace: string;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}): Promise<AdapterResult> {
  await ensureBinary('claude');
  const prompt = await fs.readFile(path.join(workspace, 'prompt', 'claude.md'), 'utf8');
  const args = ['-p', prompt, '--allowedTools', 'Read,Grep,Glob', '--output-format', 'json', '--model', 'sonnet'];
  const result = await invoke('claude', args, { cwd: workspace, timeoutMs: 300_000, onStdout, onStderr });
  assertCliSuccess('claude', result);
  const { text, sessionId: externalSessionId } = parseClaudeOutput(result.combined);
  return {
    tool: 'claude',
    externalSessionId,
    followupSupported: Boolean(externalSessionId),
    command: 'claude',
    args,
    ...result,
    text,
  };
}

export async function runClaudeFollowup({
  workspace,
  sessionId,
  prompt,
}: {
  workspace: string;
  sessionId: string;
  prompt: string;
}): Promise<AdapterResult> {
  await ensureBinary('claude');
  const args = ['-p', prompt, '-r', sessionId, '--output-format', 'json', '--model', 'sonnet'];
  const result = await invoke('claude', args, { cwd: workspace, timeoutMs: 300_000 });
  assertCliSuccess('claude', result);
  const { text } = parseClaudeOutput(result.combined);
  return {
    tool: 'claude',
    externalSessionId: sessionId,
    followupSupported: true,
    command: 'claude',
    args,
    ...result,
    text,
  };
}

function parseClaudeOutput(raw: string): { text: string; sessionId: string | null } {
  let text: string | null = null;
  let sessionId: string | null = null;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (text === null && typeof parsed.result === 'string') text = parsed.result;
      if (sessionId === null && typeof parsed.session_id === 'string') sessionId = parsed.session_id;
    } catch {
      /* skip */
    }
  }
  return {
    text: text ?? raw,
    sessionId: sessionId ?? parseExternalSessionId(raw, null),
  };
}

export const claudeAdapter: AdapterDefinition = {
  name: 'claude',
  binary: 'claude',
  review: (options) => runClaudeReview(options),
  followup: (options) => runClaudeFollowup(options),
};
