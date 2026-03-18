import type { DebatePosition, DebateRound, DebateRoundType, DebateVerdict, InsightConfidence } from './types.js';

// Adapter strengths — used to assign emphasis in prompts
const ADAPTER_DEBATE_STRENGTHS: Record<string, string> = {
  kimi: 'deep contextual analysis and pattern recognition',
  qwen: 'security implications and standards compliance',
  codex: 'practical implementation and feasibility',
  gemini: 'creative alternatives and broad perspective',
  droid: 'mobile ecosystem and platform-specific concerns',
  claude: 'logical reasoning and structured argumentation',
};

function formatRoundForHistory(round: DebateRound): string {
  const header = `### Round ${round.roundNumber} — ${round.type}`;
  const positions = round.positions
    .map((p) => {
      const lines = [
        `**[${p.source}]** Stance: ${p.stance}`,
        p.arguments.length > 0 ? `Arguments:\n${p.arguments.map((a, i) => `  ${i + 1}. ${a}`).join('\n')}` : '',
        p.evidence.length > 0 ? `Evidence:\n${p.evidence.map((e) => `  - ${e}`).join('\n')}` : '',
        `Confidence: ${p.confidence}`,
      ]
        .filter(Boolean)
        .join('\n');
      return lines;
    })
    .join('\n\n');

  const extras: string[] = [];
  if (round.agreements && round.agreements.length > 0) {
    extras.push(`Agreements:\n${round.agreements.map((a) => `  - ${a}`).join('\n')}`);
  }
  if (round.disagreements && round.disagreements.length > 0) {
    extras.push(`Disagreements:\n${round.disagreements.map((d) => `  - ${d}`).join('\n')}`);
  }

  return [header, positions, ...extras].filter(Boolean).join('\n\n');
}

export function buildRoundPrompt(options: {
  proposition: string;
  roundNumber: number;
  roundType: DebateRoundType;
  tool: string;
  previousRounds: DebateRound[];
  teams?: { for: string[]; against: string[] };
}): string {
  const { proposition, roundNumber, roundType, tool, previousRounds, teams } = options;
  const strength = ADAPTER_DEBATE_STRENGTHS[tool] ?? 'analytical reasoning and structured thinking';

  if (roundType === 'position') {
    let teamLine = '';
    if (teams) {
      const side = teams.for.includes(tool) ? 'for' : teams.against.includes(tool) ? 'against' : null;
      if (side) {
        teamLine = `\nYou are on the **${side}** team for this debate.`;
      }
    }

    return [
      `# MMBridge Debate: Round ${roundNumber} — Position Statement`,
      '',
      `## Proposition: ${proposition}`,
      '',
      `You are ${tool}, known for ${strength}.${teamLine}`,
      '',
      'State your position on this proposition. Structure your response as follows:',
      '',
      '**Stance**: for|against|nuanced',
      '',
      '**Arguments**:',
      '1. [First argument]',
      '2. [Second argument]',
      '3. [Third argument]',
      '',
      '**Evidence**:',
      '- [Supporting evidence or example]',
      '- [Additional evidence]',
      '',
      '**Confidence**: high|medium|low',
    ].join('\n');
  }

  if (roundType === 'synthesis') {
    const history = previousRounds.map(formatRoundForHistory).join('\n\n---\n\n');

    return [
      `# MMBridge Debate: Round ${roundNumber} — Synthesis`,
      '',
      `## Proposition: ${proposition}`,
      '',
      '## Full Debate History:',
      '',
      history,
      '',
      '---',
      '',
      `You are ${tool}, known for ${strength}.`,
      '',
      'Based on the complete debate history above, provide a synthesis. Identify:',
      '',
      '**Agreements**: Points where participants converge or share common ground.',
      '',
      '**Persistent Disagreements**: Points that remain genuinely contested.',
      '',
      '**Novel Insights**: New ideas or perspectives that emerged through discussion.',
      '',
      '**Recommended Action**: Given the debate outcome, what should be done?',
    ].join('\n');
  }

  // cross-examination (all middle rounds)
  const lastRound = previousRounds[previousRounds.length - 1];
  const previousPositions = lastRound
    ? lastRound.positions
        .map((p) => {
          const args =
            p.arguments.length > 0 ? `\nArguments:\n${p.arguments.map((a, i) => `  ${i + 1}. ${a}`).join('\n')}` : '';
          return `**[${p.source}]** Stance: ${p.stance}${args}`;
        })
        .join('\n\n')
    : '(no previous positions available)';

  return [
    `# MMBridge Debate: Round ${roundNumber} — Cross-Examination`,
    '',
    `## Proposition: ${proposition}`,
    '',
    '## Previous Positions:',
    '',
    previousPositions,
    '',
    '---',
    '',
    `You are ${tool}, known for ${strength}.`,
    '',
    'Critique the strongest argument from each opposing position.',
    'For each position you address, identify:',
    '- The core assumption being challenged',
    '- Why that assumption may be flawed or incomplete',
    '- A counter-argument or alternative framing',
    '',
    'Structure your response clearly with one section per position addressed.',
  ].join('\n');
}

