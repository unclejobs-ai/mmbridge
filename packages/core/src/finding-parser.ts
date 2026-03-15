import type { Finding, Severity } from './types.js';

// Matches [CRITICAL], [WARNING], [INFO], [REFACTOR] — case-insensitive
const SEVERITY_TAG_RE = /\[(CRITICAL|WARNING|INFO|REFACTOR)\]/i;

// Matches a file path with optional line number: path/to/file.ts:42 or path/to/file.ts
// File must contain at least one slash or dot to avoid matching plain words
const FILE_REF_RE = /([a-zA-Z0-9_./-]+\.[a-zA-Z]{1,10})(?::(\d+))?/;

// Matches markdown headings containing severity words
const HEADING_SEVERITY_RE = /^#{1,4}\s+.*?(critical|warning|info|refactor)/i;

// Severity word -> canonical Severity
const SEVERITY_WORD_MAP: Record<string, Severity> = {
  critical: 'CRITICAL',
  warning: 'WARNING',
  warn: 'WARNING',
  info: 'INFO',
  information: 'INFO',
  refactor: 'REFACTOR',
};

function normalizeSeverity(raw: string): Severity {
  return SEVERITY_WORD_MAP[raw.toLowerCase()] ?? 'INFO';
}

/**
 * Attempt to extract a file reference and optional line number from text.
 * Returns { file, line } or null if no credible file reference is found.
 */
function extractFileRef(text: string): { file: string; line: number | null } | null {
  const match = FILE_REF_RE.exec(text);
  if (!match) return null;

  const candidate = match[1];
  // Reject candidates that look like version strings (e.g., "1.2.3") or URIs
  if (/^\d+\.\d+/.test(candidate)) return null;
  if (candidate.startsWith('http')) return null;

  const line = match[2] !== undefined ? Number.parseInt(match[2], 10) : null;
  return { file: candidate, line };
}

/**
 * Parse a single line that has a severity tag and return a Finding, or null.
 */
function parseTaggedLine(line: string, raw: string): Finding | null {
  const tagMatch = SEVERITY_TAG_RE.exec(line);
  if (!tagMatch) return null;

  const severity = normalizeSeverity(tagMatch[1]);

  // Strip the severity tag from the line to get the rest
  const afterTag = line.slice(tagMatch.index + tagMatch[0].length).trim();

  // Try to extract a file reference from the segment before or after the tag
  const beforeTag = line.slice(0, tagMatch.index).trim();
  const fileRef = extractFileRef(beforeTag) ?? extractFileRef(afterTag);

  // Build the message from the content after the tag, stripping leading separators
  const message = afterTag
    .replace(/^[-–—:]\s*/, '')
    .replace(/\*\*/g, '')
    .trim();

  if (!message) return null;

  return {
    severity,
    file: fileRef?.file ?? '',
    line: fileRef?.line ?? null,
    message,
    raw,
    confidence: 'high',
  };
}

/**
 * Extract severity from a markdown heading line.
 * Returns null if the heading doesn't reference a severity.
 */
function headingSeverity(line: string): Severity | null {
  const match = HEADING_SEVERITY_RE.exec(line);
  if (!match) return null;
  return normalizeSeverity(match[1]);
}

type ParseSection = {
  severity: Severity | null;
};

/**
 * Parse raw adapter text output into structured Finding[].
 */
export function parseFindings(rawText: string): Finding[] {
  const lines = rawText.split('\n');
  const findings: Finding[] = [];

  let currentSection: ParseSection = { severity: null };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) continue;

    // 1. Detect markdown heading with severity — update current section context
    const headSev = headingSeverity(trimmed);
    if (headSev !== null) {
      currentSection = { severity: headSev };
      continue;
    }

    // 2. Detect explicit severity tags on this line (bullet or numbered list items too)
    //    Strip leading list markers: "- ", "* ", "1. ", etc.
    const stripped = trimmed.replace(/^[-*+]\s+/, '').replace(/^\d+\.\s+/, '');
    const finding = parseTaggedLine(stripped, trimmed);
    if (finding) {
      findings.push(finding);
      continue;
    }

    // 3. Inline format: "file:line — message" or "file:line: message" without a tag
    //    Only use when we're inside a severity section from a heading
    if (currentSection.severity !== null) {
      const fileRef = extractFileRef(stripped);
      if (fileRef?.file) {
        // Extract message: text after the file reference
        const afterFile = stripped.slice(
          stripped.indexOf(fileRef.file) +
            fileRef.file.length +
            (fileRef.line !== null ? String(fileRef.line).length + 1 : 0),
        );
        const message = afterFile
          .replace(/^[-–—:]\s*/, '')
          .replace(/\*\*/g, '')
          .trim();
        if (message) {
          findings.push({
            severity: currentSection.severity,
            file: fileRef.file,
            line: fileRef.line,
            message,
            raw: trimmed,
            confidence: 'medium',
          });
          continue;
        }
      }

      // Plain text line inside a severity section — treat as a finding message
      // Only if it's not a heading and looks like a finding description
      const looksLikeFinding = stripped.length > 10 && !stripped.startsWith('#') && !stripped.startsWith('```');
      if (looksLikeFinding && !stripped.startsWith('|') && !stripped.startsWith('---')) {
        const message = stripped
          .replace(/\*\*/g, '')
          .replace(/^[-–—:]\s*/, '')
          .trim();
        if (message) {
          findings.push({
            severity: currentSection.severity,
            file: '',
            line: null,
            message,
            raw: trimmed,
            confidence: 'medium',
          });
        }
      }
    }
  }

  // 4. Fallback: if no findings were found at all, parse entire text as INFO
  if (findings.length === 0 && rawText.trim().length > 0) {
    const nonEmptyLines = lines
      .map((l) => l.trim())
      .filter(
        (l) =>
          l.length > 10 && !l.startsWith('#') && !l.startsWith('```') && !l.startsWith('|') && !l.startsWith('---'),
      );

    for (const l of nonEmptyLines) {
      const message = l
        .replace(/\*\*/g, '')
        .replace(/^[-–—:*+]\s*/, '')
        .trim();
      if (message) {
        findings.push({
          severity: 'INFO',
          file: '',
          line: null,
          message,
          raw: l,
          confidence: 'medium',
        });
      }
    }
  }

  return findings;
}

/**
 * Detect how structured the raw adapter output is.
 *
 * - 'structured': has explicit [SEVERITY] tags or heading-based sections → high fidelity parse
 * - 'semi-structured': has markdown headings with severity keywords but no inline tags
 * - 'raw': free-form prose, no detectable structure
 */
export function detectParseState(rawText: string): 'structured' | 'semi-structured' | 'raw' {
  if (SEVERITY_TAG_RE.test(rawText)) return 'structured';
  if (HEADING_SEVERITY_RE.test(rawText)) return 'semi-structured';
  return 'raw';
}
