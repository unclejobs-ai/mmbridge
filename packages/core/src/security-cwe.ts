import { CWE_DATABASE } from './security-cwe-data.js';
import type { AttackSurfaceEntry, Finding, SecurityFinding, SecurityScope, SecuritySeverity } from './types.js';

export type { CweEntry } from './security-cwe-data.js';
export { CWE_DATABASE } from './security-cwe-data.js';

// ─── Classification Engine ────────────────────────────────────────────────────

function matchCweEntries(message: string): (typeof CWE_DATABASE)[number][] {
  const lowerMessage = message.toLowerCase();
  const matched: (typeof CWE_DATABASE)[number][] = [];
  const seenIds = new Set<string>();

  for (const entry of CWE_DATABASE) {
    if (seenIds.has(entry.id)) continue;
    const keywordMatch = entry.keywords.some((kw) => lowerMessage.includes(kw.toLowerCase()));
    if (keywordMatch) {
      matched.push(entry);
      seenIds.add(entry.id);
    }
  }

  return matched;
}

function severityFromFinding(finding: Finding, cweEntries: (typeof CWE_DATABASE)[number][]): SecuritySeverity {
  const cweDefaultSeverity = cweEntries.reduce<SecuritySeverity | null>((best, entry) => {
    const order: SecuritySeverity[] = ['P0', 'P1', 'P2', 'P3'];
    if (best === null) return entry.severity;
    return order.indexOf(entry.severity) < order.indexOf(best) ? entry.severity : best;
  }, null);

  const findingSeverityMap: Record<string, SecuritySeverity> = {
    CRITICAL: 'P0',
    WARNING: 'P1',
    INFO: 'P2',
    REFACTOR: 'P3',
  };

  const findingPLevel = findingSeverityMap[finding.severity] ?? 'P2';
  const cwePLevel = cweDefaultSeverity ?? 'P2';

  const order: SecuritySeverity[] = ['P0', 'P1', 'P2', 'P3'];
  return order[Math.min(order.indexOf(findingPLevel), order.indexOf(cwePLevel))] ?? 'P2';
}

function exploitabilityFromSeverity(severity: SecuritySeverity, message: string): SecurityFinding['exploitability'] {
  const lower = message.toLowerCase();
  if (lower.includes('theoretical') || lower.includes('hypothetical')) return 'theoretical';
  if (lower.includes('best practice') || lower.includes('recommendation') || severity === 'P3') {
    return 'best-practice';
  }
  if (severity === 'P0') return 'immediate';
  if (severity === 'P1') return 'with-effort';
  if (severity === 'P2') return 'theoretical';
  return 'best-practice';
}

function effortFromSeverity(severity: SecuritySeverity): 'low' | 'medium' | 'high' {
  if (severity === 'P0' || severity === 'P1') return 'low';
  if (severity === 'P2') return 'medium';
  return 'high';
}

type ComplianceTag = 'GDPR' | 'HIPAA' | 'SOC2' | 'PCI-DSS';

const COMPLIANCE_CWE_MAP: Record<ComplianceTag, string[]> = {
  GDPR: ['CWE-200', 'CWE-312', 'CWE-319', 'CWE-311', 'CWE-613', 'CWE-352'],
  HIPAA: ['CWE-200', 'CWE-312', 'CWE-319', 'CWE-311', 'CWE-287', 'CWE-862'],
  SOC2: ['CWE-287', 'CWE-306', 'CWE-862', 'CWE-200', 'CWE-400', 'CWE-312'],
  'PCI-DSS': ['CWE-89', 'CWE-78', 'CWE-312', 'CWE-319', 'CWE-327', 'CWE-798', 'CWE-352'],
};

function deriveComplianceTags(cweEntries: (typeof CWE_DATABASE)[number][], compliance?: string[]): ComplianceTag[] {
  if (!compliance || compliance.length === 0) return [];

  const cweIds = new Set(cweEntries.map((e) => e.id));
  const tags: ComplianceTag[] = [];

  for (const framework of compliance) {
    const tag = framework as ComplianceTag;
    const mappedCwes = COMPLIANCE_CWE_MAP[tag];
    if (mappedCwes?.some((id) => cweIds.has(id))) {
      tags.push(tag);
    }
  }

  return tags;
}

