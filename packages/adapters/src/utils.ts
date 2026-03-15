import path from 'node:path';
import type { RunCommandOptions, RunResult } from '@mmbridge/core';

async function loadCoreUtils(): Promise<{
  commandExists: (cmd: string) => Promise<boolean>;
  runCommand: (cmd: string, args: string[], opts?: RunCommandOptions) => Promise<RunResult>;
}> {
  return import('@mmbridge/core');
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
  options: RunCommandOptions & {
    onStdout?: (chunk: string) => void;
    onStderr?: (chunk: string) => void;
  } = {},
): Promise<RunResult> {
  const { runCommand } = await loadCoreUtils();
  return runCommand(command, args, options);
}

/** Validate session ID is safe for use as CLI argument */
export function assertSafeSessionId(id: string): void {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) {
    throw new Error(`Invalid session ID format: ${id}`);
  }
}

/** Check if a file path is contained within a root directory */
export function isPathContained(filePath: string, root: string): boolean {
  const resolved = path.resolve(filePath);
  const resolvedRoot = path.resolve(root);
  return resolved.startsWith(resolvedRoot + path.sep) || resolved === resolvedRoot;
}

/** Assert CLI command succeeded, throw with truncated stderr on failure */
export function assertCliSuccess(tool: string, result: RunResult): void {
  if (!result.ok) {
    throw new Error(`${tool} CLI exited with code ${result.code}: ${result.stderr.slice(0, 500)}`);
  }
}

export function parseExternalSessionId(rawOutput: unknown, fallback: string | null): string | null {
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

  const patterns = [/session\s*id\s*[:=]\s*([a-zA-Z0-9_-]+)/i, /session\s+([0-9a-f-]{8,})/i];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1];
  }
  return fallback ?? null;
}