function extractAfterMarker(text: string, marker: string): string {
  const markerLower = marker.toLowerCase();
  const lower = text.toLowerCase();
  const idx = lower.indexOf(markerLower);
  if (idx === -1) return '';
  const after = text.slice(idx + marker.length).trim();
  // Take only until the next bold marker
  const nextBold = after.indexOf('\n**');
  return nextBold !== -1 ? after.slice(0, nextBold).trim() : (after.split('\n')[0]?.trim() ?? '');
}

function extractListAfterMarker(text: string, marker: string): string[] {
  const markerLower = marker.toLowerCase();
  const lower = text.toLowerCase();
  const idx = lower.indexOf(markerLower);
  if (idx === -1) return [];

  const after = text.slice(idx + marker.length);
  // Find the block until the next bold section marker
  const nextBold = after.indexOf('\n**');
  const block = nextBold !== -1 ? after.slice(0, nextBold) : after;

  const lines: string[] = [];
  for (const line of block.split('\n')) {
    const trimmed = line.trim();
    // Match numbered list items (1. ...) or bullet list items (- ..., * ...)
    const numbered = trimmed.match(/^\d+\.\s+(.+)$/);
    const bullet = trimmed.match(/^[-*]\s+(.+)$/);
    const matched = numbered?.[1] ?? bullet?.[1];
    if (matched) {
      lines.push(matched.trim());
    }
  }
  return lines;
}

function extractConfidence(text: string): InsightConfidence {
  const lower = text.toLowerCase();
  const idx = lower.indexOf('**confidence**');
  if (idx === -1) {
    // fallback: scan full text for bare confidence keywords
    if (lower.includes('confidence: high') || lower.includes('high confidence')) return 'high';
    if (lower.includes('confidence: low') || lower.includes('low confidence')) return 'low';
    return 'medium';
  }
  const after = lower.slice(idx + '**confidence**'.length).slice(0, 40);
  if (after.includes('high')) return 'high';
  if (after.includes('low')) return 'low';
  return 'medium';
}

function extractStance(text: string): DebatePosition['stance'] {
  // Look for explicit **Stance**: marker first
  const stanceMarker = text.toLowerCase().indexOf('**stance**');
  if (stanceMarker !== -1) {
    const after = text.slice(stanceMarker + '**stance**'.length, stanceMarker + 60).toLowerCase();
    if (after.includes('against')) return 'against';
    if (after.includes('nuanced')) return 'nuanced';
    if (after.includes('for')) return 'for';
  }

  // Fallback: keyword matching in full text
  const lower = text.toLowerCase();
  const forIdx = lower.indexOf(' for ');
  const againstIdx = lower.indexOf('against');
  const nuancedIdx = lower.indexOf('nuanced');

  if (nuancedIdx !== -1 && (forIdx === -1 || nuancedIdx < forIdx) && (againstIdx === -1 || nuancedIdx < againstIdx)) {
    return 'nuanced';
  }
  if (againstIdx !== -1 && (forIdx === -1 || againstIdx < forIdx)) {
    return 'against';
  }
  if (forIdx !== -1) return 'for';
  return 'nuanced';
}

export function parsePositions(tool: string, text: string, roundType: DebateRoundType): DebatePosition {
  const stance = extractStance(text);
  const args = extractListAfterMarker(text, '**arguments**:');
  const evidence = extractListAfterMarker(text, '**evidence**:');
  const confidence = extractConfidence(text);

  // For synthesis rounds, also try to extract agreements/insights as arguments
  if (roundType === 'synthesis' && args.length === 0) {
    const agreements = extractListAfterMarker(text, '**agreements**:');
    const insights = extractListAfterMarker(text, '**novel insights**:');
    const action = extractAfterMarker(text, '**recommended action**:');
    const synthesisArgs: string[] = [...agreements, ...insights];
    if (action) synthesisArgs.push(`Recommended action: ${action}`);
    return {
      source: tool,
      stance,
      arguments: synthesisArgs,
      evidence,
      confidence,
      rawText: text,
    };
  }

  return {
    source: tool,
    stance,
    arguments: args,
    evidence,
    confidence,
    rawText: text,
  };
}

