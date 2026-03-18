import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunStore } from '../dist/index.js';

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'mmbridge-runs-'));
}

test('RunStore saves and retrieves review runs', async () => {
  const baseDir = await makeTempDir();
  const store = new RunStore(baseDir);

  const saved = await store.save({
    tool: 'codex',
    mode: 'review',
    projectDir: '/repo',
    baseRef: 'HEAD~1',
    diffDigest: 'digest-1',
    changedFiles: 2,
    status: 'completed',
    phase: 'handoff',
    startedAt: '2026-03-18T00:00:00.000Z',
    completedAt: '2026-03-18T00:01:00.000Z',
    findingsSoFar: 1,
    warnings: [],
    sessionId: 'session-1',
    lanes: [
      {
        tool: 'codex',
        status: 'done',
        attempt: 1,
        startedAt: '2026-03-18T00:00:00.000Z',
        completedAt: '2026-03-18T00:01:00.000Z',
        findingCount: 1,
        externalSessionId: 'ext-1',
        followupSupported: true,
      },
    ],
  });

  const loaded = await store.get(saved.id);

  assert.equal(loaded?.id, saved.id);
  assert.equal(loaded?.lanes[0]?.tool, 'codex');
});

test('RunStore returns the latest run for a project and mode', async () => {
  const baseDir = await makeTempDir();
  const store = new RunStore(baseDir);

  await store.save({
    id: 'run-old',
    tool: 'codex',
    mode: 'review',
    projectDir: '/repo',
    baseRef: 'HEAD~1',
    diffDigest: 'digest-1',
    changedFiles: 2,
    status: 'completed',
    phase: 'handoff',
    startedAt: '2026-03-18T00:00:00.000Z',
    completedAt: '2026-03-18T00:01:00.000Z',
    findingsSoFar: 1,
    warnings: [],
    sessionId: 'session-old',
    lanes: [],
  });

  await store.save({
    id: 'run-new',
    tool: 'bridge',
    mode: 'review',
    projectDir: '/repo',
    baseRef: 'HEAD~1',
    diffDigest: 'digest-2',
    changedFiles: 8,
    status: 'partial',
    phase: 'handoff',
    startedAt: '2026-03-18T00:02:00.000Z',
    completedAt: '2026-03-18T00:03:00.000Z',
    findingsSoFar: 2,
    warnings: [],
    sessionId: 'session-new',
    lanes: [],
  });

  const latest = await store.getLatest({ projectDir: '/repo', mode: 'review' });

  assert.equal(latest?.id, 'run-new');
  assert.equal(latest?.diffDigest, 'digest-2');
});
