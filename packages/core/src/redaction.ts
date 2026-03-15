import fs from 'node:fs/promises';
import path from 'node:path';
import type { RedactContentResult, RedactionResult } from './types.js';

export interface RedactionRuleSpec {
  pattern: string;
  replacement: string;
  label: string;
}

const REDACTION_RULES: Array<{ pattern: RegExp; replacement: string; label: string }> = [
  { pattern: /sk-[A-Za-z0-9_-]{20,}/g, replacement: '[REDACTED_API_KEY]', label: 'OpenAI API key' },
  { pattern: /AIza[A-Za-z0-9_-]{35}/g, replacement: '[REDACTED_GCP_KEY]', label: 'GCP API key' },
  { pattern: /ghp_[A-Za-z0-9]{36}/g, replacement: '[REDACTED_GH_TOKEN]', label: 'GitHub PAT' },
  { pattern: /ghs_[A-Za-z0-9]{36}/g, replacement: '[REDACTED_GH_TOKEN]', label: 'GitHub app token' },
  { pattern: /polar_at_[A-Za-z0-9_-]{20,}/g, replacement: '[REDACTED_POLAR_TOKEN]', label: 'Polar access token' },
  { pattern: /whsk_[A-Za-z0-9_-]{20,}/g, replacement: '[REDACTED_WEBHOOK_SECRET]', label: 'Webhook secret' },
  {
    pattern: /(?:password|passwd|pwd)\s*[:=]\s*["']?([^\s"']{8,})["']?/gi,
    replacement: '[REDACTED_PASSWORD]',
    label: 'Password value',
  },
  {
    pattern: /(?:secret|token|key)\s*[:=]\s*["']([A-Za-z0-9_\-./+]{16,})["']/gi,
    replacement: '[REDACTED_SECRET]',
    label: 'Generic secret/token',
  },
  { pattern: /Bearer\s+[A-Za-z0-9_\-.~+/]{20,}/g, replacement: 'Bearer [REDACTED_TOKEN]', label: 'Bearer token' },
];

function buildRules(
  extraRules: RedactionRuleSpec[] = [],
): Array<{ pattern: RegExp; replacement: string; label: string }> {
  const compiled = [...REDACTION_RULES];
  for (const rule of extraRules) {
    try {
      compiled.push({
        pattern: new RegExp(rule.pattern, 'g'),
        replacement: rule.replacement,
        label: rule.label,
      });
    } catch {
      // Ignore invalid user-provided regexes during runtime redaction.
    }
  }
  return compiled;
}

export function redactContent(content: string, extraRules: RedactionRuleSpec[] = []): RedactContentResult {
  const stats: string[] = [];
  let redacted = content;

  for (const rule of buildRules(extraRules)) {
    const before = redacted;
    redacted = redacted.replace(rule.pattern, rule.replacement);
    if (redacted !== before) {
      stats.push(rule.label);
    }
  }

  return { redacted, stats };
}

export async function redactFile(filePath: string, extraRules: RedactionRuleSpec[] = []): Promise<RedactionResult> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch {
    return { changedFiles: 0, usedRuleCount: 0 };
  }

  const { redacted, stats } = redactContent(content, extraRules);
  if (redacted === content) {
    return { changedFiles: 0, usedRuleCount: 0 };
  }

  await fs.writeFile(filePath, redacted, 'utf8');
  return { changedFiles: 1, usedRuleCount: stats.length };
}

export async function redactWorkspace(
  workspaceDir: string,
  extraRules: RedactionRuleSpec[] = [],
): Promise<RedactionResult> {
  let totalChanged = 0;
  let totalRules = 0;

  async function walk(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const result = await redactFile(full, extraRules);
        totalChanged += result.changedFiles;
        totalRules += result.usedRuleCount;
      }
    }
  }

  await walk(workspaceDir);
  return { changedFiles: totalChanged, usedRuleCount: totalRules };
}
