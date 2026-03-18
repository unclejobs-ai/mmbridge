import { randomUUID } from 'node:crypto';
import type { InsightConfidence, ResearchInsight, ResearchReport, ResearchType } from './types.js';
import { nowIso } from './utils.js';

export interface SynthesizeInput {
  topic: string;
  type: ResearchType;
  toolOutputs: Array<{ tool: string; text: string }>;
}

// ─── Adapter affinity hints ──────────────────────────────────────────────────

const ADAPTER_RESEARCH_HINTS: Record<string, string[]> = {
  kimi: ['pattern-analysis', 'deep-context', 'long-form'],
  qwen: ['security-aware', 'standards', 'best-practices'],
  codex: ['implementation', 'code-generation', 'pragmatic'],
  gemini: ['multi-modal', 'broad-knowledge', 'creative'],
  droid: ['android-ecosystem', 'mobile-patterns'],
  claude: ['reasoning', 'nuanced-analysis', 'structured'],
};

// ─── Insight parsing ─────────────────────────────────────────────────────────

interface ParsedInsight {
  content: string;
  confidence: InsightConfidence;
  sources: string[];
  category: 'consensus' | 'unique' | 'contradiction';
  normalizedWords: Set<string>;
}

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function significantWords(text: string): Set<string> {
  return new Set(
    normalizeText(text)
      .split(' ')
      .filter((w) => w.length > 4),
  );
}

function overlapRatio(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) {
    if (b.has(word)) shared++;
  }
  return shared / Math.min(a.size, b.size);
}

function extractConfidence(marker: string): InsightConfidence {
  const normalized = marker.trim().toUpperCase();
  if (normalized === 'HIGH' || normalized === 'CRITICAL' || normalized === 'STRONG') return 'high';
  if (normalized === 'LOW' || normalized === 'WEAK' || normalized === 'UNCERTAIN') return 'low';
  return 'medium';
}

function parseInsightsFromText(text: string): ParsedInsight[] {
  const insights: ParsedInsight[] = [];

  // Split by **[CONFIDENCE]** pattern first
  const confidencePattern = /\*\*\[([^\]]+)\]\*\*\s+([\s\S]*?)(?=\*\*\[|$)/g;
  let hasStructuredInsights = false;
  let match: RegExpExecArray | null;

  for (match = confidencePattern.exec(text); match !== null; match = confidencePattern.exec(text)) {
    const [, confidenceMarker, rawContent] = match;
    if (!rawContent?.trim()) continue;

    hasStructuredInsights = true;

    // Extract sources and category from content
    const sourcesMatch = rawContent.match(/Sources?:\s*([^\n]+)/i);
    const categoryMatch = rawContent.match(/Category:\s*(consensus|unique|contradiction)/i);
    const cleanContent = rawContent
      .replace(/Sources?:\s*[^\n]+/i, '')
      .replace(/Category:\s*[^\n]+/i, '')
      .trim();

    const sources = sourcesMatch
      ? sourcesMatch[1]
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

    const category = (categoryMatch?.[1] as 'consensus' | 'unique' | 'contradiction' | undefined) ?? 'unique';

    if (cleanContent.length < 10) continue;

    insights.push({
      content: cleanContent,
      confidence: extractConfidence(confidenceMarker ?? ''),
      sources,
      category,
      normalizedWords: significantWords(cleanContent),
    });
  }

  if (!hasStructuredInsights) {
    // Fall back to paragraph-based parsing
    const paragraphs = text
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter((p) => p.length > 40);

    for (const para of paragraphs) {
      insights.push({
        content: para,
        confidence: 'medium',
        sources: [],
        category: 'unique',
        normalizedWords: significantWords(para),
      });
    }
  }

  return insights;
}

// ─── Cross-referencing ───────────────────────────────────────────────────────

interface IndexedInsight extends ParsedInsight {
  tool: string;
}

