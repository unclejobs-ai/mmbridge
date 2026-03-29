import type { ContextTree } from './context-tree.js';
import type { ContextNode } from './types.js';

/**
 * Adapter interface for LLM-based compaction.
 * Callers plug in any model by implementing this single method.
 */
export interface CompactionAdapter {
  summarize(prompt: string): Promise<string>;
}

export interface CompactSubtreeOptions {
  /** The adapter that calls an LLM (or mock) to produce summaries. */
  adapter: CompactionAdapter;
  /** Project key — speeds up node lookups when provided. */
  projectKey?: string;
}

export interface AutoCompactOptions {
  /** The adapter that calls an LLM (or mock) to produce summaries. */
  adapter: CompactionAdapter;
  /** Maximum number of nodes before auto-compaction kicks in (default: 50). */
  threshold?: number;
}

/**
 * Walk the parent chain from `leafId`, concatenate summaries,
 * ask the LLM adapter to compress them into one summary,
 * then append a single compaction node that replaces the subtree.
 *
 * Returns the newly created compaction node, or `null` on failure.
 */
export async function compactSubtree(
  tree: ContextTree,
  leafId: string,
  options: CompactSubtreeOptions,
): Promise<ContextNode | null> {
  try {
    const { adapter, projectKey } = options;

    // Walk parent chain (leaf-to-root)
    const pathNodes = await tree.getPath(leafId, projectKey);
    if (pathNodes.length === 0) {
      return null;
    }

    // Build the lineage text in root-to-leaf order
    const rootToLeaf = [...pathNodes].reverse();
    const lineage = rootToLeaf.map((n) => `[${n.type}] ${n.summary}`).join('\n');

    const prompt = `Summarize this task lineage into a concise context paragraph:\n${lineage}`;

    const compactedSummary = await adapter.summarize(prompt);

    // The compaction node's parent is the root of the compacted subtree's parent
    // (i.e. the parent of the oldest ancestor in the chain).
    const root = rootToLeaf[0];
    const compactedParentId = root.parentId;
    const pk = projectKey ?? pathNodes[0].projectKey;

    // Collect compacted node ids for provenance
    const compactedIds = pathNodes.map((n) => n.id);

    const compactionNode = await tree.append({
      parentId: compactedParentId,
      type: 'compaction',
      summary: compactedSummary,
      data: {
        compactedIds,
        originalLeafId: leafId,
        nodeCount: pathNodes.length,
      },
      projectKey: pk,
    });

    return compactionNode;
  } catch {
    return null;
  }
}

/**
 * Check whether a project tree exceeds a threshold and, if so,
 * automatically compact the oldest branches.
 *
 * Returns an array of newly created compaction nodes (may be empty).
 */
export async function autoCompact(
  tree: ContextTree,
  projectKey: string,
  opts: AutoCompactOptions,
): Promise<ContextNode[]> {
  try {
    const threshold = opts.threshold ?? 50;
    const allNodes = await tree.loadAll(projectKey);

    if (allNodes.length < threshold) {
      return [];
    }

    // Find leaf nodes — candidates for compaction
    const parentIds = new Set<string>();
    for (const n of allNodes) {
      if (n.parentId !== null) {
        parentIds.add(n.parentId);
      }
    }
    const leaves = allNodes.filter((n) => !parentIds.has(n.id));

    // Sort leaves by timestamp ascending (oldest first)
    leaves.sort((a, b) => a.timestamp - b.timestamp);

    // Skip compaction-type leaves — they are already compacted
    const compactable = leaves.filter((n) => n.type !== 'compaction');

    // Compact the oldest half of compactable leaves
    const toCompact = compactable.slice(0, Math.max(1, Math.floor(compactable.length / 2)));

    const results: ContextNode[] = [];
    for (const leaf of toCompact) {
      const result = await compactSubtree(tree, leaf.id, {
        adapter: opts.adapter,
        projectKey,
      });
      if (result) {
        results.push(result);
        // Remove the original compacted nodes from the JSONL file
        const compactedIds = (result.data as { compactedIds?: string[] }).compactedIds;
        if (compactedIds && compactedIds.length > 0) {
          await tree.removeNodes(projectKey, compactedIds);
        }
      }
    }

    return results;
  } catch {
    return [];
  }
}
