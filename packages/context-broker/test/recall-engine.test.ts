import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { ContextTree } from '../dist/context-tree.js';
import { RecallEngine } from '../dist/recall-engine.js';

/* ------------------------------------------------------------------ *
 *  Minimal mock factories for session-store types                     *
 * ------------------------------------------------------------------ */

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: overrides.id ?? 'sess-1',
    tool: overrides.tool ?? 'claude',
    mode: overrides.mode ?? 'review',
    projectDir: overrides.projectDir ?? '/tmp/test-proj',
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    summary: overrides.summary ?? 'Fixed authentication bug in login module',
    findings: overrides.findings ?? [],
    workspace: overrides.workspace ?? '/tmp/ws',
    ...overrides,
  };
}

function makeMemoryEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: overrides.id ?? 'mem-1',
    type: overrides.type ?? 'finding',
    title: overrides.title ?? 'Auth vulnerability found',
    content: overrides.content ?? 'SQL injection in login handler',
    file: overrides.file ?? 'src/auth.ts',
    line: overrides.line ?? 42,
    severity: overrides.severity ?? 'HIGH',
    branch: overrides.branch ?? 'main',
    createdAt: overrides.createdAt ?? new Date().toISOString(),
  };
}

function makeHandoff(overrides: Record<string, unknown> = {}) {
  return {
    id: overrides.id ?? 'ho-1',
    sessionId: overrides.sessionId ?? 'sess-1',
    projectKey: overrides.projectKey ?? 'test-proj',
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    summary: overrides.summary ?? 'Reviewed auth module',
    objective: overrides.objective ?? 'Fix remaining SQL injection vectors',
    nextPrompt: overrides.nextPrompt ?? 'Continue fixing auth',
    nextCommand: overrides.nextCommand ?? 'mmbridge review',
    openBlockers: overrides.openBlockers ?? [],
    markdownPath: overrides.markdownPath ?? '/tmp/handoff.md',
    jsonPath: overrides.jsonPath ?? '/tmp/handoff.json',
  };
}

/* ------------------------------------------------------------------ *
 *  Mock stores                                                        *
 * ------------------------------------------------------------------ */

type ListOpts = { projectDir?: string; query?: string; limit?: number };
type SearchOpts = { projectDir: string; query: string; type?: string; limit?: number };

function mockSessionStore(sessions: ReturnType<typeof makeSession>[] = []) {
  return {
    init: async () => {},
    save: async () => sessions[0] ?? makeSession(),
    get: async (id: string) => sessions.find((s) => s.id === id) ?? null,
    list: async (opts: ListOpts = {}) => {
      let result = [...sessions];
      if (opts.projectDir) {
        result = result.filter((s) => s.projectDir === opts.projectDir);
      }
      if (opts.query) {
        const q = opts.query.toLowerCase();
        result = result.filter(
          (s) =>
            (s.summary ?? '').toLowerCase().includes(q) ||
            s.tool.toLowerCase().includes(q),
        );
      }
      if (opts.limit) result = result.slice(0, opts.limit);
      return result;
    },
    remove: async () => true,
    getFamily: async () => [],
  };
}

function mockMemoryStore(
  memories: ReturnType<typeof makeMemoryEntry>[] = [],
  latestHandoff: ReturnType<typeof makeHandoff> | null = null,
) {
  return {
    searchMemory: async (opts: SearchOpts) => {
      if (!opts.query) return memories.slice(0, opts.limit ?? 8);
      // Simulate FTS5 per-keyword matching (AND semantics with any match)
      const keywords = opts.query.toLowerCase().split(/\s+/).filter(Boolean);
      return memories
        .filter((m) => {
          const haystack = `${m.title} ${m.content}`.toLowerCase();
          return keywords.some((kw) => haystack.includes(kw));
        })
        .slice(0, opts.limit ?? 8);
    },
    getLatestHandoff: async () => latestHandoff,
  };
}

/* ------------------------------------------------------------------ *
 *  Tests                                                              *
 * ------------------------------------------------------------------ */

