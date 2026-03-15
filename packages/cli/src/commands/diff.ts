import type { Finding, Severity } from '@mmbridge/core';
import { exitWithError, importCore, importSessionStore, resolveProjectDir } from './helpers.js';

export interface DiffCommandOptions {
  tool?: string;
  baseRef?: string;
  project?: string;
  session?: string;
}

// ── ANSI colour helpers (no external deps) ──────────────────────────────────

const ANSI = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  magenta: '\x1b[35m',
};

function severityColor(severity: Severity): string {
  switch (severity) {
    case 'CRITICAL':
      return ANSI.red;
    case 'WARNING':
      return ANSI.yellow;
    case 'INFO':
      return ANSI.cyan;
    case 'REFACTOR':
      return ANSI.dim;
  }
}

function colorize(text: string, color: string): string {
  return `${color}${text}${ANSI.reset}`;
}

// ── Diff parsing ─────────────────────────────────────────────────────────────

interface DiffHunk {
  file: string;
  header: string;
  lines: Array<{ raw: string; lineNum: number | null }>;
}

/**
 * Parse unified diff output into per-file hunks.
 * Each hunk tracks added/context line numbers so we can match findings.
 */
function parseDiffHunks(diffText: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let currentFile = '';
  let currentHunk: DiffHunk | null = null;
  let currentNewLine = 0;

  for (const rawLine of diffText.split('\n')) {
    // New file header
    if (rawLine.startsWith('diff --git ')) {
      const m = /diff --git a\/(.+) b\//.exec(rawLine);
      if (m) currentFile = m[1];
      currentHunk = null;
      continue;
    }
    if (rawLine.startsWith('+++ b/')) {
      currentFile = rawLine.slice(6).trim();
      continue;
    }
    if (rawLine.startsWith('--- ') || rawLine.startsWith('+++ ')) continue;

    // Hunk header: @@ -old,count +new,start @@
    const hunkMatch = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/.exec(rawLine);
    if (hunkMatch) {
      currentNewLine = Number.parseInt(hunkMatch[1], 10);
      currentHunk = {
        file: currentFile,
        header: rawLine,
        lines: [],
      };
      hunks.push(currentHunk);
      continue;
    }

    if (!currentHunk) continue;

    if (rawLine.startsWith('+')) {
      currentHunk.lines.push({ raw: rawLine, lineNum: currentNewLine });
      currentNewLine++;
    } else if (rawLine.startsWith('-')) {
      currentHunk.lines.push({ raw: rawLine, lineNum: null });
    } else {
      // Context line
      currentHunk.lines.push({ raw: rawLine, lineNum: currentNewLine });
      currentNewLine++;
    }
  }

  return hunks;
}

// ── Finding lookup ────────────────────────────────────────────────────────────

/**
 * Build a lookup: file -> line -> Finding[]
 * Findings with no file or no line are placed under file='' for separate display.
 */
function buildFindingIndex(findings: Finding[]): Map<string, Map<number | null, Finding[]>> {
  const index = new Map<string, Map<number | null, Finding[]>>();

  for (const f of findings) {
    const fileKey = f.file ?? '';
    if (!index.has(fileKey)) index.set(fileKey, new Map());
    const lineMap = index.get(fileKey)!;
    const lineKey = f.line ?? null;
    if (!lineMap.has(lineKey)) lineMap.set(lineKey, []);
    lineMap.get(lineKey)?.push(f);
  }

  return index;
}

/**
 * Find findings relevant to a given file+line.
 * Matches exact line, null-line (file-level), or findings on adjacent lines (±2).
 */
