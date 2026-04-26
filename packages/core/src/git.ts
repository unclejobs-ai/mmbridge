import type { GitStatusSummary, HeadMeta, RunResult } from './types.js';
import { runCommand } from './utils.js';

export const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export async function getHead(cwd?: string): Promise<HeadMeta> {
  const shaResult: RunResult = await runCommand('git', ['rev-parse', '--short', 'HEAD'], { cwd });
  const branchResult: RunResult = await runCommand('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
  return {
    sha: shaResult.stdout.trim() || 'unknown',
    branch: branchResult.stdout.trim() || 'unknown',
  };
}

export async function getChangedFiles(baseRef: string, cwd?: string, targetRef = 'HEAD'): Promise<string[]> {
  const result: RunResult = await runCommand('git', ['diff', '--name-only', baseRef, targetRef], { cwd });
  if (!result.ok) return [];
  return result.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

export async function getStagedFiles(cwd?: string): Promise<string[]> {
  const result: RunResult = await runCommand('git', ['diff', '--name-only', '--cached'], { cwd });
  if (!result.ok) return [];
  return result.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

export async function getUnstagedFiles(cwd?: string): Promise<string[]> {
  const result: RunResult = await runCommand('git', ['diff', '--name-only'], { cwd });
  if (!result.ok) return [];
  return result.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

export async function getUntrackedFiles(cwd?: string): Promise<string[]> {
  const result: RunResult = await runCommand('git', ['ls-files', '--others', '--exclude-standard'], { cwd });
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

export async function getDiff(baseRef: string, cwd?: string, targetRef = 'HEAD'): Promise<string> {
  const result: RunResult = await runCommand('git', ['diff', baseRef, targetRef], { cwd });
  return result.ok ? result.stdout : '';
}

export async function getDefaultBaseRef(cwd?: string): Promise<string> {
  for (const candidate of ['origin/main', 'origin/master', 'main', 'master']) {
    const result: RunResult = await runCommand('git', ['rev-parse', '--verify', candidate], { cwd });
    if (result.ok) return candidate;
  }
  return 'HEAD~1';
}

export async function getCommitParentOrEmptyTree(commit: string, cwd?: string): Promise<string> {
  const result: RunResult = await runCommand('git', ['rev-parse', '--verify', `${commit}^`], { cwd });
  return result.ok ? `${commit}^` : EMPTY_TREE_SHA;
}

export async function getFileAtRef(ref: string, relPath: string, cwd?: string): Promise<string | null> {
  const result: RunResult = await runCommand('git', ['show', `${ref}:${relPath}`], { cwd });
  return result.ok ? result.stdout : null;
}

export async function getDiffFileCount(baseRef: string, cwd?: string): Promise<number> {
  const files = await getChangedFiles(baseRef, cwd);
  return files.length;
}
