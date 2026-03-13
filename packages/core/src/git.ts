import { runCommand } from './utils.js';
import type { HeadMeta, RunResult, GitStatusSummary } from './types.js';

export async function getHead(cwd?: string): Promise<HeadMeta> {
  const shaResult: RunResult = await runCommand('git', ['rev-parse', '--short', 'HEAD'], { cwd });
  const branchResult: RunResult = await runCommand('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
  return {
    sha: shaResult.stdout.trim() || 'unknown',
    branch: branchResult.stdout.trim() || 'unknown',
  };
}

export async function getChangedFiles(baseRef: string, cwd?: string): Promise<string[]> {
  const result: RunResult = await runCommand(
    'git',
    ['diff', '--name-only', baseRef, 'HEAD'],
    { cwd },
  );
  if (!result.ok) return [];
  return result.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

export async function getStagedFiles(cwd?: string): Promise<string[]> {
  const result: RunResult = await runCommand(
    'git',
    ['diff', '--name-only', '--cached'],
    { cwd },
  );
  if (!result.ok) return [];
  return result.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

export async function getUnstagedFiles(cwd?: string): Promise<string[]> {
  const result: RunResult = await runCommand(
    'git',
    ['diff', '--name-only'],
    { cwd },
  );
  if (!result.ok) return [];
  return result.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

export async function getUntrackedFiles(cwd?: string): Promise<string[]> {
  const result: RunResult = await runCommand(
    'git',
    ['ls-files', '--others', '--exclude-standard'],
    { cwd },
  );
  if (!result.ok) return [];
  return result.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

export async function getGitStatusSummary(cwd?: string): Promise<GitStatusSummary> {
  const staged = await getStagedFiles(cwd);
  const unstaged = await getUnstagedFiles(cwd);
  const untracked = await getUntrackedFiles(cwd);
  return {
    staged: staged.length,
    unstaged: unstaged.length,
    untracked: untracked.length,
    clean: staged.length === 0 && unstaged.length === 0 && untracked.length === 0,
  };
}

export async function getDiff(baseRef: string, cwd?: string): Promise<string> {
  const result: RunResult = await runCommand(
    'git',
    ['diff', baseRef, 'HEAD'],
    { cwd },
  );
  return result.ok ? result.stdout : '';
}

export async function getDefaultBaseRef(cwd?: string): Promise<string> {
  for (const candidate of ['origin/main', 'origin/master', 'main', 'master']) {
    const result: RunResult = await runCommand(
      'git',
      ['rev-parse', '--verify', candidate],
      { cwd },
    );
    if (result.ok) return candidate;
  }
  return 'HEAD~1';
}

export async function getDiffFileCount(baseRef: string, cwd?: string): Promise<number> {
  const files = await getChangedFiles(baseRef, cwd);
  return files.length;
}