export function computeVerdict(rounds: DebateRound[]): DebateVerdict {
  const allPositions = rounds.flatMap((r) => r.positions);

  // Tally stances
  const stanceCounts: Record<string, number> = { for: 0, against: 0, nuanced: 0 };
  for (const pos of allPositions) {
    stanceCounts[pos.stance] = (stanceCounts[pos.stance] ?? 0) + 1;
  }

  // Agreements: arguments that appear (similar phrasing) across 2+ tools
  // Use simple overlap: collect argument texts, find duplicates by first-word group
  const argumentMap: Map<string, Set<string>> = new Map();
  for (const pos of allPositions) {
    for (const arg of pos.arguments) {
      const key = arg.toLowerCase().split(' ').slice(0, 4).join(' ');
      if (!argumentMap.has(key)) {
        argumentMap.set(key, new Set());
      }
      argumentMap.get(key)?.add(pos.source);
    }
  }

  const agreements: string[] = [];

  for (const [key, sources] of argumentMap.entries()) {
    if (sources.size >= 2) {
      // Find the original argument text
      for (const pos of allPositions) {
        const match = pos.arguments.find((a) => a.toLowerCase().startsWith(key));
        if (match) {
          agreements.push(match);
          break;
        }
      }
    }
  }

  // Disagreements: adapters with opposing stances
  const disagreements: string[] = [];
  const forTools = allPositions.filter((p) => p.stance === 'for').map((p) => p.source);
  const againstTools = allPositions.filter((p) => p.stance === 'against').map((p) => p.source);

  if (forTools.length > 0 && againstTools.length > 0) {
    disagreements.push(
      `${[...new Set(forTools)].join(', ')} support the proposition; ${[...new Set(againstTools)].join(', ')} oppose it.`,
    );
  }

  // Novel insights: arguments that appeared only in later rounds (round >= 2)
  const novelInsights: string[] = [];
  const round1Args = new Set(
    rounds
      .filter((r) => r.roundNumber === 1)
      .flatMap((r) => r.positions)
      .flatMap((p) => p.arguments.map((a) => a.toLowerCase().slice(0, 40))),
  );

  for (const round of rounds) {
    if (round.roundNumber < 2) continue;
    for (const pos of round.positions) {
      for (const arg of pos.arguments) {
        const key = arg.toLowerCase().slice(0, 40);
        if (!round1Args.has(key)) {
          novelInsights.push(arg);
        }
      }
    }
  }

  // Determine conclusion based on majority stance
  const maxStance = Object.entries(stanceCounts).sort((a, b) => b[1] - a[1])[0];
  const majorityStance = maxStance?.[0] ?? 'nuanced';
  const majorityCount = maxStance?.[1] ?? 0;
  const totalVotes = allPositions.length;

  let conclusion: string;
  if (majorityStance === 'for' && majorityCount > totalVotes / 2) {
    conclusion = `The majority of participants support the proposition (${majorityCount}/${totalVotes}).`;
  } else if (majorityStance === 'against' && majorityCount > totalVotes / 2) {
    conclusion = `The majority of participants oppose the proposition (${majorityCount}/${totalVotes}).`;
  } else {
    conclusion = 'Participants are divided on the proposition. No clear majority stance emerged.';
  }

  // Recommended action based on consensus
  const highConfidencePositions = allPositions.filter((p) => p.confidence === 'high');
  const highConfidenceFor = highConfidencePositions.filter((p) => p.stance === 'for').length;
  const highConfidenceAgainst = highConfidencePositions.filter((p) => p.stance === 'against').length;

  let recommendedAction: string;
  if (highConfidenceFor > highConfidenceAgainst) {
    recommendedAction = 'Proceed with the proposition — high-confidence support outweighs opposition.';
  } else if (highConfidenceAgainst > highConfidenceFor) {
    recommendedAction = 'Reconsider the proposition — high-confidence opposition warrants revision.';
  } else if (agreements.length > 2) {
    recommendedAction = 'Move forward with careful consideration of the identified agreements and disagreements.';
  } else {
    recommendedAction = 'Conduct further analysis — insufficient consensus to make a clear recommendation.';
  }

  return {
    conclusion,
    agreements: [...new Set(agreements)].slice(0, 10),
    disagreements: [...new Set(disagreements)].slice(0, 10),
    novelInsights: [...new Set(novelInsights)].slice(0, 10),
    recommendedAction,
  };
}
