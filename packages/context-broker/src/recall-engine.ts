import type { HandoffArtifact, MemoryEntry, Session } from '@mmbridge/session-store';
import type { SessionStore } from '@mmbridge/session-store';
import type { ProjectMemoryStore } from '@mmbridge/session-store';
import { projectKeyFromDir } from './context-tree.js';
import type { ContextTree } from './context-tree.js';
import type { ContextNode, RecallEntry } from './types.js';

/** Stop-words excluded from keyword extraction. */
const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'but',
  'in',
  'on',
  'at',
  'to',
  'for',
  'of',
  'with',
  'by',
  'from',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'could',
  'should',
  'may',
  'might',
  'shall',
  'can',
  'this',
  'that',
  'these',
  'those',
  'it',
  'its',
  'not',
  'no',
  'nor',
  'so',
  'if',
  'then',
  'than',
  'too',
  'very',
  'just',
  'about',
  'also',
  'all',
  'each',
  'every',
  'any',
  'some',
  'such',
  'into',
  'over',
  'after',
  'before',
  'between',
  'under',
  'above',
  'out',
  'up',
  'down',
  'off',
]);

const DEFAULT_BUDGET = 2000;
const ALWAYS_ON_LIMIT = 500;

interface RecallOptions {
  projectDir: string;
  task: string;
  command: string;
  treeLeafId?: string;
  budget?: number;
}

interface RecallResult {
  alwaysOnMemory: string;
  recalledSessions: RecallEntry[];
  recalledHandoffs: RecallEntry[];
  recalledMemory: RecallEntry[];
  recalledTree: RecallEntry[];
  totalRecallTokens: number;
}

interface RecallEngineDeps {
  sessionStore: SessionStore;
  memoryStore: ProjectMemoryStore;
  contextTree: ContextTree;
}

function extractKeywords(text: string): string {
  return text
    .split(/[^a-zA-Z0-9_]+/)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t))
    .slice(0, 12)
    .join(' ');
}

function recencyBonus(createdAt: string): number {
  const ageMs = Date.now() - new Date(createdAt).getTime();
  const oneDay = 24 * 60 * 60 * 1000;
  const oneWeek = 7 * oneDay;
  if (ageMs <= oneDay) return 0.3;
  if (ageMs <= oneWeek) return 0.15;
  return 0;
}

export class RecallEngine {
  private readonly sessionStore: SessionStore;
  private readonly memoryStore: ProjectMemoryStore;
  private readonly contextTree: ContextTree;

  constructor(deps: RecallEngineDeps) {
    this.sessionStore = deps.sessionStore;
    this.memoryStore = deps.memoryStore;
    this.contextTree = deps.contextTree;
  }

  async recall(options: RecallOptions): Promise<RecallResult> {
    const { projectDir, task, command, treeLeafId } = options;
    const budget = options.budget ?? DEFAULT_BUDGET;
    const query = extractKeywords(`${task} ${command}`);
    const projectKey = projectKeyFromDir(projectDir);

    // Gather from all sources in parallel — each is wrapped in try/catch
    const [memoryEntries, sessionEntries, handoffEntries, treeEntries] = await Promise.all([
      this.searchMemory(query, projectDir),
      this.searchSessions(query, projectDir),
      this.searchHandoffs(query, projectDir),
      this.searchTree(query, projectKey, treeLeafId),
    ]);

    // Build always-on memory from highest-relevance memory entries
    const sortedMemory = [...memoryEntries].sort((a, b) => b.relevance - a.relevance);
    let alwaysOnMemory = '';
    let charBudget = ALWAYS_ON_LIMIT;
    for (const entry of sortedMemory) {
      if (charBudget <= 0) break;
      const chunk = entry.summary.slice(0, charBudget);
      alwaysOnMemory += (alwaysOnMemory ? '\n' : '') + chunk;
      charBudget -= chunk.length;
    }

    // Remaining budget after always-on
    const alwaysOnTokens = this.estimateTokens(alwaysOnMemory);
    const remainingBudget = Math.max(0, budget - alwaysOnTokens);

    // Rank all entries together for budget allocation
    const allEntries = [...memoryEntries, ...sessionEntries, ...handoffEntries, ...treeEntries];
    const ranked = this.rankByRelevance(allEntries, remainingBudget);

    // Split back into categories
    const recalledMemory = ranked.filter((e) => e.source === 'memory');
    const recalledSessions = ranked.filter((e) => e.source === 'session');
    const recalledHandoffs = ranked.filter((e) => e.source === 'handoff');
    const recalledTree = ranked.filter((e) => e.source === 'tree');

    const totalRecallTokens = alwaysOnTokens + ranked.reduce((sum, e) => sum + e.tokenCount, 0);

    return {
      alwaysOnMemory,
      recalledSessions,
      recalledHandoffs,
      recalledMemory,
      recalledTree,
      totalRecallTokens,
    };
  }

  private async searchMemory(query: string, projectDir: string): Promise<RecallEntry[]> {
    try {
      const entries: MemoryEntry[] = await this.memoryStore.searchMemory({
        projectDir,
        query,
        limit: 10,
      });
      return entries.map((entry) => ({
        source: 'memory' as const,
        id: entry.id,
        relevance: 0.5 + recencyBonus(entry.createdAt),
        summary: `[${entry.type}] ${entry.title}: ${entry.content}`.slice(0, 500),
        tokenCount: this.estimateTokens(`[${entry.type}] ${entry.title}: ${entry.content}`),
      }));
    } catch {
      return [];
    }
  }

