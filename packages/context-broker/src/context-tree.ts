import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ContextNode } from './types.js';

function defaultBaseDir(): string {
  return path.join(os.homedir(), '.mmbridge');
}

function projectKeyFromDir(projectDir: string): string {
  return path
    .resolve(projectDir)
    .replace(/[\\/]/g, '-')
    .replace(/^(?!-)/, '-');
}

export class ContextTree {
  readonly basePath: string;
  private readonly treesDir: string;

  constructor(basePath: string = defaultBaseDir()) {
    this.basePath = basePath;
    this.treesDir = path.join(basePath, 'context-trees');
  }

  async init(): Promise<void> {
    await fs.mkdir(this.treesDir, { recursive: true });
  }

  async append(
    node: Omit<ContextNode, 'id' | 'timestamp'>,
  ): Promise<ContextNode> {
    await this.init();
    const full: ContextNode = {
      ...node,
      id: randomUUID(),
      timestamp: Date.now(),
    };
    const fp = this.filePath(full.projectKey);
    await fs.appendFile(fp, JSON.stringify(full) + '\n', 'utf8');
    return full;
  }

  async branch(
    fromNodeId: string,
    node: Omit<ContextNode, 'id' | 'timestamp' | 'parentId'>,
  ): Promise<ContextNode> {
    return this.append({ ...node, parentId: fromNodeId });
  }

  async getNode(id: string): Promise<ContextNode | null> {
    // We need to search across all tree files since we don't know the projectKey
    try {
      const files = await fs.readdir(this.treesDir);
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        const pk = file.slice(0, -'.jsonl'.length);
        const nodes = await this.loadAll(pk);
        const found = nodes.find((n) => n.id === id);
        if (found) return found;
      }
    } catch {
      // treesDir doesn't exist yet
    }
    return null;
  }

  async getPath(leafId: string): Promise<ContextNode[]> {
    const result: ContextNode[] = [];
    let current = await this.getNode(leafId);
    if (!current) return result;

    // Load all nodes for this project once for efficient traversal
    const allNodes = await this.loadAll(current.projectKey);
    const nodeMap = new Map<string, ContextNode>();
    for (const n of allNodes) {
      nodeMap.set(n.id, n);
    }

    let cursor: ContextNode | undefined = current;
    while (cursor) {
      result.push(cursor);
      if (cursor.parentId === null) break;
      cursor = nodeMap.get(cursor.parentId);
    }

    return result;
  }

  async getChildren(nodeId: string): Promise<ContextNode[]> {
    const parent = await this.getNode(nodeId);
    if (!parent) return [];
    const allNodes = await this.loadAll(parent.projectKey);
    return allNodes.filter((n) => n.parentId === nodeId);
  }

  async getLeaves(projectKey: string): Promise<ContextNode[]> {
    const allNodes = await this.loadAll(projectKey);
    const parentIds = new Set<string>();
    for (const n of allNodes) {
      if (n.parentId !== null) {
        parentIds.add(n.parentId);
      }
    }
    return allNodes.filter((n) => !parentIds.has(n.id));
  }

  async getRecent(
    projectKey: string,
    limit: number = 10,
  ): Promise<ContextNode[]> {
    const allNodes = await this.loadAll(projectKey);
    return allNodes
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  async loadAll(projectKey: string): Promise<ContextNode[]> {
    const fp = this.filePath(projectKey);
    let raw: string;
    try {
      raw = await fs.readFile(fp, 'utf8');
    } catch {
      return [];
    }
    const nodes: ContextNode[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        nodes.push(JSON.parse(trimmed) as ContextNode);
      } catch {
        // skip malformed lines
      }
    }
    return nodes;
  }

  private filePath(projectKey: string): string {
    return path.join(this.treesDir, `${projectKey}.jsonl`);
  }
}

export { projectKeyFromDir };
