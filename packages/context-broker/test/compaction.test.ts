import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { autoCompact, compactSubtree } from '../dist/compaction.js';
import type { CompactionAdapter } from '../dist/compaction.js';
import { ContextTree } from '../dist/context-tree.js';

/** Mock adapter that returns a predictable summary without calling any LLM. */
class MockCompactionAdapter implements CompactionAdapter {
  public lastPrompt = '';
  public callCount = 0;

  async summarize(prompt: string): Promise<string> {
    this.lastPrompt = prompt;
    this.callCount++;
    return `[compacted] mock summary #${this.callCount}`;
  }
}

describe('compactSubtree', () => {
  let tmpDir: string;
  let tree: ContextTree;
  const projectKey = 'compact-test';

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mmbridge-compact-'));
    tree = new ContextTree(tmpDir);
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('compacts a linear chain into a single compaction node', async () => {
    const adapter = new MockCompactionAdapter();

    const root = await tree.append({
      parentId: null,
      type: 'task',
      summary: 'implement auth module',
      data: {},
      projectKey,
    });

    const mid = await tree.append({
      parentId: root.id,
      type: 'research',
      summary: 'researched OAuth2 patterns',
      data: {},
      projectKey,
    });

    const leaf = await tree.append({
      parentId: mid.id,
      type: 'review',
      summary: 'reviewed token refresh flow',
      data: {},
      projectKey,
    });

    const result = await compactSubtree(tree, leaf.id, {
      adapter,
      projectKey,
    });

    assert.ok(result !== null);
    assert.equal(result?.type, 'compaction');
    assert.equal(result?.summary, '[compacted] mock summary #1');
    assert.equal(result?.parentId, null); // root's parent was null
    assert.equal(result?.projectKey, projectKey);
    assert.equal((result?.data as any).nodeCount, 3);
    assert.deepEqual((result?.data as any).compactedIds, [leaf.id, mid.id, root.id]);

    // Verify the prompt sent to the adapter
    assert.ok(adapter.lastPrompt.includes('implement auth module'));
    assert.ok(adapter.lastPrompt.includes('researched OAuth2 patterns'));
    assert.ok(adapter.lastPrompt.includes('reviewed token refresh flow'));
    assert.equal(adapter.callCount, 1);
  });

  it('returns null for a non-existent leaf id', async () => {
    const adapter = new MockCompactionAdapter();

    const result = await compactSubtree(tree, 'does-not-exist', {
      adapter,
      projectKey,
    });

    assert.equal(result, null);
    assert.equal(adapter.callCount, 0);
  });

  it('handles adapter errors gracefully', async () => {
    const failAdapter: CompactionAdapter = {
      async summarize(): Promise<string> {
        throw new Error('LLM unavailable');
      },
    };

    const node = await tree.append({
      parentId: null,
      type: 'task',
      summary: 'will fail compaction',
      data: {},
      projectKey,
    });

    const result = await compactSubtree(tree, node.id, {
      adapter: failAdapter,
      projectKey,
    });

    assert.equal(result, null);
  });

  it('compacts a single-node path', async () => {
    const adapter = new MockCompactionAdapter();

    const solo = await tree.append({
      parentId: null,
      type: 'task',
      summary: 'standalone task',
      data: {},
      projectKey,
    });

    const result = await compactSubtree(tree, solo.id, {
      adapter,
      projectKey,
    });

    assert.ok(result !== null);
    assert.equal(result?.type, 'compaction');
    assert.equal((result?.data as any).nodeCount, 1);
    assert.equal(adapter.callCount, 1);
  });
});

describe('autoCompact', () => {
  let tmpDir: string;
  let tree: ContextTree;
  const projectKey = 'autocompact-test';

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mmbridge-autocompact-'));
    tree = new ContextTree(tmpDir);
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('does nothing when node count is below threshold', async () => {
    const adapter = new MockCompactionAdapter();

    // Add a few nodes — well below threshold
    for (let i = 0; i < 5; i++) {
      await tree.append({
        parentId: null,
        type: 'task',
        summary: `task ${i}`,
        data: {},
        projectKey,
      });
    }

    const results = await autoCompact(tree, projectKey, {
      adapter,
      threshold: 50,
    });

    assert.equal(results.length, 0);
    assert.equal(adapter.callCount, 0);
  });

  it('compacts old branches when threshold is exceeded', async () => {
    const pk = 'autocompact-exceed';
    const adapter = new MockCompactionAdapter();

    // Create a tree with 10 independent branches (each root + one child = 20 nodes)
    // Use a low threshold of 10 to trigger compaction
    const roots = [];
    for (let i = 0; i < 8; i++) {
      const root = await tree.append({
        parentId: null,
        type: 'task',
        summary: `root task ${i}`,
        data: {},
        projectKey: pk,
      });
      roots.push(root);

      await tree.append({
        parentId: root.id,
        type: 'review',
        summary: `review of task ${i}`,
        data: {},
        projectKey: pk,
      });
    }

    const allBefore = await tree.loadAll(pk);
    assert.ok(allBefore.length >= 10); // 16 nodes total

    const results = await autoCompact(tree, pk, {
      adapter,
      threshold: 10,
    });

    assert.ok(results.length > 0);
    // Every result should be a compaction node
    for (const r of results) {
      assert.equal(r.type, 'compaction');
      assert.equal(r.projectKey, pk);
    }
    assert.ok(adapter.callCount > 0);
  });

  it('skips already-compacted leaves', async () => {
    const pk = 'autocompact-skip';
    const adapter = new MockCompactionAdapter();

    // Add enough nodes to exceed threshold
    for (let i = 0; i < 6; i++) {
      await tree.append({
        parentId: null,
        type: 'compaction', // already compacted
        summary: `compacted ${i}`,
        data: {},
        projectKey: pk,
      });
    }

    const results = await autoCompact(tree, pk, {
      adapter,
      threshold: 5,
    });

    // No compactable leaves (all are already type 'compaction')
    assert.equal(results.length, 0);
    assert.equal(adapter.callCount, 0);
  });
});
