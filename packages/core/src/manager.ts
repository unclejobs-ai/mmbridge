import type { Finding, ManagerResult } from './types.js';
import { commandExists, parseCodexAgentMessages, runCommand } from './utils.js';

interface ManagerToolResult {
  tool: string;
  findings: Finding[];
  summary: string;
  skipped: boolean;
  error?: string;
}

export interface RunManagerReviewOptions {
  mergedFindings: Finding[];
  toolResults: ManagerToolResult[];
  changedFiles: string[];
  workspace: string;
}

export async function runManagerReview(options: RunManagerReviewOptions): Promise<ManagerResult> {
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
        input: buildManagerPrompt(options),
        timeoutMs: 120_000,
      },
    );

    if (!result.ok) {
      return gracefulFallback(options.mergedFindings);
    }

    return parseManagerResponse(result.combined, options.mergedFindings, options.changedFiles);
  } catch {
    return gracefulFallback(options.mergedFindings);
  }
}

function buildManagerPrompt(options: RunManagerReviewOptions): string {
  const consensus = options.mergedFindings
    .map(
      (finding, index) =>
        `${index}. [${finding.severity}] ${finding.file}:${finding.line ?? '?'} — ${finding.message} (sources: ${finding.sources?.join(', ') ?? 'unknown'})`,
    )
    .join('\n');

  const lanes = options.toolResults
    .map((result) => {
      const status = result.error
        ? `error: ${result.error}`
        : result.skipped
          ? 'skipped'
          : `${result.findings.length} finding(s)`;
      const sample = result.findings
        .slice(0, 3)
        .map((finding) => `  - [${finding.severity}] ${finding.file}:${finding.line ?? '?'} — ${finding.message}`)
        .join('\n');
      return [
        `## ${result.tool}`,
        status,
        result.summary ? `summary: ${result.summary}` : null,
        sample || '  - no findings',
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');

  const changedFiles = options.changedFiles
    .slice(0, 20)
    .map((file) => `- ${file}`)
    .join('\n');

  return [
    '# Manager Review Task',
    '',
    'You are the supervising review manager for a multi-tool code review run.',
    'Your job is to decide which consensus findings survive, which should be dismissed, and whether any critical item should be promoted into the final set.',
    'Prefer conservative decisions. Do not invent files outside the changed files list.',
    '',
    '## Changed Files',
    changedFiles || '- none',
    '',
    '## Consensus Findings',
    consensus || '- none',
    '',
    '## Tool Lanes',
    lanes || '- no tool results',
    '',
    '## Output Format (JSON only)',
    '```json',
    '{',
    '  "validated": [0],',
    '  "dismissed": [{"index": 1, "reason": "..." }],',
    '  "promoted": [{"severity": "CRITICAL", "file": "src/x.ts", "line": 12, "message": "..."}],',
    '  "summary": "Short manager summary of what survived and why.",',
    '  "actionPlan": "1. ... 2. ... 3. ..."',
    '}',
    '```',
    '',
    'Rules:',
    '- `validated` must contain 0-based indices into the consensus findings list.',
    '- `dismissed` items must reference consensus finding indices.',
    '- `promoted` should be used sparingly, only for clearly important misses or severity upgrades.',
    '- Respond with JSON only.',
  ].join('\n');
}

function parseManagerResponse(raw: string, findings: Finding[], changedFiles: string[]): ManagerResult {
  const messages = parseCodexAgentMessages(raw);
  const lastMessage = messages.at(-1) ?? '';
  if (!lastMessage) {
    return gracefulFallback(findings);
  }

  const jsonMatch = lastMessage.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return gracefulFallback(findings);
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    const dismissedRaw = Array.isArray(parsed.dismissed)
      ? (parsed.dismissed as Array<{ index: number; reason: string }>)
      : [];
    const validatedIndices = Array.isArray(parsed.validated) ? (parsed.validated as number[]) : [];
    const promotedRaw = Array.isArray(parsed.promoted) ? (parsed.promoted as Array<Record<string, unknown>>) : [];
    const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
    const actionPlan = typeof parsed.actionPlan === 'string' ? parsed.actionPlan : '';

    const dismissedIndices = new Set<number>();
    const dismissed = dismissedRaw.flatMap((entry) => {
      if (typeof entry.index !== 'number' || entry.index < 0 || entry.index >= findings.length) {
        return [];
      }
      dismissedIndices.add(entry.index);
      const finding = findings[entry.index];
      return finding ? [{ finding, reason: typeof entry.reason === 'string' ? entry.reason : '' }] : [];
    });

    const validated = findings.filter((_, index) => validatedIndices.includes(index) && !dismissedIndices.has(index));
    const changedFileSet = new Set(changedFiles);
    const promoted =
      changedFileSet.size === 0
        ? []
        : promotedRaw.flatMap((entry) => {
            const severity = typeof entry.severity === 'string' ? entry.severity.toUpperCase() : '';
            const file = typeof entry.file === 'string' ? entry.file.trim() : '';
            const message = typeof entry.message === 'string' ? entry.message.trim() : '';
            const line =
              typeof entry.line === 'number' && Number.isInteger(entry.line) && entry.line > 0 ? entry.line : null;

            if (!['CRITICAL', 'WARNING', 'INFO', 'REFACTOR'].includes(severity)) return [];
            if (!file || !message || !changedFileSet.has(file)) return [];

            return [
              {
                severity: severity as Finding['severity'],
                file,
                line,
                message,
                sources: ['manager-review'],
              },
            ];
          });

    return {
      managerTool: 'codex',
      summary:
        summary ||
        `Manager kept ${validated.length || findings.length - dismissed.length} finding(s) and dismissed ${dismissed.length}.`,
      actionPlan,
      validated: validated.length > 0 || dismissed.length > 0 ? validated : findings,
      dismissed,
      promoted,
    };
  } catch {
    return gracefulFallback(findings);
  }
}

function gracefulFallback(findings: Finding[]): ManagerResult {
  return {
    managerTool: 'none',
    summary:
      findings.length > 0
        ? `Manager fallback kept ${findings.length} consensus finding(s) unchanged.`
        : 'Manager fallback found no consensus findings.',
    actionPlan: '',
    validated: findings,
    dismissed: [],
    promoted: [],
  };
}
