import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { ContextTree } from '../dist/context-tree.js';
import { RecallEngine } from '../dist/recall-engine.js';
import { ContextAssembler } from '../dist/context-assembler.js';
import { BrokerEventBus } from '../dist/events.js';

/* ------------------------------------------------------------------ *
 *  Mock stores (same pattern as recall-engine.test.ts)                *
 * ------------------------------------------------------------------ */

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: overrides.id ?? 'sess-1',
    tool: overrides.tool ?? 'claude',
    mode: overrides.mode ?? 'review',
    projectDir: overrides.projectDir ?? '/tmp/test-proj',
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    summary: overrides.summary ?? 'Reviewed auth module',
    findings: overrides.findings ?? [],
    diffDigest: overrides.diffDigest ?? null,
    resultIndex: overrides.resultIndex ?? null,
    workspace: overrides.workspace ?? '/tmp/ws',
  };
}

function mockSessionStore(sessions: ReturnType<typeof makeSession>[] = []) {
  return {
    init: async () => {},
    save: async () => sessions[0] ?? makeSession(),
    get: async (id: string) => sessions.find((s) => s.id === id) ?? null,
    list: async (opts: { projectDir?: string; query?: string; limit?: number } = {}) => {
      let result = [...sessions];
      if (opts.projectDir) {
        result = result.filter((s) => s.projectDir === opts.projectDir);
      }
      if (opts.query) {
        const q = opts.query.toLowerCase();
        result = result.filter(
          (s) => (s.summary ?? '').toLowerCase().includes(q),
        );
      }
      if (opts.limit) result = result.slice(0, opts.limit);
      return result;
    },
    remove: async () => true,
    getFamily: async () => [],
  };
}

function mockMemoryStore() {
  return {
    searchMemory: async () => [],
    getLatestHandoff: async () => null,
  };
}

/* ------------------------------------------------------------------ *
 *  Tests                                                              *
 * ------------------------------------------------------------------ */

