import type { Finding, InterpretResult } from './types.js';
import { commandExists, parseCodexAgentMessages, runCommand } from './utils.js';

export async function interpretFindings(options: {
  mergedFindings: Finding[];
  changedFiles: string[];
  projectContext: string;
  workspace: string;
}): Promise<InterpretResult> {
  // Build interpretation prompt
  const findingsList = options.mergedFindings
    .map(
      (f, i) =>
        `${i + 1}. [${f.severity}] ${f.file}:${f.line ?? '?'} — ${f.message} (sources: ${f.sources?.join(', ') ?? 'unknown'})`,
    )
    .join('\n');

  const prompt = [
    '# Finding Interpretation Task',
    '',
    'You are reviewing code findings from multiple AI tools that have been merged by consensus.',
    'Analyze each finding and determine:',
    '1. Is this a TRUE positive (real issue) or FALSE positive (not actually a problem)?',
    '2. Are there any CRITICAL issues that were missed or underrated?',
    '3. What is the priority action plan?',
    '',
    '## Findings to Evaluate',
    findingsList,
    '',
    '## Changed Files',
    options.changedFiles
      .slice(0, 20)
      .map((f) => `- ${f}`)
      .join('\n'),
    '',
    '## Output Format (JSON)',
    '```json',
    '{',
    '  "validated": [<indices of true positive findings, 0-based>],',
    '  "falsePositives": [{"index": <number>, "reason": "..."}],',
    '  "promoted": [{"severity": "CRITICAL", "file": "...", "line": null, "message": "..."}],',
    '  "actionPlan": "1. ... 2. ... 3. ..."',
    '}',
    '```',
    '',
    'Respond with ONLY the JSON block above.',
  ].join('\n');

  try {
    const codexAvailable = await commandExists('codex').catch(() => false);

    if (!codexAvailable) {
      return gracefulFallback(options.mergedFindings);
    }

    const result = await runCommand(
      'codex',
      ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '-C', options.workspace, '-'],
      {
        cwd: options.workspace,
        input: prompt,
        timeoutMs: 120_000,
      },
    );

    if (!result.ok) {
      return gracefulFallback(options.mergedFindings);
    }

    return parseInterpretResponse(result.combined, options.mergedFindings);
  } catch {
    return gracefulFallback(options.mergedFindings);
  }
}

function parseInterpretResponse(raw: string, findings: Finding[]): InterpretResult {
  const messages = parseCodexAgentMessages(raw);
  const lastMessage = messages.at(-1) ?? '';

  if (!lastMessage) {
    return gracefulFallback(findings);
  }

  // Extract JSON from the message
  const jsonMatch = lastMessage.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return gracefulFallback(findings);
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;

    const validatedIndices = Array.isArray(parsed.validated) ? (parsed.validated as number[]) : [];
    const fpEntries = Array.isArray(parsed.falsePositives)
      ? (parsed.falsePositives as Array<{ index: number; reason: string }>)
      : [];
    const promotedRaw = Array.isArray(parsed.promoted) ? (parsed.promoted as Array<Record<string, unknown>>) : [];
    const actionPlan = typeof parsed.actionPlan === 'string' ? parsed.actionPlan : '';

    const fpIndices = new Set(fpEntries.map((e) => e.index));

    const validated = findings.filter((_, i) => validatedIndices.includes(i) && !fpIndices.has(i));
    const falsePositives = fpEntries
      .filter((e) => e.index >= 0 && e.index < findings.length)
      .map((e) => ({ finding: findings[e.index]!, reason: e.reason }));

    const promoted: Finding[] = promotedRaw.map((p) => ({
      severity: (typeof p.severity === 'string' ? p.severity : 'CRITICAL') as Finding['severity'],
      file: typeof p.file === 'string' ? p.file : '',
      line: typeof p.line === 'number' ? p.line : null,
      message: typeof p.message === 'string' ? p.message : '',
      sources: ['codex-interpretation'],
    }));

    return {
      validated: validated.length > 0 ? validated : findings.filter((_, i) => !fpIndices.has(i)),
      falsePositives,
      promoted,
      actionPlan,
      interpreterTool: 'codex',
    };
  } catch {
    return gracefulFallback(findings);
  }
}

function gracefulFallback(findings: Finding[]): InterpretResult {
  return {
    validated: findings,
    falsePositives: [],
    promoted: [],
    actionPlan: '',
    interpreterTool: 'none',
  };
}
