import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProjectMemoryStore, SessionStore } from '../dist/index.js';

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'mmbridge-memory-'));
}

test('ProjectMemoryStore creates handoff artifacts and indexes memory', async () => {
  const baseDir = await makeTempDir();
  const projectDir = path.join(baseDir, 'repo');
  await fs.mkdir(projectDir, { recursive: true });

  const sessionStore = new SessionStore(baseDir);
  const memoryStore = new ProjectMemoryStore(baseDir);

  const session = await sessionStore.save({
    tool: 'codex',
    mode: 'review',
    projectDir,
    workspace: projectDir,
    summary: 'Found validation and traversal issues.',
    findings: [
      { severity: 'WARNING', file: 'src/a.ts', line: 10, message: 'Missing validation' },
      { severity: 'CRITICAL', file: 'src/b.ts', line: 5, message: 'Path traversal risk' },
    ],
    contextIndex: {
      workspaceId: 'w1',
      projectDir,
      projectSlug: 'repo',
      mode: 'review',
      baseRef: 'HEAD~1',
      diffDigest: 'digest-1',
      head: { sha: 'abc1234', branch: 'main' },
      changedFiles: 2,
      copiedFiles: 2,
      categoryCounts: {},
      changedSample: ['src/a.ts', 'src/b.ts'],
      redaction: { changedFiles: 2, usedRuleCount: 1 },
    },
    resultIndex: {
      summary: '2 findings',
      parseState: 'raw',
      findingsTotal: 2,
      severityCounts: { CRITICAL: 1, WARNING: 1, INFO: 0, REFACTOR: 0 },
      filesTouched: 2,
      topFiles: [{ file: 'src/a.ts', count: 1 }],
      filteredCount: 0,
      promotedCount: 0,
      followupSupported: true,
      outputDigest: null,
      hasBridge: false,
      bridgeSummary: null,
    },
    followupSupported: true,
    externalSessionId: 'ext-123',
    status: 'complete',
  });

  const search = await memoryStore.searchMemory({ projectDir, query: 'validation', limit: 10 });
  const handoff = await memoryStore.createOrUpdateHandoff(
    projectDir,
    session.id,
    search.slice(0, 1).map((entry) => entry.id),
  );
  const recall = await memoryStore.buildRecall(projectDir, { changedFiles: ['src/a.ts'] });
  const latest = await memoryStore.getLatestHandoff(projectDir);

  assert.equal(handoff.artifact.sessionId, session.id);
  assert.ok(handoff.recommendedNextPrompt.includes('finding') || handoff.recommendedNextPrompt.includes('blocker'));
  assert.ok(search.some((entry) => entry.type === 'finding'));
  assert.ok(recall.summary.length > 0);
  assert.equal(latest?.sessionId, session.id);
  assert.equal(handoff.recalledMemory.length, 1);
  assert.match(handoff.recalledMemory[0]?.content ?? '', /validation/i);
  await assert.doesNotReject(() => fs.readFile(handoff.artifact.markdownPath, 'utf8'));
  await assert.doesNotReject(() => fs.readFile(handoff.artifact.jsonPath, 'utf8'));
});

test('ProjectMemoryStore timeline and show return deterministic entries', async () => {
  const baseDir = await makeTempDir();
  const projectDir = path.join(baseDir, 'repo');
  await fs.mkdir(projectDir, { recursive: true });

  const sessionStore = new SessionStore(baseDir);
  const memoryStore = new ProjectMemoryStore(baseDir);
  const session = await sessionStore.save({
    tool: 'codex',
    mode: 'followup',
    projectDir,
    workspace: projectDir,
    summary: 'Follow-up confirms the fix path.',
    findings: [],
    resultIndex: {
      summary: 'no findings',
      parseState: 'raw',
      findingsTotal: 0,
      severityCounts: { CRITICAL: 0, WARNING: 0, INFO: 0, REFACTOR: 0 },
      filesTouched: 0,
      topFiles: [],
      filteredCount: 0,
      promotedCount: 0,
      followupSupported: true,
      outputDigest: null,
      hasBridge: false,
      bridgeSummary: null,
    },
    interpretation: {
      validated: [],
      falsePositives: [],
      promoted: [],
      actionPlan: 'TODO verify release note',
      interpreterTool: 'codex',
    },
    status: 'complete',
  });

  await memoryStore.backfillProject(projectDir);
  const timeline = await memoryStore.timelineMemory({ projectDir, sessionId: session.id, limit: 5 });
  const shown = await memoryStore.showMemory(
    projectDir,
    timeline.slice(0, 2).map((entry) => entry.id),
  );

  assert.ok(timeline.length > 0);
  assert.equal(shown.length, Math.min(2, timeline.length));
});