function findingsForLine(index: Map<string, Map<number | null, Finding[]>>, file: string, lineNum: number): Finding[] {
  const lineMap = index.get(file);
  if (!lineMap) return [];

  const results: Finding[] = [];

  // File-level findings (no specific line)
  const fileLevel = lineMap.get(null);
  if (fileLevel) results.push(...fileLevel);

  // Exact line match
  const exact = lineMap.get(lineNum);
  if (exact) results.push(...exact);

  // Adjacent line match (±2 tolerance for imprecise parsers)
  for (let delta = -2; delta <= 2; delta++) {
    if (delta === 0) continue;
    const nearby = lineMap.get(lineNum + delta);
    if (nearby) results.push(...nearby);
  }

  // Deduplicate by message+severity
  const seen = new Set<string>();
  return results.filter((f) => {
    const key = `${f.severity}:${f.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function renderAnnotation(finding: Finding): string {
  const col = severityColor(finding.severity);
  const tag = colorize(`[${finding.severity}]`, col);
  const msg = colorize(finding.message, col);
  return `    ${ANSI.dim}←${ANSI.reset} ${tag} ${msg}`;
}

function renderDiffLine(raw: string): string {
  if (raw.startsWith('+')) return colorize(raw, ANSI.green);
  if (raw.startsWith('-')) return colorize(raw, ANSI.red);
  return ANSI.dim + raw + ANSI.reset;
}

function renderFileHeader(file: string): string {
  const bar = '─'.repeat(Math.max(0, 60 - file.length - 4));
  return `${ANSI.bold}── ${file} ${bar}${ANSI.reset}`;
}

// ── Session helpers ───────────────────────────────────────────────────────────

interface SessionFindingsResult {
  findings: Finding[];
  baseRef: string | null;
}

async function loadSessionFindings(
  projectDir: string,
  sessionId: string | undefined,
  tool: string | undefined,
): Promise<SessionFindingsResult> {
  const { SessionStore } = await importSessionStore();
  const store = new SessionStore(projectDir);

  let session = null;

  if (sessionId) {
    session = await store.get(sessionId);
    if (!session) {
      exitWithError(`Session not found: ${sessionId}`);
    }
  } else {
    const sessions = await store.list({ projectDir, tool });
    if (sessions.length === 0) {
      exitWithError(
        tool
          ? `No sessions found for tool "${tool}" in this project. Run "mmbridge review" first.`
          : 'No sessions found for this project. Run "mmbridge review" first.',
      );
    }
    session = sessions[0]; // list() is already sorted newest-first
  }

  const rawFindings = session.findings ?? [];
  const findings: Finding[] = rawFindings;

  // If no structured findings, try to parse from summary
  if (findings.length === 0 && session.summary) {
    const { parseFindings, detectParseState } = await importCore();
    const state = detectParseState(session.summary);
    if (state !== 'structured' || findings.length === 0) {
      return {
        findings: parseFindings(session.summary),
        baseRef: (session as { baseRef?: string }).baseRef ?? null,
      };
    }
  }

  return {
    findings,
    baseRef: (session as { baseRef?: string }).baseRef ?? null,
  };
}

// ── Summary footer ────────────────────────────────────────────────────────────

function renderSummary(findings: Finding[]): string {
  const counts: Record<Severity, number> = { CRITICAL: 0, WARNING: 0, INFO: 0, REFACTOR: 0 };
  for (const f of findings) counts[f.severity]++;

  const parts: string[] = [];
  for (const [sev, n] of Object.entries(counts) as [Severity, number][]) {
    if (n > 0) {
      parts.push(colorize(`${n} ${sev}`, severityColor(sev)));
    }
  }

  const total = findings.length;
  const bar = '━'.repeat(52);
  return [
    colorize(bar, ANSI.dim),
    ` ${ANSI.bold}${total} finding${total !== 1 ? 's' : ''}${ANSI.reset}${parts.length > 0 ? ` (${parts.join(', ')})` : ''}`,
  ].join('\n');
}

// ── Main command ──────────────────────────────────────────────────────────────

export async function runDiffCommand(options: DiffCommandOptions): Promise<void> {
  const projectDir = resolveProjectDir(options.project);

  const { findings, baseRef: sessionBaseRef } = await loadSessionFindings(projectDir, options.session, options.tool);

  const { getDiff, getDefaultBaseRef } = await importCore();

  const resolvedBaseRef = options.baseRef ?? sessionBaseRef ?? (await getDefaultBaseRef(projectDir));

  const diffText = await getDiff(resolvedBaseRef, projectDir);

  if (!diffText.trim()) {
    process.stdout.write(`${ANSI.dim}No diff found against ${resolvedBaseRef}${ANSI.reset}\n`);
    return;
  }

  const hunks = parseDiffHunks(diffText);
  const findingIndex = buildFindingIndex(findings);

  // Track which findings were rendered (to show orphaned ones at end)
  const renderedFindingMessages = new Set<string>();

  // Group hunks by file
  const fileHunks = new Map<string, DiffHunk[]>();
  for (const hunk of hunks) {
    if (!fileHunks.has(hunk.file)) fileHunks.set(hunk.file, []);
    fileHunks.get(hunk.file)?.push(hunk);
  }

  const output: string[] = [];

  for (const [file, fileSectionHunks] of fileHunks) {
    output.push(renderFileHeader(file));

    for (const hunk of fileSectionHunks) {
      output.push(colorize(hunk.header, ANSI.magenta));

      for (const { raw, lineNum } of hunk.lines) {
        output.push(renderDiffLine(raw));

        // Annotate added/context lines with findings
        if (lineNum !== null && raw.startsWith('+')) {
          const matched = findingsForLine(findingIndex, file, lineNum);
          for (const f of matched) {
            output.push(renderAnnotation(f));
            renderedFindingMessages.add(`${f.severity}:${f.message}`);
          }
        }
      }
    }

    output.push('');
  }

  // Orphaned file-level findings (no line match in diff)
  const fileOnlyFindings = findings.filter((f) => {
    const key = `${f.severity}:${f.message}`;
    if (renderedFindingMessages.has(key)) return false;
    // Show if file matches a changed file or if file is empty (global)
    return f.file === '' || fileHunks.has(f.file);
  });

  if (fileOnlyFindings.length > 0) {
    output.push(`${ANSI.bold}── Additional findings ─────────────────────────────────────${ANSI.reset}`);
    for (const f of fileOnlyFindings) {
      const loc = f.file ? ` ${ANSI.dim}${f.file}${f.line != null ? `:${f.line}` : ''}${ANSI.reset}` : '';
      const col = severityColor(f.severity);
      output.push(`  ${colorize(`[${f.severity}]`, col)}${loc} ${colorize(f.message, col)}`);
    }
    output.push('');
  }

  output.push(renderSummary(findings));

  process.stdout.write(`${output.join('\n')}\n`);
}