describe('ContextAssembler', () => {
  let tmpDir: string;
  let tree: ContextTree;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'assembler-test-'));
    tree = new ContextTree(tmpDir);
    await tree.init();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('assemble() returns a valid ContextPacket', async () => {
    const recallEngine = new RecallEngine({
      sessionStore: mockSessionStore([]) as any,
      memoryStore: mockMemoryStore() as any,
      contextTree: tree,
    });

    const assembler = new ContextAssembler({
      contextTree: tree,
      recallEngine,
      sessionStore: mockSessionStore([]) as any,
    });

    const packet = await assembler.assemble({
      projectDir: tmpDir, // Use tmpDir (non-git) to test graceful fallback
      task: 'review auth module',
      command: 'review',
    });

    // Structure checks
    assert.equal(packet.project, tmpDir);
    assert.equal(packet.task, 'review auth module');
    assert.ok(typeof packet.treeLeafId === 'string');
    assert.ok(typeof packet.projectState === 'object');
    assert.ok(typeof packet.projectState.branch === 'string');
    assert.ok(Array.isArray(packet.projectState.fileHotspots));
    assert.ok(typeof packet.alwaysOnMemory === 'string');
    assert.ok(Array.isArray(packet.recalledSessions));
    assert.ok(Array.isArray(packet.recalledHandoffs));
    assert.ok(Array.isArray(packet.recalledMemory));
    assert.ok(typeof packet.totalRecallTokens === 'number');
    assert.ok(typeof packet.recallBudget === 'number');
    assert.ok(Array.isArray(packet.gateWarnings));
    assert.ok(['fresh', 'stale', 'expired'].includes(packet.freshness));
    assert.ok(typeof packet.suggestedCommand === 'string');
    assert.ok(Array.isArray(packet.suggestedAdapters));
  });

  it('assemble() creates a tree node for the task', async () => {
    const recallEngine = new RecallEngine({
      sessionStore: mockSessionStore([]) as any,
      memoryStore: mockMemoryStore() as any,
      contextTree: tree,
    });

    const assembler = new ContextAssembler({
      contextTree: tree,
      recallEngine,
    });

    const packet = await assembler.assemble({
      projectDir: tmpDir,
      task: 'test tree node creation',
      command: 'review',
    });

    // The tree should have a node with the returned treeLeafId
    const node = await tree.getNode(packet.treeLeafId);
    assert.ok(node, 'Tree node should exist');
    assert.equal(node!.type, 'task');
    assert.equal(node!.summary, 'test tree node creation');
    assert.deepEqual(node!.data.command, 'review');
  });

  it('assemble() branches from parentNodeId when provided', async () => {
    const recallEngine = new RecallEngine({
      sessionStore: mockSessionStore([]) as any,
      memoryStore: mockMemoryStore() as any,
      contextTree: tree,
    });

    const assembler = new ContextAssembler({
      contextTree: tree,
      recallEngine,
    });

    // First assemble
    const packet1 = await assembler.assemble({
      projectDir: tmpDir,
      task: 'initial review',
      command: 'review',
    });

    // Second assemble branching from first
    const packet2 = await assembler.assemble({
      projectDir: tmpDir,
      task: 'followup on initial review',
      command: 'followup',
      parentNodeId: packet1.treeLeafId,
    });

    const node2 = await tree.getNode(packet2.treeLeafId);
    assert.ok(node2, 'Second tree node should exist');
    assert.equal(node2!.data.command, 'followup');

    // Verify lineage
    const treePath = await tree.getPath(packet2.treeLeafId);
    assert.ok(treePath.length >= 1, 'Path should have at least the child node');
  });

  it('assemble() gracefully handles non-git directory', async () => {
    const recallEngine = new RecallEngine({
      sessionStore: mockSessionStore([]) as any,
      memoryStore: mockMemoryStore() as any,
      contextTree: tree,
    });

    const assembler = new ContextAssembler({
      contextTree: tree,
      recallEngine,
    });

    // tmpDir is not a git repo — should not throw
    const packet = await assembler.assemble({
      projectDir: tmpDir,
      task: 'review code',
      command: 'review',
    });

    assert.equal(packet.projectState.branch, 'unknown');
    assert.equal(packet.projectState.recentDiff, '');
    assert.deepEqual(packet.projectState.fileHotspots, []);
  });

  it('suggestCommand routes security tasks correctly', async () => {
    const recallEngine = new RecallEngine({
      sessionStore: mockSessionStore([]) as any,
      memoryStore: mockMemoryStore() as any,
      contextTree: tree,
    });

    const assembler = new ContextAssembler({
      contextTree: tree,
      recallEngine,
    });

    const packet = await assembler.assemble({
      projectDir: tmpDir,
      task: 'check for security vulnerabilities and CVE exposure',
      command: 'review',
    });

    assert.ok(
      packet.suggestedCommand.includes('security'),
      `Expected security suggestion, got: ${packet.suggestedCommand}`,
    );
  });

  it('suggestCommand routes research tasks correctly', async () => {
    const recallEngine = new RecallEngine({
      sessionStore: mockSessionStore([]) as any,
      memoryStore: mockMemoryStore() as any,
      contextTree: tree,
    });

    const assembler = new ContextAssembler({
      contextTree: tree,
      recallEngine,
    });

    const packet = await assembler.assemble({
      projectDir: tmpDir,
      task: 'research best practices for database indexing',
      command: 'review',
    });

    assert.ok(
      packet.suggestedCommand.includes('research'),
      `Expected research suggestion, got: ${packet.suggestedCommand}`,
    );
  });

  it('gate signals show no_prior_sessions when store is empty', async () => {
    const recallEngine = new RecallEngine({
      sessionStore: mockSessionStore([]) as any,
      memoryStore: mockMemoryStore() as any,
      contextTree: tree,
    });

    const assembler = new ContextAssembler({
      contextTree: tree,
      recallEngine,
      sessionStore: mockSessionStore([]) as any,
    });

    const packet = await assembler.assemble({
      projectDir: tmpDir,
      task: 'review code',
      command: 'review',
    });

    assert.ok(
      packet.gateWarnings.includes('no_prior_sessions'),
      `Expected no_prior_sessions warning, got: ${JSON.stringify(packet.gateWarnings)}`,
    );
  });

  it('assemble() augments fileHotspots from session findings', async () => {
    const sessions = [
      makeSession({
        projectDir: tmpDir,
        findings: [
          { file: 'src/auth.ts', message: 'SQL injection', severity: 'HIGH' },
          { file: 'src/db.ts', message: 'Missing index', severity: 'MEDIUM' },
        ],
        resultIndex: {
          topFiles: [
            { file: 'src/utils.ts', findingCount: 3 },
          ],
        },
      }),
    ];

    const recallEngine = new RecallEngine({
      sessionStore: mockSessionStore(sessions) as any,
      memoryStore: mockMemoryStore() as any,
      contextTree: tree,
    });

    const assembler = new ContextAssembler({
      contextTree: tree,
      recallEngine,
      sessionStore: mockSessionStore(sessions) as any,
    });

    const packet = await assembler.assemble({
      projectDir: tmpDir,
      task: 'review code',
      command: 'review',
    });

    // Should include files from session findings
    const hotspots = packet.projectState.fileHotspots;
    assert.ok(hotspots.includes('src/auth.ts'), 'Should include auth.ts from findings');
    assert.ok(hotspots.includes('src/db.ts'), 'Should include db.ts from findings');
    assert.ok(hotspots.includes('src/utils.ts'), 'Should include utils.ts from topFiles');
  });

  it('assemble() emits before_context, on_recall, and after_context events', async () => {
    const eventBus = new BrokerEventBus();
    const events: { event: string; data: Record<string, unknown> }[] = [];

    eventBus.on('before_context', (event, data) => {
      events.push({ event, data });
    });
    eventBus.on('on_recall', (event, data) => {
      events.push({ event, data });
    });
    eventBus.on('after_context', (event, data) => {
      events.push({ event, data });
    });

    const recallEngine = new RecallEngine({
      sessionStore: mockSessionStore([]) as any,
      memoryStore: mockMemoryStore() as any,
      contextTree: tree,
    });

    const assembler = new ContextAssembler({
      contextTree: tree,
      recallEngine,
      eventBus,
    });

    await assembler.assemble({
      projectDir: tmpDir,
      task: 'test event emission',
      command: 'review',
    });

    // Verify all three events were emitted in order
    assert.equal(events.length, 3, `Expected 3 events, got ${events.length}`);

    assert.equal(events[0].event, 'before_context');
    assert.equal(events[0].data.task, 'test event emission');
    assert.equal(events[0].data.command, 'review');
    assert.equal(events[0].data.projectDir, tmpDir);

    assert.equal(events[1].event, 'on_recall');
    assert.ok(typeof events[1].data.budget === 'number', 'budget should be a number');
    assert.ok(typeof events[1].data.totalTokens === 'number', 'totalTokens should be a number');
    assert.ok(typeof events[1].data.entryCount === 'number', 'entryCount should be a number');

    assert.equal(events[2].event, 'after_context');
    assert.ok(typeof events[2].data.treeLeafId === 'string', 'treeLeafId should be a string');
    assert.ok(['fresh', 'stale', 'expired'].includes(events[2].data.freshness as string));
    assert.ok(typeof events[2].data.suggestedCommand === 'string');
  });

  it('assemble() does not fail when eventBus handler throws', async () => {
    const eventBus = new BrokerEventBus();
    eventBus.on('before_context', () => {
      throw new Error('handler exploded');
    });

    const recallEngine = new RecallEngine({
      sessionStore: mockSessionStore([]) as any,
      memoryStore: mockMemoryStore() as any,
      contextTree: tree,
    });

    const assembler = new ContextAssembler({
      contextTree: tree,
      recallEngine,
      eventBus,
    });

    // Should not throw despite the failing handler
    const packet = await assembler.assemble({
      projectDir: tmpDir,
      task: 'test error resilience',
      command: 'review',
    });

    assert.ok(packet, 'Should still return a valid packet');
    assert.equal(packet.task, 'test error resilience');
  });

  it('assemble() works fine without eventBus (backward compat)', async () => {
    const recallEngine = new RecallEngine({
      sessionStore: mockSessionStore([]) as any,
      memoryStore: mockMemoryStore() as any,
      contextTree: tree,
    });

    const assembler = new ContextAssembler({
      contextTree: tree,
      recallEngine,
      // no eventBus
    });

    const packet = await assembler.assemble({
      projectDir: tmpDir,
      task: 'test no event bus',
      command: 'review',
    });

    assert.ok(packet, 'Should return a valid packet without eventBus');
    assert.equal(packet.task, 'test no event bus');
  });
});
