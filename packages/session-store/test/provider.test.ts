import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SessionStore, createMemoryProvider } from '../dist/index.js';

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'mmbridge-provider-'));
}

test('createMemoryProvider defaults to project provider and serves project memory', async () => {
  const baseDir = await makeTempDir();
  const projectDir = path.join(baseDir, 'repo');
  await fs.mkdir(projectDir, { recursive: true });

  const sessionStore = new SessionStore(baseDir);
  await sessionStore.save({
    tool: 'codex',
    mode: 'review',
    projectDir,
    workspace: projectDir,
    summary: 'Found validation issue.',
    findings: [{ severity: 'WARNING', file: 'src/app.ts', line: 3, message: 'Missing validation' }],
    resultIndex: {
      summary: '1 finding',
      parseState: 'raw',
      findingsTotal: 1,
      severityCounts: { CRITICAL: 0, WARNING: 1, INFO: 0, REFACTOR: 0 },
      filesTouched: 1,
      topFiles: [{ file: 'src/app.ts', count: 1 }],
      filteredCount: 0,
      promotedCount: 0,
      followupSupported: false,
      outputDigest: null,
      hasBridge: false,
      bridgeSummary: null,
    },
    status: 'complete',
  });

  const provider = await createMemoryProvider({ projectDir, baseDir });
  const recall = await provider.buildRecall(projectDir, { changedFiles: ['src/app.ts'] });
  const entries = await provider.searchMemory({ projectDir, query: 'validation', limit: 5 });

  assert.equal(provider.provider, 'project');
  assert.ok(recall.summary.length > 0);
  assert.ok(entries.some((entry) => /validation/i.test(entry.content)));
});

test('createMemoryProvider rejects unsupported claude-mem provider', async () => {
  const baseDir = await makeTempDir();
  const projectDir = path.join(baseDir, 'repo');
  await fs.mkdir(projectDir, { recursive: true });

  await assert.rejects(
    () =>
      createMemoryProvider({
        projectDir,
        baseDir,
        config: { memory: { provider: 'claude-mem' } },
      }),
    /Memory provider "claude-mem" is not implemented yet/,
  );
});

test('createMemoryProvider rejects unsupported serena-mcp provider', async () => {
  const baseDir = await makeTempDir();
  const projectDir = path.join(baseDir, 'repo');
  await fs.mkdir(projectDir, { recursive: true });

  await assert.rejects(
    () =>
      createMemoryProvider({
        projectDir,
        baseDir,
        config: { memory: { provider: 'serena-mcp' } },
      }),
    /Memory provider "serena-mcp" is not implemented yet/,
  );
});
