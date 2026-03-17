import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runReviewPipeline } from '../dist/review-pipeline.js';
import type { ReviewPipelineOptions } from '../dist/review-pipeline.js';

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

function execGit(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed:\n${result.stderr}`);
}

async function makeFixtureProject(): Promise<{ projectDir: string; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mmbridge-core-test-'));
  const projectDir = path.join(root, 'project');
  await fs.mkdir(path.join(projectDir, 'src'), { recursive: true });
  await fs.writeFile(path.join(projectDir, 'src', 'app.ts'), 'export const value = 1;\n', 'utf8');

  execGit(projectDir, ['init']);
  execGit(projectDir, ['config', 'user.email', 'test@example.com']);
  execGit(projectDir, ['config', 'user.name', 'MMBridge Test']);
  execGit(projectDir, ['add', '.']);
  execGit(projectDir, ['commit', '-m', 'initial']);

  await fs.writeFile(path.join(projectDir, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');
  execGit(projectDir, ['add', '.']);
  execGit(projectDir, ['commit', '-m', 'change']);

  return {
    projectDir,
    cleanup: async () => {
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

async function createToolOnlyPath(rootDir: string): Promise<string> {
  const binDir = path.join(rootDir, 'bin');
  await fs.mkdir(binDir, { recursive: true });

  const gitPath = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
  const whichPath = spawnSync('which', ['which'], { encoding: 'utf8' }).stdout.trim();

  await fs.symlink(gitPath, path.join(binDir, 'git'));
  await fs.symlink(whichPath, path.join(binDir, 'which'));
  return binDir;
}

// Note: These tests hit the real git/filesystem via createContext,
// so they work on the actual mmbridge repo. We skip the context creation
// by checking that the pipeline runs end-to-end.

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
  const fixture = await makeFixtureProject();
  try {
    const result = await runReviewPipeline({
      ...baseOptions,
      projectDir: fixture.projectDir,
      tool: 'all',
      bridge: 'standard',
      bridgeProfile: 'strict',
      baseRef: 'HEAD~1',
      listInstalledTools: async () => ['tool1'],
      runAdapter: makeMockAdapter('[WARNING] src/app.ts:1 — Missing validation'),
    });

    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0]?.file, 'src/app.ts');
    assert.ok(result.summary.includes('strict'));
  } finally {
    await fixture.cleanup();
  }
});

test('runReviewPipeline: interpreted bridge keeps consensus findings and only adds interpretation metadata', async () => {
  const fixture = await makeFixtureProject();
  let managerCalled = false;
  const originalPath = process.env.PATH;

  try {
    process.env.PATH = await createToolOnlyPath(path.dirname(fixture.projectDir));
    const result = await runReviewPipeline({
      ...baseOptions,
      projectDir: fixture.projectDir,
      tool: 'all',
      bridge: 'interpreted',
      bridgeProfile: 'strict',
      baseRef: 'HEAD~1',
      listInstalledTools: async () => ['tool1'],
      runAdapter: makeMockAdapter('[WARNING] src/app.ts:1 — Missing validation'),
      runManager: async () => {
        managerCalled = true;
        throw new Error('manager should not run for legacy interpreted mode');
      },
    });

    assert.equal(managerCalled, false);
    assert.equal(result.manager ?? null, null);
    assert.ok(result.interpretation);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0]?.severity, 'WARNING');
    assert.equal(result.findings[0]?.file, 'src/app.ts');
  } finally {
    process.env.PATH = originalPath;
    await fixture.cleanup();
  }
});

test('runReviewPipeline: managed bridge applies manager output to final findings', async () => {
  const fixture = await makeFixtureProject();
  let savedData: unknown = null;

  try {
    const result = await runReviewPipeline({
      ...baseOptions,
      projectDir: fixture.projectDir,
      tool: 'all',
      bridge: 'managed',
      bridgeProfile: 'strict',
      baseRef: 'HEAD~1',
      listInstalledTools: async () => ['tool1'],
      runAdapter: makeMockAdapter('[WARNING] src/app.ts:1 — Missing validation'),
      runManager: async ({ mergedFindings }) => ({
        managerTool: 'fixture-manager',
        summary: 'Manager dismissed the noisy warning and promoted the deeper defect.',
        actionPlan: '1. Fix the deeper defect first.',
        validated: [],
        dismissed: mergedFindings[0] ? [{ finding: mergedFindings[0], reason: 'Too noisy for the final report.' }] : [],
        promoted: [
          {
            severity: 'CRITICAL',
            file: 'src/app.ts',
            line: 1,
            message: 'Escalated validation gap can corrupt persisted state.',
            sources: ['manager-review'],
          },
        ],
      }),
      saveSession: async (data) => {
        savedData = data;
        return { id: 'manager-123' };
      },
    });

    assert.equal(result.sessionId, 'manager-123');
    assert.equal(result.manager?.managerTool, 'fixture-manager');
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0]?.severity, 'CRITICAL');
    assert.equal(result.findings[0]?.line, 1);
    assert.match(result.summary, /Manager dismissed the noisy warning/);

    assert.ok(savedData);
    assert.equal((savedData as { manager?: { managerTool?: string } }).manager?.managerTool, 'fixture-manager');
  } finally {
    await fixture.cleanup();
  }
});

test('runReviewPipeline: managed bridge drops manager-promoted findings outside the reviewed diff', async () => {
  const fixture = await makeFixtureProject();

  try {
    const result = await runReviewPipeline({
      ...baseOptions,
      projectDir: fixture.projectDir,
      tool: 'all',
      bridge: 'managed',
      bridgeProfile: 'strict',
      baseRef: 'HEAD~1',
      listInstalledTools: async () => ['tool1'],
      runAdapter: makeMockAdapter('[WARNING] src/app.ts:1 — Missing validation'),
      runManager: async ({ mergedFindings }) => ({
        managerTool: 'fixture-manager',
        summary: 'Manager kept the real warning and tried to promote an unrelated file.',
        actionPlan: '',
        validated: mergedFindings,
        dismissed: [],
        promoted: [
          {
            severity: 'CRITICAL',
            file: 'src/other.ts',
            line: 7,
            message: 'Hallucinated issue outside the diff.',
            sources: ['manager-review'],
          },
        ],
      }),
    });

    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0]?.file, 'src/app.ts');
    assert.ok(result.findings.every((finding) => finding.file === 'src/app.ts'));
  } finally {
    await fixture.cleanup();
  }
});