export function classifyFindings(findings: Finding[], scope: SecurityScope, compliance?: string[]): SecurityFinding[] {
  return findings.map((finding): SecurityFinding => {
    const matched = matchCweEntries(finding.message);
    const securitySeverity = severityFromFinding(finding, matched);
    const exploitability = exploitabilityFromSeverity(securitySeverity, finding.message);
    const complianceTags = deriveComplianceTags(matched, compliance);
    const primaryCwe = matched[0];

    return {
      ...finding,
      securitySeverity,
      cwe: matched.map((e) => ({ id: e.id, name: e.name, owaspCategory: e.owaspCategory })),
      exploitability,
      remediation: {
        description:
          primaryCwe?.remediation ?? 'Review and remediate this security finding following security best practices.',
        effort: effortFromSeverity(securitySeverity),
      },
      complianceTags: complianceTags.length > 0 ? complianceTags : undefined,
      scope,
    };
  });
}

// ─── Attack Surface Builder ───────────────────────────────────────────────────

type EntryPointType = AttackSurfaceEntry['type'];

interface EntryPointPattern {
  pattern: RegExp;
  type: EntryPointType;
  trustBoundary: string;
}

const ENTRY_POINT_PATTERNS: EntryPointPattern[] = [
  { pattern: /(?:^|\/)(?:api|routes?|pages\/api)\//i, type: 'api-route', trustBoundary: 'external' },
  { pattern: /webhook/i, type: 'webhook', trustBoundary: 'external' },
  { pattern: /(?:upload|multer|formidable|busboy)/i, type: 'file-upload', trustBoundary: 'external' },
  { pattern: /(?:ws:\/\/|websocket|socket\.io)/i, type: 'websocket', trustBoundary: 'external' },
  { pattern: /(?:cron|schedule|agenda|node-schedule)/i, type: 'cron', trustBoundary: 'internal' },
  { pattern: /(?:\.env|config\.(?:ts|js|json)|settings\.(?:ts|js))/i, type: 'config', trustBoundary: 'internal' },
  { pattern: /(?:<form|input|textarea|handlesubmit|onsubmit)/i, type: 'form-input', trustBoundary: 'user' },
];

function detectEntryPointPattern(filePath: string): EntryPointPattern | null {
  for (const p of ENTRY_POINT_PATTERNS) {
    if (p.pattern.test(filePath)) return p;
  }
  return null;
}

function isRelatedPath(findingFile: string, targetPath: string): boolean {
  return (
    findingFile === targetPath || findingFile.startsWith(`${targetPath}/`) || targetPath.startsWith(`${findingFile}/`)
  );
}

function detectAuthRequired(filePath: string, findings: SecurityFinding[]): boolean {
  const noAuthPatterns = [/no.auth/i, /unauthenticated/i, /public endpoint/i, /missing auth/i, /no authentication/i];
  const noAuthEntryTypes: EntryPointType[] = ['config', 'cron'];

  const relevantFindings = findings.filter((f) => isRelatedPath(f.file, filePath));
  for (const finding of relevantFindings) {
    if (noAuthPatterns.some((p) => p.test(finding.message))) return false;
  }

  const pattern = detectEntryPointPattern(filePath);
  return !(pattern && noAuthEntryTypes.includes(pattern.type));
}

function extractDataFlows(findings: SecurityFinding[], filePath: string): string[] {
  const flows: string[] = [];
  const seen = new Set<string>();

  for (const finding of findings) {
    if (!isRelatedPath(finding.file, filePath)) continue;
    if (finding.dataFlow && !seen.has(finding.dataFlow)) {
      flows.push(finding.dataFlow);
      seen.add(finding.dataFlow);
    }
    for (const cwe of finding.cwe) {
      if (cwe.id === 'CWE-312' && !seen.has('sensitive-data-storage')) {
        flows.push('sensitive-data-storage');
        seen.add('sensitive-data-storage');
      }
      if (cwe.id === 'CWE-319' && !seen.has('unencrypted-transmission')) {
        flows.push('unencrypted-transmission');
        seen.add('unencrypted-transmission');
      }
      if ((cwe.id === 'CWE-89' || cwe.id === 'CWE-78') && !seen.has('user-input-to-system')) {
        flows.push('user-input-to-system');
        seen.add('user-input-to-system');
      }
    }
  }

  return flows;
}

export function buildAttackSurface(changedFiles: string[], findings: SecurityFinding[]): AttackSurfaceEntry[] {
  const entries: AttackSurfaceEntry[] = [];
  const seenEntryPoints = new Set<string>();

  for (const filePath of changedFiles) {
    const pattern = detectEntryPointPattern(filePath);
    if (!pattern || seenEntryPoints.has(filePath)) continue;
    seenEntryPoints.add(filePath);

    entries.push({
      entryPoint: filePath,
      type: pattern.type,
      authRequired: detectAuthRequired(filePath, findings),
      dataFlows: extractDataFlows(findings, filePath),
      trustBoundary: pattern.trustBoundary,
    });
  }

  return entries;
}