function classifyInsights(allInsights: IndexedInsight[]): {
  consensus: IndexedInsight[][];
  unique: IndexedInsight[];
  contradictions: IndexedInsight[][];
} {
  const used = new Set<number>();
  const consensusGroups: IndexedInsight[][] = [];
  const contradictions: IndexedInsight[][] = [];

  // Find consensus: similar insights from 2+ tools
  for (let i = 0; i < allInsights.length; i++) {
    if (used.has(i)) continue;
    const group: IndexedInsight[] = [allInsights[i]];

    for (let j = i + 1; j < allInsights.length; j++) {
      if (used.has(j)) continue;
      const insight = allInsights[i];
      const candidate = allInsights[j];
      if (insight.tool === candidate.tool) continue;

      const ratio = overlapRatio(insight.normalizedWords, candidate.normalizedWords);
      if (ratio >= 0.4) {
        group.push(candidate);
        used.add(j);
      }
    }

    if (group.length >= 2) {
      used.add(i);
      consensusGroups.push(group);
    }
  }

  // Find contradictions: insights that are about the same topic but express opposing views
  // Detect by topic similarity (>0.3) + presence of negation markers
  const negationMarkers = ['not', 'never', 'avoid', 'wrong', 'bad', 'harmful', 'dangerous', 'should not', "shouldn't"];

  const remaining = allInsights.filter((_, idx) => !used.has(idx));
  const usedInContradiction = new Set<IndexedInsight>();
  for (let i = 0; i < remaining.length; i++) {
    const insightA = remaining[i];
    if (usedInContradiction.has(insightA)) continue;
    for (let j = i + 1; j < remaining.length; j++) {
      const insightB = remaining[j];
      if (usedInContradiction.has(insightB)) continue;
      if (insightA.tool === insightB.tool) continue;

      const topicOverlap = overlapRatio(insightA.normalizedWords, insightB.normalizedWords);
      if (topicOverlap < 0.2 || topicOverlap >= 0.4) continue;

      // Check if one has negation where the other doesn't
      const aHasNegation = negationMarkers.some((m) => insightA.content.toLowerCase().includes(m));
      const bHasNegation = negationMarkers.some((m) => insightB.content.toLowerCase().includes(m));

      if (aHasNegation !== bHasNegation) {
        contradictions.push([insightA, insightB]);
        usedInContradiction.add(insightA);
        usedInContradiction.add(insightB);
      }
    }
  }

  const contradictionInsights = new Set(contradictions.flat());
  const unique = remaining.filter((insight) => !contradictionInsights.has(insight));

  return { consensus: consensusGroups, unique, contradictions };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function synthesizeResearch(input: SynthesizeInput): ResearchReport {
  const { topic, type, toolOutputs } = input;

  // Parse insights from each adapter's text, caching counts for later use
  const allInsights: IndexedInsight[] = [];
  const insightCountByTool: Record<string, number> = {};
  for (const { tool, text } of toolOutputs) {
    const parsed = parseInsightsFromText(text);
    insightCountByTool[tool] = parsed.length;
    for (const insight of parsed) {
      allInsights.push({ ...insight, tool });
    }
  }

  const { consensus: consensusGroups, unique, contradictions } = classifyInsights(allInsights);

  // Build consensus ResearchInsights
  const consensusInsights: ResearchInsight[] = consensusGroups.map((group) => {
    const lead = group[0];
    const sources = [...new Set(group.map((g) => g.tool))];
    const highestConfidence = group.some((g) => g.confidence === 'high')
      ? 'high'
      : group.some((g) => g.confidence === 'medium')
        ? 'medium'
        : 'low';

    const tags = [...new Set(sources.flatMap((tool) => ADAPTER_RESEARCH_HINTS[tool] ?? []))];

    return {
      id: randomUUID(),
      content: lead.content,
      sources,
      confidence: highestConfidence,
      category: 'consensus',
      tags,
    };
  });

  // Build unique insights per tool
  const uniqueInsightsMap: Record<string, ResearchInsight[]> = {};
  for (const insight of unique) {
    const tags = ADAPTER_RESEARCH_HINTS[insight.tool] ?? [];
    const ri: ResearchInsight = {
      id: randomUUID(),
      content: insight.content,
      sources: [insight.tool],
      confidence: insight.confidence,
      category: 'unique',
      tags,
    };

    if (!uniqueInsightsMap[insight.tool]) {
      uniqueInsightsMap[insight.tool] = [];
    }
    uniqueInsightsMap[insight.tool].push(ri);
  }

  // Build contradiction ResearchInsights
  const contradictionInsights: ResearchInsight[] = contradictions.map((pair) => {
    const [a, b] = pair;
    const sources = [a.tool, b.tool];
    const tags = [...new Set(sources.flatMap((tool) => ADAPTER_RESEARCH_HINTS[tool] ?? []))];

    return {
      id: randomUUID(),
      content: a.content,
      sources,
      confidence: 'medium',
      category: 'contradiction',
      tags,
      positions: [
        { source: a.tool, position: a.content },
        { source: b.tool, position: b.content },
      ],
    };
  });

  // Calculate model contributions using cached insight counts
  const modelContributions: Record<string, { insightCount: number; uniqueCount: number }> = {};
  for (const { tool } of toolOutputs) {
    const toolUniqueCount = (uniqueInsightsMap[tool] ?? []).length;
    modelContributions[tool] = {
      insightCount: insightCountByTool[tool] ?? 0,
      uniqueCount: toolUniqueCount,
    };
  }

  // Build summary
  const totalInsights = consensusInsights.length + unique.length + contradictionInsights.length;
  const toolsUsed = toolOutputs.map((t) => t.tool).join(', ');
  const summary = [
    `Research on "${topic}" (${type}) synthesized ${totalInsights} insights from ${toolOutputs.length} adapters (${toolsUsed}).`,
    `Found ${consensusInsights.length} consensus insight${consensusInsights.length !== 1 ? 's' : ''},`,
    `${unique.length} unique observation${unique.length !== 1 ? 's' : ''},`,
    `and ${contradictionInsights.length} contradiction${contradictionInsights.length !== 1 ? 's' : ''}.`,
  ].join(' ');

  return {
    topic,
    type,
    consensus: consensusInsights,
    uniqueInsights: uniqueInsightsMap,
    contradictions: contradictionInsights,
    summary,
    modelContributions,
    generatedAt: nowIso(),
  };
}
