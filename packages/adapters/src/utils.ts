import type { RunResult, RunCommandOptions } from '@mmbridge/core';

async function loadCoreUtils(): Promise<{
  commandExists: (cmd: string) => Promise<boolean>;
  runCommand: (cmd: string, args: string[], opts?: RunCommandOptions) => Promise<RunResult>;
}> {
  try {
    return await import('@mmbridge/core');
  } catch {
    return import('../../../core/src/utils.js') as never;
  }
}

export async function ensureBinary(binary: string): Promise<void> {
  const { commandExists } = await loadCoreUtils();
  const exists = await commandExists(binary);
  if (!exists) {
    throw new Error(`${binary} CLI not found in PATH`);
  }
}

export async function invoke(
  command: string,
  args: string[],
  options: RunCommandOptions = {},
): Promise<RunResult> {
  const { runCommand } = await loadCoreUtils();
  return runCommand(command, args, options);
}

export function parseExternalSessionId(
  rawOutput: unknown,
  fallback: string | null,
): string | null {
  const text = String(rawOutput ?? '');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        'type' in parsed &&
        'thread_id' in parsed &&
        (parsed as Record<string, unknown>).type === 'thread.started' &&
        typeof (parsed as Record<string, unknown>).thread_id === 'string' &&
        (parsed as Record<string, unknown>).thread_id
      ) {
        return (parsed as Record<string, unknown>).thread_id as string;
      }
    } catch {
      // ignore non-json lines in mixed stdout/stderr output
    }
  }

  const patterns = [
    /session\s*id\s*[:=]\s*([a-zA-Z0-9_-]+)/i,
    /session\s+([0-9a-f-]{8,})/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1];
  }
  return fallback ?? null;
}