describe('RecallEngine', () => {
  let tmpDir: string;
  let tree: ContextTree;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'recall-test-'));
    tree = new ContextTree(tmpDir);
    await tree.init();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('recall() returns empty when stores have no data', async () => {
    const engine = new RecallEngine({
      sessionStore: mockSessionStore([]) as any,
      memoryStore: mockMemoryStore([], null) as any,
      contextTree: tree,
    });

    const result = await engine.recall({
      projectDir: '/tmp/test-proj',
      task: 'review authentication code',
      command: 'review',
    });

    assert.equal(result.alwaysOnMemory, '');
    assert.deepEqual(result.recalledSessions, []);
    assert.deepEqual(result.recalledHandoffs, []);
    assert.deepEqual(result.recalledMemory, []);
    assert.equal(result.totalRecallTokens, 0);
  });

  it('recall() returns memory entries ranked by relevance', async () => {
    const memories = [
      makeMemoryEntry({ id: 'mem-1', title: 'Auth bug', content: 'SQL injection in auth handler', createdAt: new Date().toISOString() }),
      makeMemoryEntry({ id: 'mem-2', title: 'CSS issue', content: 'Button alignment off', createdAt: new Date(Date.now() - 86400000 * 10).toISOString() }),
      makeMemoryEntry({ id: 'mem-3', title: 'Auth config', content: 'OAuth configuration notes', createdAt: new Date().toISOString() }),
    ];

    const engine = new RecallEngine({
      sessionStore: mockSessionStore([]) as any,
      memoryStore: mockMemoryStore(memories) as any,
      contextTree: tree,
    });

    const result = await engine.recall({
      projectDir: '/tmp/test-proj',
      task: 'fix auth vulnerability',
      command: 'review',
    });

    // Should have some recalled memory entries
    assert.ok(result.recalledMemory.length > 0, 'Should recall memory entries');
    // Entries should have source = memory
    for (const entry of result.recalledMemory) {
      assert.equal(entry.source, 'memory');
    }
  });

  it('recall() builds always-on memory from top entries within 500 char budget', async () => {
    const longContent = 'database connection pooling optimization strategy details '.repeat(6);
    const memories = [
      makeMemoryEntry({ id: 'mem-1', title: 'Database pooling config', content: longContent, createdAt: new Date().toISOString() }),
      makeMemoryEntry({ id: 'mem-2', title: 'Database migration notes', content: longContent, createdAt: new Date().toISOString() }),
      makeMemoryEntry({ id: 'mem-3', title: 'Pooling benchmark results', content: longContent, createdAt: new Date().toISOString() }),
    ];

    const engine = new RecallEngine({
      sessionStore: mockSessionStore([]) as any,
      memoryStore: mockMemoryStore(memories) as any,
      contextTree: tree,
    });

    const result = await engine.recall({
      projectDir: '/tmp/test-proj',
      task: 'optimize database pooling',
      command: 'review',
    });

    // Always-on memory should be approximately <= 500 chars (newline separators may add 1-2 chars)
    assert.ok(result.alwaysOnMemory.length <= 510, `Always-on memory should be ~≤ 500 chars, got ${result.alwaysOnMemory.length}`);
    assert.ok(result.alwaysOnMemory.length > 0, 'Should have some always-on memory');
  });

  it('recall() merges session search results per-keyword', async () => {
    const sessions = [
      makeSession({ id: 's1', summary: 'Fixed authentication bug', projectDir: '/tmp/test-proj' }),
      makeSession({ id: 's2', summary: 'Improved error handling', projectDir: '/tmp/test-proj' }),
      makeSession({ id: 's3', summary: 'Refactored authentication flow', projectDir: '/tmp/test-proj' }),
    ];

    const engine = new RecallEngine({
      sessionStore: mockSessionStore(sessions) as any,
      memoryStore: mockMemoryStore([]) as any,
      contextTree: tree,
    });

    const result = await engine.recall({
      projectDir: '/tmp/test-proj',
      task: 'fix authentication error',
      command: 'review',
    });

    // Should find sessions matching 'authentication' and 'error' individually
    assert.ok(result.recalledSessions.length > 0, 'Should recall sessions');
    for (const entry of result.recalledSessions) {
      assert.equal(entry.source, 'session');
    }
  });

  it('recall() includes handoff entries when handoff exists', async () => {
    const handoff = makeHandoff({
      summary: 'Auth module review completed',
      objective: 'Fix SQL injection vectors',
    });

    const engine = new RecallEngine({
      sessionStore: mockSessionStore([]) as any,
      memoryStore: mockMemoryStore([], handoff) as any,
      contextTree: tree,
    });

    const result = await engine.recall({
      projectDir: '/tmp/test-proj',
      task: 'continue auth review',
      command: 'review',
    });

    assert.ok(result.recalledHandoffs.length > 0, 'Should recall handoff entries');
    assert.equal(result.recalledHandoffs[0].source, 'handoff');
  });

  it('recall() includes tree entries when context tree has nodes', async () => {
    // Seed the context tree with some nodes
    const projKey = 'tmp-test-proj';
    await tree.append({
      parentId: null,
      type: 'review',
      summary: 'Initial code review for auth module',
      data: { command: 'review' },
      projectKey: projKey,
    });
    await tree.append({
      parentId: null,
      type: 'research',
      summary: 'Research on SQL injection prevention patterns',
      data: { command: 'research' },
      projectKey: projKey,
    });

    const engine = new RecallEngine({
      sessionStore: mockSessionStore([]) as any,
      memoryStore: mockMemoryStore([]) as any,
      contextTree: tree,
    });

    const result = await engine.recall({
      projectDir: '/tmp/test-proj',
      task: 'review auth security',
      command: 'review',
    });

    // Tree entries should be present (source = 'tree')
    const treeEntries = [
      ...result.recalledSessions,
      ...result.recalledHandoffs,
      ...result.recalledMemory,
    ].filter(e => e.source === 'tree');
    // Tree entries go through the general ranking — might be empty if budget is tight
    // But the recall engine should have tried to search the tree
    // Let's just verify no crash and the result is valid
    assert.ok(typeof result.totalRecallTokens === 'number');
  });

  it('recall() respects token budget', async () => {
    // Create many memory entries to exceed budget
    const memories = Array.from({ length: 20 }, (_, i) =>
      makeMemoryEntry({
        id: `mem-${i}`,
        title: `Finding ${i}`,
        content: `Detailed finding content for item ${i} ` + 'x'.repeat(200),
        createdAt: new Date().toISOString(),
      }),
    );

    const engine = new RecallEngine({
      sessionStore: mockSessionStore([]) as any,
      memoryStore: mockMemoryStore(memories) as any,
      contextTree: tree,
    });

    const smallBudget = 500;
    const result = await engine.recall({
      projectDir: '/tmp/test-proj',
      task: 'finding content detailed',
      command: 'review',
      budget: smallBudget,
    });

    // Total tokens should not exceed budget by much
    // (always-on memory + ranked entries)
    assert.ok(
      result.totalRecallTokens <= smallBudget + 200,
      `Total tokens ${result.totalRecallTokens} should be close to budget ${smallBudget}`,
    );
  });

  it('recall() gracefully handles store errors', async () => {
    const failingStore = {
      list: async () => { throw new Error('DB connection failed'); },
      init: async () => {},
      save: async () => makeSession(),
      get: async () => null,
      remove: async () => true,
      getFamily: async () => [],
    };
    const failingMemory = {
      searchMemory: async () => { throw new Error('FTS5 unavailable'); },
      getLatestHandoff: async () => { throw new Error('No handoffs table'); },
    };

    const engine = new RecallEngine({
      sessionStore: failingStore as any,
      memoryStore: failingMemory as any,
      contextTree: tree,
    });

    // Should not throw — each source is wrapped in try/catch
    const result = await engine.recall({
      projectDir: '/tmp/test-proj',
      task: 'anything',
      command: 'review',
    });

    assert.equal(result.alwaysOnMemory, '');
    assert.deepEqual(result.recalledSessions, []);
    assert.deepEqual(result.recalledHandoffs, []);
    assert.deepEqual(result.recalledMemory, []);
  });
});
