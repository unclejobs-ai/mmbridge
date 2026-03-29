import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ContextTree } from '../dist/context-tree.js';

describe('ContextTree', () => {
  let tmpDir: string;
  let tree: ContextTree;
  const projectKey = 'test-project';

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mmbridge-test-'));
    tree = new ContextTree(tmpDir);
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('append() creates a node with id and timestamp', async () => {
    const node = await tree.append({
      parentId: null,
      type: 'task',
      summary: 'root node',
      data: { foo: 1 },
      projectKey,
    });

    assert.ok(typeof node.id === 'string');
    assert.ok(node.id.length > 0);
    assert.ok(typeof node.timestamp === 'number');
    assert.ok(node.timestamp > 0);
    assert.equal(node.summary, 'root node');
    assert.equal(node.parentId, null);
    assert.equal(node.type, 'task');
    assert.equal(node.projectKey, projectKey);
  });

  it('getNode() returns the appended node', async () => {
    const appended = await tree.append({
      parentId: null,
      type: 'review',
      summary: 'findable node',
      data: {},
      projectKey,
    });

    const found = await tree.getNode(appended.id);
    assert.ok(found !== null);
    assert.equal(found!.id, appended.id);
    assert.equal(found!.summary, 'findable node');
    assert.equal(found!.type, 'review');
  });

  it('branch() creates node with correct parentId', async () => {
    const root = await tree.append({
      parentId: null,
      type: 'task',
      summary: 'branch root',
      data: {},
      projectKey,
    });

    const child = await tree.branch(root.id, {
      type: 'recall',
      summary: 'branch child',
      data: { ref: 'abc' },
      projectKey,
    });

    assert.ok(typeof child.id === 'string');
    assert.equal(child.parentId, root.id);
    assert.equal(child.type, 'recall');
    assert.equal(child.summary, 'branch child');
  });

  it('getPath() returns root-to-leaf path', async () => {
    const root = await tree.append({
      parentId: null,
      type: 'task',
      summary: 'path root',
      data: {},
      projectKey,
    });

    const mid = await tree.branch(root.id, {
      type: 'review',
      summary: 'path mid',
      data: {},
      projectKey,
    });

    const leaf = await tree.branch(mid.id, {
      type: 'handoff',
      summary: 'path leaf',
      data: {},
      projectKey,
    });

    const nodePath = await tree.getPath(leaf.id);
    // getPath returns leaf-to-root, so reverse for root-to-leaf check
    assert.ok(nodePath.length >= 3);
    assert.equal(nodePath[0].id, leaf.id);
    assert.equal(nodePath[nodePath.length - 1].parentId, null);
    // Verify the chain: leaf -> mid -> root
    assert.equal(nodePath[0].id, leaf.id);
    assert.equal(nodePath[1].id, mid.id);
    assert.equal(nodePath[2].id, root.id);
  });

  it('getLeaves() returns only leaf nodes', async () => {
    // Use a separate project so we can control the tree shape exactly
    const pk = 'leaves-test';
    const root = await tree.append({
      parentId: null,
      type: 'task',
      summary: 'leaves root',
      data: {},
      projectKey: pk,
    });

    const child1 = await tree.branch(root.id, {
      type: 'review',
      summary: 'leaf A',
      data: {},
      projectKey: pk,
    });

    const child2 = await tree.branch(root.id, {
      type: 'recall',
      summary: 'leaf B',
      data: {},
      projectKey: pk,
    });

    const leaves = await tree.getLeaves(pk);
    const leafIds = leaves.map((n) => n.id);

    // root is a parent, so not a leaf
    assert.ok(!leafIds.includes(root.id));
    // Both children are leaves
    assert.ok(leafIds.includes(child1.id));
    assert.ok(leafIds.includes(child2.id));
    assert.equal(leaves.length, 2);
  });

  it('getRecent() returns most recent N nodes', async () => {
    const pk = 'recent-test';
    const nodes = [];
    for (let i = 0; i < 5; i++) {
      const n = await tree.append({
        parentId: null,
        type: 'task',
        summary: `recent-${i}`,
        data: {},
        projectKey: pk,
      });
      nodes.push(n);
    }

    const recent = await tree.getRecent(pk, 3);
    assert.equal(recent.length, 3);
    // Most recent first
    assert.ok(recent[0].timestamp >= recent[1].timestamp);
    assert.ok(recent[1].timestamp >= recent[2].timestamp);
  });

  it('loadAll() returns all nodes', async () => {
    const pk = 'loadall-test';
    await tree.append({
      parentId: null,
      type: 'task',
      summary: 'node A',
      data: {},
      projectKey: pk,
    });
    await tree.append({
      parentId: null,
      type: 'review',
      summary: 'node B',
      data: {},
      projectKey: pk,
    });

    const all = await tree.loadAll(pk);
    assert.equal(all.length, 2);
    const summaries = all.map((n) => n.summary);
    assert.ok(summaries.includes('node A'));
    assert.ok(summaries.includes('node B'));
  });

  it('getNode() returns null for missing id', async () => {
    const result = await tree.getNode('nonexistent-id-12345');
    assert.equal(result, null);
  });

  it('loadAll() returns empty array for non-existent project', async () => {
    const result = await tree.loadAll('completely-unknown-project');
    assert.ok(Array.isArray(result));
    assert.equal(result.length, 0);
  });
});
