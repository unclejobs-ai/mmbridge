import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { RunResult, RunCommandOptions } from './types.js';

export async function runCommand(
  command: string,
  args: string[] = [],
  options: RunCommandOptions = {},
): Promise<RunResult> {
  const {
    cwd,
    input,
    env = process.env,
    timeoutMs = 120000,
    killGraceMs = 5000,
  } = options;

  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: 'pipe',
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let forcedKill = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (result: RunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(killTimer);
      resolve(result);
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        if (settled) return;
        forcedKill = true;
        child.kill('SIGKILL');
      }, killGraceMs);
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (error: Error) => {
      finish({
        ok: false,
        code: -1,
        stdout,
        stderr: `${stderr}\n${error.message}`.trim(),
        combined: `${stdout}\n${stderr}\n${error.message}`.trim(),
      });
    });

    child.on('close', (code: number | null) => {
      if (timedOut) {
        finish({
          ok: false,
          code: -1,
          stdout,
          stderr: `${stderr}\nCommand timed out after ${timeoutMs}ms${forcedKill ? ` (SIGKILL after ${killGraceMs}ms grace)` : ''}`.trim(),
          combined: `${stdout}\n${stderr}\nCommand timed out after ${timeoutMs}ms${forcedKill ? ` (SIGKILL after ${killGraceMs}ms grace)` : ''}`.trim(),
        });
        return;
      }

      finish({
        ok: code === 0,
        code: code ?? -1,
        stdout,
        stderr,
        combined: `${stdout}\n${stderr}`.trim(),
      });
    });

    if (typeof input === 'string' && input.length > 0) {
      child.stdin.write(input);
    }
    child.stdin.end();
  });
}

export async function commandExists(command: string): Promise<boolean> {
  const result = await runCommand('which', [command], { timeoutMs: 10000 });
  return result.ok;
}

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

export function projectSlug(projectDir: string): string {
  const normalized = path.resolve(projectDir).replace(/[\\/]/g, '-');
  return normalized.startsWith('-') ? normalized : `-${normalized}`;
}

export function classifyFile(filePath: string): string {
  if (filePath.startsWith('convex/')) return 'Backend (Convex)';
  if (filePath.startsWith('app/api/')) return 'API Route';
  if (filePath.startsWith('components/')) return 'UI Component';
  if (filePath.startsWith('stores/')) return 'State (Zustand)';
  if (filePath.startsWith('lib/')) return 'Library';
  if (filePath.startsWith('app/')) return 'Page/Layout';
  return 'Other';
}

export function isPotentialSecretFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  const base = lower.split('/').pop() ?? '';
  if (lower.includes('.env')) return true;
  if (lower.includes('secret')) return true;
  if (lower.includes('credential')) return true;
  if (lower.includes('token')) return true;
  if (lower.includes('key') && !lower.endsWith('.keymap') && !lower.endsWith('.tsx') && !lower.endsWith('.ts')) return true;
  if (/\.(pem|p12|pfx|jks|keystore)$/.test(base)) return true;
  if (/^id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/.test(base)) return true;
  if (base === '.htpasswd' || base === '.pgpass' || base === '.netrc') return true;
  return false;
}

export function isBinaryExtension(filePath: string): boolean {
  return /\.(png|jpg|jpeg|gif|webp|ico|pdf|zip|mp4|mov|webm|woff2?|ttf|otf|wasm|exe|dylib|so|bin)$/i.test(filePath);
}

export async function safeRead(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}

export function limitBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.byteLength <= maxBytes) return text;
  const sliced = buf.subarray(0, maxBytes).toString('utf8');
  return `${sliced}\n\n[truncated by mmbridge]`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