  private async searchSessions(query: string, projectDir: string): Promise<RecallEntry[]> {
    try {
      // SessionStore.list() does substring matching, so search per-keyword
      // to avoid requiring the full phrase as a contiguous substring.
      const keywords = query.split(/\s+/).filter(Boolean);
      const seen = new Set<string>();
      const allSessions: Session[] = [];

      if (keywords.length === 0) {
        // No query — just get recent sessions for this project
        const recent = await this.sessionStore.list({ projectDir, limit: 8 });
        allSessions.push(...recent);
      } else {
        // Search per keyword, merge results
        const perKeyword = await Promise.all(
          keywords.slice(0, 5).map((kw) => this.sessionStore.list({ projectDir, query: kw, limit: 4 })),
        );
        for (const batch of perKeyword) {
          for (const s of batch) {
            if (!seen.has(s.id)) {
              seen.add(s.id);
              allSessions.push(s);
            }
          }
        }
      }

      return allSessions
        .filter((s) => s.summary)
        .map((s) => {
          const text = `${s.tool} ${s.mode}: ${s.summary ?? ''}`;
          // Boost relevance when more keywords match the summary
          const matchCount = keywords.filter((kw) => (s.summary ?? '').toLowerCase().includes(kw.toLowerCase())).length;
          const keywordBoost = keywords.length > 0 ? 0.15 * (matchCount / keywords.length) : 0;
          return {
            source: 'session' as const,
            id: s.id,
            relevance: 0.4 + recencyBonus(s.createdAt) + keywordBoost,
            summary: text.slice(0, 500),
            tokenCount: this.estimateTokens(text),
          };
        })
        .sort((a, b) => b.relevance - a.relevance)
        .slice(0, 8);
    } catch {
      return [];
    }
  }

  private async searchHandoffs(query: string, projectDir: string): Promise<RecallEntry[]> {
    try {
      // Use getLatestHandoff as the primary handoff source.
      // Also search memory entries with handoff-related types as secondary source.
      const results: RecallEntry[] = [];

      const latestHandoff: HandoffArtifact | null = await this.memoryStore.getLatestHandoff(projectDir);
      if (latestHandoff) {
        const text = `Handoff: ${latestHandoff.summary}\nObjective: ${latestHandoff.objective}\nNext: ${latestHandoff.nextPrompt}`;
        results.push({
          source: 'handoff' as const,
          id: latestHandoff.id,
          relevance: 0.6 + recencyBonus(latestHandoff.createdAt),
          summary: text.slice(0, 500),
          tokenCount: this.estimateTokens(text),
        });
      }

      // Search memory for handoff-related blockers and followup goals
      const blockerEntries: MemoryEntry[] = await this.memoryStore.searchMemory({
        projectDir,
        query: query || '',
        type: 'blocker',
        limit: 4,
      });
      for (const entry of blockerEntries) {
        if (entry.handoffId) {
          const text = `[blocker] ${entry.title}: ${entry.content}`;
          results.push({
            source: 'handoff' as const,
            id: entry.id,
            relevance: 0.55 + recencyBonus(entry.createdAt),
            summary: text.slice(0, 500),
            tokenCount: this.estimateTokens(text),
          });
        }
      }

      return results;
    } catch {
      return [];
    }
  }

  private async searchTree(query: string, projectKey: string, leafId?: string): Promise<RecallEntry[]> {
    try {
      const recentNodes: ContextNode[] = await this.contextTree.getRecent(projectKey, 10);
      if (recentNodes.length === 0) return [];

      // If we have a leaf, compute path to find same-branch nodes
      let branchNodeIds: Set<string> | null = null;
      if (leafId) {
        try {
          const pathNodes = await this.contextTree.getPath(leafId, projectKey);
          branchNodeIds = new Set(pathNodes.map((n) => n.id));
        } catch {
          branchNodeIds = null;
        }
      }

      const keywords = query.toLowerCase().split(/\s+/).filter(Boolean);

      return recentNodes.map((node) => {
        const text = `[${node.type}] ${node.summary}`;
        let relevance = 0.3;

        // Recency bonus based on timestamp
        const ageMs = Date.now() - node.timestamp;
        const oneDay = 24 * 60 * 60 * 1000;
        const oneWeek = 7 * oneDay;
        if (ageMs <= oneDay) relevance += 0.3;
        else if (ageMs <= oneWeek) relevance += 0.15;

        // Tree proximity bonus
        if (branchNodeIds?.has(node.id)) {
          relevance += 0.2;
        }

        // Keyword match bonus
        const summaryLower = node.summary.toLowerCase();
        const matchCount = keywords.filter((kw) => summaryLower.includes(kw)).length;
        if (keywords.length > 0) {
          relevance += 0.1 * (matchCount / keywords.length);
        }

        return {
          source: 'tree' as const,
          id: node.id,
          relevance,
          summary: text.slice(0, 500),
          tokenCount: this.estimateTokens(text),
        };
      });
    } catch {
      return [];
    }
  }

  private rankByRelevance(entries: RecallEntry[], budget: number): RecallEntry[] {
    // Deduplicate by id, keeping highest relevance
    const byId = new Map<string, RecallEntry>();
    for (const entry of entries) {
      const existing = byId.get(entry.id);
      if (!existing || entry.relevance > existing.relevance) {
        byId.set(entry.id, entry);
      }
    }

    // Sort by relevance descending
    const sorted = Array.from(byId.values()).sort((a, b) => b.relevance - a.relevance);

    // Fill within budget
    const result: RecallEntry[] = [];
    let usedTokens = 0;
    for (const entry of sorted) {
      if (usedTokens + entry.tokenCount > budget) continue;
      result.push(entry);
      usedTokens += entry.tokenCount;
    }

    return result;
  }

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}
