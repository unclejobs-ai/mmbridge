import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ContextNode } from './types.js';

function defaultBaseDir(): string {
  return path.join(os.homedir(), '.mmbridge');
}

/**
 * Derive a filesystem-safe project key from an absolute directory path.
 * Uses a short SHA-256 prefix for safety across all platforms.
 * The readable prefix helps with debugging (first dir component after root).
 */
function projectKeyFromDir(projectDir: string): string {
  const resolved = path.resolve(projectDir);
  const hash = createHash('sha256').update(resolved).digest('hex').slice(0, 12);
  // Extract a readable hint — last path component (project folder name)
  const hint =
    path
      .basename(resolved)
      .replace(/[^a-zA-Z0-9_-]/g, '')
      .slice(0, 30) || 'root';
  return `${hint}-${hash}`;
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

  async append(node: Omit<ContextNode, 'id' | 'timestamp'>): Promise<ContextNode> {
    await this.init();
    const full: ContextNode = {
      ...node,
      id: randomUUID(),
      timestamp: Date.now(),
    };
    const fp = this.filePath(full.projectKey);
    await fs.appendFile(fp, `${JSON.stringify(full)}\n`, 'utf8');
    return full;
  }

  async branch(fromNodeId: string, node: Omit<ContextNode, 'id' | 'timestamp' | 'parentId'>): Promise<ContextNode> {
    return this.append({ ...node, parentId: fromNodeId });
  }

  /**
   * Find a node by ID. If projectKey is known, pass it to avoid scanning all files.
   */
  async getNode(id: string, projectKey?: string): Promise<ContextNode | null> {
    // Fast path: if projectKey is known, only scan that file
    if (projectKey) {
      const nodes = await this.loadAll(projectKey);
      return nodes.find((n) => n.id === id) ?? null;
    }
    // Slow path: scan all project files
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

  async getPath(leafId: string, projectKey?: string): Promise<ContextNode[]> {
    const result: ContextNode[] = [];
    // Use getNode with optional projectKey for first lookup
    const current = await this.getNode(leafId, projectKey);
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

  async getChildren(nodeId: string, projectKey?: string): Promise<ContextNode[]> {
    const parent = await this.getNode(nodeId, projectKey);
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

  async getRecent(projectKey: string, limit = 10): Promise<ContextNode[]> {
    const allNodes = await this.loadAll(projectKey);
    return allNodes.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
  }

  async loadAll(projectKey: string): Promise<ContextNode[]> {
    // Validate projectKey doesn't escape treesDir
    const fp = this.filePath(projectKey);
    const resolved = path.resolve(fp);
    if (!resolved.startsWith(path.resolve(this.treesDir))) {
      return []; // path traversal attempt
    }

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
        const parsed = JSON.parse(trimmed) as ContextNode;
        // Basic runtime validation
        if (parsed.id && parsed.projectKey && typeof parsed.timestamp === 'number') {
          nodes.push(parsed);
        }
      } catch {
        // skip malformed lines
      }
    }
    return nodes;
  }

  /**
   * Remove nodes by ID from a project's JSONL file.
   * Rewrites the file excluding nodes whose IDs are in the given set.
   */
  async removeNodes(projectKey: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    const allNodes = await this.loadAll(projectKey);
    const remaining = allNodes.filter((n) => !idSet.has(n.id));
    const fp = this.filePath(projectKey);
    const content = remaining.map((n) => JSON.stringify(n)).join('\n') + (remaining.length > 0 ? '\n' : '');
    await fs.writeFile(fp, content, 'utf8');
  }

  private filePath(projectKey: string): string {
    // Sanitize key to prevent path traversal
    const safe = projectKey.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.treesDir, `${safe}.jsonl`);
  }
}

export { projectKeyFromDir };
