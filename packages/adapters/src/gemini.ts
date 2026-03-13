import path from 'node:path';
import fs from 'node:fs/promises';
import { ensureBinary, invoke, parseExternalSessionId } from './utils.js';
import type { AdapterResult } from './types.js';

export async function runGeminiReview({
  workspace,
  changedFiles,
}: {
  workspace: string;
  changedFiles: string[];
}): Promise<AdapterResult> {
  await ensureBinary('opencode');
  const prompt = await fs.readFile(path.join(workspace, 'prompt', 'gemini.md'), 'utf8');
  const args = ['run', '--model', 'google/gemini-3.1-pro-preview', '--format', 'json'];
  const fileArgs: string[] = [path.join(workspace, 'context.md')];
  for (const file of changedFiles.slice(0, 12)) {
    const candidate = path.join(workspace, 'changed-files', file);
    if (await fileExists(candidate)) fileArgs.push(candidate);
  }
  for (const file of fileArgs) args.push('-f', file);
  args.push(prompt);
  const result = await invoke('opencode', args, { cwd: workspace, timeoutMs: 300000 });
  const externalSessionId = parseExternalSessionId(result.combined, null);
  return {
    tool: 'gemini',
    externalSessionId,
    followupSupported: true,
    command: 'opencode',
    args,
    ...result,
    text: extractTextFromOpencode(result.combined),
  };
}

export async function runGeminiFollowup({
  workspace,
  sessionId,
  prompt,
}: {
  workspace: string;
  sessionId: string;
  prompt: string;
}): Promise<AdapterResult> {
  await ensureBinary('opencode');
  const args = [
    'run',
    '-s',
    sessionId,
    '--model',
    'google/gemini-3.1-pro-preview',
    '--format',
    'json',
    prompt,
  ];
  const result = await invoke('opencode', args, { cwd: workspace, timeoutMs: 300000 });
  return {
    tool: 'gemini',
    externalSessionId: sessionId,
    followupSupported: true,
    command: 'opencode',
    args,
    ...result,
    text: extractTextFromOpencode(result.combined),
  };
}

function extractTextFromOpencode(raw: string): string {
  const lines = raw.split('\n');
  const chunks: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        'type' in parsed &&
        'part' in parsed
      ) {
        const record = parsed as Record<string, unknown>;
        const part = record.part as Record<string, unknown> | undefined;
        if (record.type === 'text' && typeof part?.text === 'string') {
          chunks.push(part.text);
        }
      }
    } catch {
      /* ignore */
    }
  }
  return chunks.length ? chunks.join('\n') : raw;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}
