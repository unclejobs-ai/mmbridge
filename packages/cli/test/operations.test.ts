import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { shortDigest } from '@mmbridge/core';
import { ProjectMemoryStore, RunStore, SessionStore } from '@mmbridge/session-store';
import { runGateCommand } from '../dist/commands/gate.js';
import { runResumeCommand } from '../dist/commands/resume.js';

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'mmbridge-cli-'));
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function initRepo(rootDir: string): Promise<{ projectDir: string; baseRef: string; diffDigest: string }> {
  const projectDir = path.join(rootDir, 'repo');
  await fs.mkdir(projectDir, { recursive: true });
  git(projectDir, ['init', '-b', 'main']);
  git(projectDir, ['config', 'user.name', 'MMBridge Test']);
  git(projectDir, ['config', 'user.email', 'mmbridge@example.com']);
  await fs.writeFile(path.join(projectDir, 'src.ts'), 'export const value = 1;\n', 'utf8');
  git(projectDir, ['add', 'src.ts']);
  git(projectDir, ['commit', '-m', 'initial']);
  await fs.writeFile(path.join(projectDir, 'src.ts'), 'export const value = 2;\n', 'utf8');
  git(projectDir, ['add', 'src.ts']);
  git(projectDir, ['commit', '-m', 'update']);
  const baseRef = 'HEAD~1';
  const diffText = execFileSync('git', ['diff', baseRef, 'HEAD'], { cwd: projectDir, encoding: 'utf8' });
  return { projectDir, baseRef, diffDigest: shortDigest(diffText) };
}

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  Object.defineProperty(process.stdout, 'write', {
    configurable: true,
    value: ((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stdout.write,
  });

  try {
    await fn();
  } finally {
    Object.defineProperty(process.stdout, 'write', {
      configurable: true,
      value: originalWrite,
    });
  }

  return chunks.join('');
}

test('runGateCommand emits WARN output when the latest run is stale', async () => {
  const baseDir = await makeTempDir();
  const mmbridgeHome = path.join(baseDir, '.mmbridge');
  const previousHome = process.env.HOME;
  process.env.HOME = baseDir;

  try {
    const { projectDir, baseRef } = await initRepo(baseDir);
    const runStore = new RunStore(mmbridgeHome);
    await runStore.save({
      tool: 'codex',
      mode: 'review',
      projectDir,
      baseRef,
      diffDigest: 'stale-digest',
      changedFiles: 1,
      status: 'completed',
      phase: 'handoff',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      findingsSoFar: 0,
      warnings: [],
      sessionId: 'session-1',
      lanes: [],
    });

    const output = await captureStdout(() => runGateCommand({ project: projectDir, baseRef, format: 'compact' }));
    assert.match(output, /WARN/);
    assert.match(output, /stale-review/);
  } finally {
    process.env.HOME = previousHome;
  }
});

test('runGateCommand emits JSON for a fresh matching run', async () => {
  const baseDir = await makeTempDir();
  const mmbridgeHome = path.join(baseDir, '.mmbridge');
  const previousHome = process.env.HOME;
  process.env.HOME = baseDir;

  try {
    const { projectDir, baseRef, diffDigest } = await initRepo(baseDir);
    const runStore = new RunStore(mmbridgeHome);
    await runStore.save({
      tool: 'codex',
      mode: 'review',
      projectDir,
      baseRef,
      diffDigest,
      changedFiles: 1,
      status: 'completed',
      phase: 'handoff',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      findingsSoFar: 0,
      warnings: [],
      sessionId: 'session-1',
      lanes: [],
    });

    const output = await captureStdout(() => runGateCommand({ project: projectDir, baseRef, format: 'json' }));
    const parsed = JSON.parse(output) as { status: string; warnings: unknown[] };
    assert.equal(parsed.status, 'pass');
    assert.equal(parsed.warnings.length, 0);
  } finally {
    process.env.HOME = previousHome;
  }
});

test('runResumeCommand previews the recommended action on non-interactive terminals', async () => {
  const baseDir = await makeTempDir();
  const mmbridgeHome = path.join(baseDir, '.mmbridge');
  const previousHome = process.env.HOME;
  process.env.HOME = baseDir;

  const originalStdoutIsTTY = process.stdout.isTTY;
  const originalStdinIsTTY = process.stdin.isTTY;

  try {
    const { projectDir, baseRef, diffDigest } = await initRepo(baseDir);
    const sessionStore = new SessionStore(mmbridgeHome);
    const runStore = new RunStore(mmbridgeHome);
    const memoryStore = new ProjectMemoryStore(mmbridgeHome);
    const run = await runStore.save({
      tool: 'codex',
      mode: 'review',
      projectDir,
      baseRef,
      diffDigest,
      changedFiles: 1,
      status: 'completed',
      phase: 'handoff',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      findingsSoFar: 0,
      warnings: [],
      sessionId: null,
      lanes: [
        {
          tool: 'codex',
          status: 'done',
          attempt: 1,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          findingCount: 0,
          externalSessionId: 'ext-123',
          followupSupported: true,
        },
      ],
    });
    const session = await sessionStore.save({
      tool: 'codex',
      mode: 'review',
      projectDir,
      workspace: projectDir,
      runId: run.id,
      externalSessionId: 'ext-123',
      followupSupported: true,
      summary: 'Latest review is clean.',
      findings: [],
      resultIndex: {
        summary: 'clean',
        parseState: 'raw',
        findingsTotal: 0,
        severityCounts: { CRITICAL: 0, WARNING: 0, INFO: 0, REFACTOR: 0 },
        filesTouched: 1,
        topFiles: [],
        filteredCount: 0,
        promotedCount: 0,
        followupSupported: true,
        outputDigest: null,
        hasBridge: false,
        bridgeSummary: null,
      },
      diffDigest,
      status: 'complete',
    });
    await memoryStore.createOrUpdateHandoff(projectDir, session.id, []);

    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });

    const output = await captureStdout(() => runResumeCommand({ project: projectDir, json: true }));
    const parsed = JSON.parse(output) as {
      status: string;
      recommended: { action: string } | null;
      alternatives: string[];
    };
    assert.equal(parsed.status, 'preview');
    assert.equal(parsed.recommended?.action, 'followup');
    assert.deepEqual(parsed.alternatives, []);
  } finally {
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: originalStdoutIsTTY });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: originalStdinIsTTY });
    process.env.HOME = previousHome;
  }
});