test('ProjectMemoryStore buildRecall pins followup recall to the selected session', async () => {
  const baseDir = await makeTempDir();
  const projectDir = path.join(baseDir, 'repo');
  await fs.mkdir(projectDir, { recursive: true });

  const sessionStore = new SessionStore(baseDir);
  const memoryStore = new ProjectMemoryStore(baseDir);

  const older = await sessionStore.save({
    tool: 'codex',
    mode: 'review',
    projectDir,
    workspace: projectDir,
    summary: 'Older review about auth fallback.',
    findings: [{ severity: 'WARNING', file: 'src/auth.ts', line: 12, message: 'Older auth blocker' }],
    resultIndex: {
      summary: 'older',
      parseState: 'raw',
      findingsTotal: 1,
      severityCounts: { CRITICAL: 0, WARNING: 1, INFO: 0, REFACTOR: 0 },
      filesTouched: 1,
      topFiles: [{ file: 'src/auth.ts', count: 1 }],
      filteredCount: 0,
      promotedCount: 0,
      followupSupported: true,
      outputDigest: null,
      hasBridge: false,
      bridgeSummary: null,
    },
    externalSessionId: 'old-ext',
    followupSupported: true,
    status: 'complete',
  });
  await memoryStore.createOrUpdateHandoff(projectDir, older.id, []);

  const newer = await sessionStore.save({
    tool: 'codex',
    mode: 'review',
    projectDir,
    workspace: projectDir,
    summary: 'Newer review about billing retry.',
    findings: [{ severity: 'WARNING', file: 'src/billing.ts', line: 8, message: 'New billing blocker' }],
    resultIndex: {
      summary: 'newer',
      parseState: 'raw',
      findingsTotal: 1,
      severityCounts: { CRITICAL: 0, WARNING: 1, INFO: 0, REFACTOR: 0 },
      filesTouched: 1,
      topFiles: [{ file: 'src/billing.ts', count: 1 }],
      filteredCount: 0,
      promotedCount: 0,
      followupSupported: true,
      outputDigest: null,
      hasBridge: false,
      bridgeSummary: null,
    },
    externalSessionId: 'new-ext',
    followupSupported: true,
    status: 'complete',
  });
  await memoryStore.createOrUpdateHandoff(projectDir, newer.id, []);

  const recall = await memoryStore.buildRecall(projectDir, {
    mode: 'followup',
    tool: 'codex',
    sessionId: older.id,
    queryText: 'older auth blocker',
  });

  assert.equal(recall.latestHandoff?.sessionId, older.id);
  assert.ok(recall.promptContext.includes('Older review about auth fallback.'));
  assert.ok(!recall.promptContext.includes('Newer review about billing retry.'));
});

test('ProjectMemoryStore timeline query returns contextual session history', async () => {
  const baseDir = await makeTempDir();
  const projectDir = path.join(baseDir, 'repo');
  await fs.mkdir(projectDir, { recursive: true });

  const sessionStore = new SessionStore(baseDir);
  const memoryStore = new ProjectMemoryStore(baseDir);

  const session = await sessionStore.save({
    tool: 'codex',
    mode: 'followup',
    projectDir,
    workspace: projectDir,
    summary: 'Billing retry follow-up and release note check.',
    findings: [
      { severity: 'WARNING', file: 'src/billing.ts', line: 18, message: 'Retry logic still needs guardrails' },
    ],
    resultIndex: {
      summary: '1 finding',
      parseState: 'raw',
      findingsTotal: 1,
      severityCounts: { CRITICAL: 0, WARNING: 1, INFO: 0, REFACTOR: 0 },
      filesTouched: 1,
      topFiles: [{ file: 'src/billing.ts', count: 1 }],
      filteredCount: 0,
      promotedCount: 0,
      followupSupported: true,
      outputDigest: null,
      hasBridge: false,
      bridgeSummary: null,
    },
    interpretation: {
      validated: [],
      falsePositives: [],
      promoted: [],
      actionPlan: 'TODO add retry cap\nFollow-up on release note wording',
      interpreterTool: 'codex',
    },
    status: 'complete',
  });

  await memoryStore.createOrUpdateHandoff(projectDir, session.id, []);
  const timeline = await memoryStore.timelineMemory({ projectDir, query: 'retry cap', limit: 6 });

  assert.ok(timeline.some((entry) => /retry cap/i.test(entry.content)));
  assert.ok(timeline.some((entry) => /release note/i.test(entry.content) || /follow-up/i.test(entry.content)));
  assert.ok(timeline.every((entry) => entry.sessionId === session.id));
});
