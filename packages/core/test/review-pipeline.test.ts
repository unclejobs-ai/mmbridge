import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { createContext, runReviewPipeline } from '../dist/index.js';
import type { ReviewPipelineOptions } from '../dist/review-pipeline.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function makeGitProject(): Promise<string> {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mmbridge-review-commit-'));
  git(projectDir, ['init', '-q']);
  git(projectDir, ['config', 'user.email', 'test@example.com']);
  git(projectDir, ['config', 'user.name', 'Test User']);
  await fs.writeFile(path.join(projectDir, 'src.ts'), 'export const value = 1;\n', 'utf8');
  git(projectDir, ['add', 'src.ts']);
  git(projectDir, ['commit', '-q', '-m', 'initial']);
  await fs.writeFile(path.join(projectDir, 'src.ts'), 'export const value = 2;\n', 'utf8');
  git(projectDir, ['add', 'src.ts']);
  git(projectDir, ['commit', '-q', '-m', 'update src']);
  return projectDir;
}

async function makeThreeCommitProject(): Promise<{ projectDir: string; secondCommit: string }> {
  const projectDir = await makeGitProject();
  const secondCommit = git(projectDir, ['rev-parse', 'HEAD']);
  await fs.writeFile(path.join(projectDir, 'src.ts'), 'export const value = 3;\n', 'utf8');
  git(projectDir, ['add', 'src.ts']);
  git(projectDir, ['commit', '-q', '-m', 'update src again']);
  return { projectDir, secondCommit };
}

async function makeDeleteReaddProject(): Promise<{ projectDir: string; deleteCommit: string }> {
  const projectDir = await makeGitProject();
  await fs.rm(path.join(projectDir, 'src.ts'));
  git(projectDir, ['add', 'src.ts']);
  git(projectDir, ['commit', '-q', '-m', 'delete src']);
  const deleteCommit = git(projectDir, ['rev-parse', 'HEAD']);
  await fs.writeFile(path.join(projectDir, 'src.ts'), 'export const value = 3;\n', 'utf8');
  git(projectDir, ['add', 'src.ts']);
  git(projectDir, ['commit', '-q', '-m', 'readd src']);
  return { projectDir, deleteCommit };
}

function makeMockAdapter(text: string) {
  return async (_tool: string, _opts: unknown) => ({
    text,
    externalSessionId: 'ext-123',
    followupSupported: true,
  });
}

const baseOptions: ReviewPipelineOptions = {
  tool: 'kimi',
  mode: 'review',
  projectDir: process.cwd(),
  runAdapter: makeMockAdapter('[WARNING] src/a.ts:10 — Missing validation'),
};

// Note: These tests hit the real git/filesystem via createContext,
// so they work on the actual mmbridge repo. We skip the context creation
// by checking that the pipeline runs end-to-end.

test('createContext: commit option reviews the commit diff instead of diffing commit..HEAD', async () => {
  const projectDir = await makeGitProject();
  const commit = git(projectDir, ['rev-parse', 'HEAD']);

  const ctx = await createContext({ projectDir, commit, mode: 'review', tools: ['kimi'] });
  const diff = await fs.readFile(ctx.diffPath, 'utf8');

  assert.deepEqual(ctx.changedFiles, ['src.ts']);
  assert.equal(ctx.baseRef, `${commit}^`);
  assert.match(diff, /export const value = 2/);
  assert.doesNotMatch(diff, /No changed files/);
});

test('createContext: commit option copies file content from the reviewed commit', async () => {
  const { projectDir, secondCommit } = await makeThreeCommitProject();

  const ctx = await createContext({ projectDir, commit: secondCommit, mode: 'review', tools: ['kimi'] });
  const copied = await fs.readFile(path.join(ctx.workspace, 'files', 'src.ts'), 'utf8');

  assert.match(copied, /value = 2/);
  assert.doesNotMatch(copied, /value = 3/);
});

test('createContext: commit option does not mirror live worktree content for deleted files', async () => {
  const { projectDir, deleteCommit } = await makeDeleteReaddProject();

  const ctx = await createContext({ projectDir, commit: deleteCommit, mode: 'review', tools: ['kimi'] });

  assert.deepEqual(ctx.changedFiles, ['src.ts']);
  assert.equal(ctx.copiedFileCount, 0);
  await assert.rejects(() => fs.readFile(path.join(ctx.workspace, 'files', 'src.ts'), 'utf8'));
});

test('createContext: commit option reviews root commits against the empty tree', async () => {
  const projectDir = await makeGitProject();
  const rootCommit = git(projectDir, ['rev-list', '--max-parents=0', 'HEAD']);

  const ctx = await createContext({ projectDir, commit: rootCommit, mode: 'review', tools: ['kimi'] });
  const diff = await fs.readFile(ctx.diffPath, 'utf8');

  assert.deepEqual(ctx.changedFiles, ['src.ts']);
  assert.equal(ctx.baseRef, '4b825dc642cb6eb9a060e54bf8d69288fbee4904');
  assert.match(diff, /new file mode/);
  assert.match(diff, /export const value = 1/);
});

test('runReviewPipeline: single tool produces findings', async () => {
  const phases: string[] = [];

  const result = await runReviewPipeline({
    ...baseOptions,
    onProgress: (phase) => phases.push(phase),
  });

  assert.ok(result.sessionId);
  assert.ok(Array.isArray(result.findings));
  assert.ok(result.resultIndex);
  assert.ok(phases.includes('context'));
  assert.ok(phases.includes('review'));
});

test('runReviewPipeline: saves session when saveSession provided', async () => {
  let savedData: unknown = null;

  const result = await runReviewPipeline({
    ...baseOptions,
    saveSession: async (data) => {
      savedData = data;
      return { id: 'saved-123' };
    },
  });

  assert.equal(result.sessionId, 'saved-123');
  assert.notEqual(savedData, null);
});

test('runReviewPipeline: session is "unsaved" without saveSession', async () => {
  const result = await runReviewPipeline(baseOptions);
  assert.equal(result.sessionId, 'unsaved');
});

test('runReviewPipeline: bridge mode throws without installed tools', async () => {
  await assert.rejects(
    () =>
      runReviewPipeline({
        ...baseOptions,
        tool: 'all',
        bridge: 'standard',
        listInstalledTools: async () => [],
      }),
    /No review tools installed/,
  );
});

test('runReviewPipeline: bridgeProfile affects consensus threshold', async () => {
  const result = await runReviewPipeline({
    ...baseOptions,
    tool: 'all',
    bridge: 'standard',
    bridgeProfile: 'strict',
    listInstalledTools: async () => ['tool1'],
    runAdapter: makeMockAdapter('[WARNING] Missing validation'),
  });

  assert.equal(result.findings.length, 1);
  assert.ok(result.summary.includes('strict'));
});

test('runReviewPipeline: bridge mode serializes persistRun updates', async () => {
  let inFlight = 0;
  let maxInFlight = 0;

  await runReviewPipeline({
    ...baseOptions,
    tool: 'all',
    bridge: 'standard',
    bridgeProfile: 'strict',
    listInstalledTools: async () => ['tool1', 'tool2'],
    runAdapter: async (tool: string) => ({
      text: `[WARNING] src/a.ts:10 — ${tool} found an issue`,
      externalSessionId: `${tool}-session`,
      followupSupported: true,
    }),
    persistRun: async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight--;
    },
  });

  assert.equal(maxInFlight, 1);
});
