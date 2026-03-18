import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runBridge } from './bridge.js';
import { cleanupContext, createContext } from './context.js';
import { parseFindings } from './finding-parser.js';
import { interpretFindings } from './interpret.js';
import { orchestrateReview } from './orchestrate.js';
import { enrichFindings } from './report.js';
import type { ReviewPipelineOptions } from './review-pipeline.js';
import { buildAttackSurface, classifyFindings } from './security-cwe.js';
import { buildContextIndex, buildResultIndex } from './session-index.js';
import type { Finding, InterpretResult, SecurityFinding, SecurityReport, SecurityScope } from './types.js';
import { ensureDir, nowIso } from './utils.js';

// ─── Adapter security affinity ───────────────────────────────────────────────

const ADAPTER_SECURITY_AFFINITY: Record<string, string> = {
  kimi: 'Focus on data flow analysis and subtle logic vulnerabilities',
  qwen: 'Focus on OWASP Top 10, injection patterns, and standards compliance',
  codex: 'Focus on implementation bugs, race conditions, and data validation',
  gemini: 'Focus on authentication/authorization flows and cryptographic issues',
  droid: 'Focus on mobile-specific vulnerabilities and platform security',
  claude: 'Focus on business logic flaws and complex attack chains',
};

// ─── Scope filtering ─────────────────────────────────────────────────────────

const SCOPE_PATTERNS: Record<SecurityScope, RegExp[]> = {
  auth: [/auth/i, /login/i, /session/i, /token/i, /password/i, /credential/i, /oauth/i, /jwt/i],
  api: [/route/i, /handler/i, /endpoint/i, /api\//i, /controller/i, /middleware/i],
  infra: [/docker/i, /\.env/i, /config/i, /ci/i, /deploy/i, /terraform/i, /helm/i],
  all: [/.*/],
};

function filterFilesByScope(changedFiles: string[], scope: SecurityScope): string[] {
  if (scope === 'all') return changedFiles;

  const patterns = SCOPE_PATTERNS[scope];
  return changedFiles.filter((filePath) => patterns.some((pattern) => pattern.test(filePath)));
}

// ─── Security prompt builder ─────────────────────────────────────────────────

function buildSecurityPrompt(tool: string, scope: SecurityScope, scopedFiles: string[], compliance?: string[]): string {
  const affinity = ADAPTER_SECURITY_AFFINITY[tool] ?? 'Focus on general security vulnerabilities';
  const fileList = scopedFiles
    .slice(0, 30)
    .map((f) => `- ${f}`)
    .join('\n');
  const truncNote = scopedFiles.length > 30 ? `\n- *(${scopedFiles.length} files total — showing first 30)*` : '';

  const parts: string[] = [
    `# MMBridge Security Audit: ${tool}`,
    '',
    `## Scope: ${scope}`,
    '',
    `## Adapter Focus: ${affinity}`,
    '',
    'Perform a comprehensive security audit of the codebase.',
    'Focus on: OWASP Top 10, CWE classifications, authentication/authorization flaws,',
    'injection vulnerabilities, data exposure, cryptographic weaknesses, and supply chain risks.',
    'Classify each finding with severity (P0-P3), exploitability, and specific CWE IDs.',
    'Provide actionable remediation for each finding with code snippets where possible.',
    'Map the attack surface: entry points, data flows, and trust boundaries.',
  ];

  if (compliance && compliance.length > 0) {
    parts.push('', '## Compliance Requirements', '', compliance.join(', '));
  }

  parts.push(
    '',
    '## Output Format',
    '',
    'For each finding, output a structured block:',
    '```',
    '**[P0]** file:line — vulnerability description',
    'CWE: CWE-XXX (name)',
    'Exploitability: immediate|with-effort|theoretical|best-practice',
    'Remediation: description',
    '```',
    'Where P-level maps to: P0=CRITICAL, P1=WARNING, P2=INFO, P3=REFACTOR',
    '',
    '## Scoped Files',
    '',
    fileList + truncNote,
    '',
    '## Instructions',
    '',
    '- Audit ONLY the scoped files listed above.',
    '- Reference the diff.patch and context.md in the workspace for full context.',
    '- Do not report issues in unscoped files.',
    '- Be specific — include file paths and line numbers.',
    '- Map each finding to a CWE ID from the CWE database.',
  );

  return parts.join('\n');
}

// ─── Public interfaces ────────────────────────────────────────────────────────

export interface SecurityPipelineOptions {
  scope: SecurityScope;
  tools: string[];
  projectDir: string;
  baseRef?: string;
  compliance?: string[];
  bridge?: 'none' | 'standard' | 'interpreted';
  bridgeProfile?: 'standard' | 'strict' | 'relaxed';
  onProgress?: (phase: string, detail: string) => void;
  onStdout?: (tool: string, chunk: string) => void;
  runAdapter: ReviewPipelineOptions['runAdapter'];
  listInstalledTools?: () => Promise<string[]>;
  saveSession?: ReviewPipelineOptions['saveSession'];
}

export interface SecurityPipelineResult {
  runId: string;
  sessionId: string;
  report: SecurityReport;
  toolContributions: Record<string, { findingCount: number; rawText: string }>;
}

// ─── Pipeline ─────────────────────────────────────────────────────────────────

export async function runSecurityPipeline(options: SecurityPipelineOptions): Promise<SecurityPipelineResult> {
  const { scope, tools, projectDir, onProgress, onStdout } = options;
  const runId = randomUUID();
  const mode = 'security-audit';
  const bridge = options.bridge ?? 'standard';
  const bridgeProfile = options.bridgeProfile ?? 'standard';
  const compliance = options.compliance ?? [];

  // Phase 1: Create context
  onProgress?.('context', 'Building security audit context...');
  const ctx = await createContext({ projectDir, mode, baseRef: options.baseRef });

  try {
    const contextIndex = buildContextIndex({
      workspace: ctx.workspace,
      projectDir,
      mode,
      baseRef: ctx.baseRef,
      diffDigest: ctx.diffDigest,
      head: ctx.head,
      changedFiles: ctx.changedFiles,
      copiedFileCount: ctx.copiedFileCount,
      redaction: ctx.redaction,
    });

    // Phase 2: Filter files by scope
    onProgress?.('scan', `Filtering files by scope: ${scope}...`);
    const scopedFiles = filterFilesByScope(ctx.changedFiles, scope);

    if (scopedFiles.length === 0) {
      onProgress?.('report', 'No files in scope for security audit.');
      const emptyReport: SecurityReport = {
        profile: bridgeProfile,
        scope,
        totalInputs: 0,
        findings: [],
        attackSurface: [],
        summary: `No changed files matched scope "${scope}".`,
        severityCounts: { P0: 0, P1: 0, P2: 0, P3: 0 },
        complianceSummary: {},
      };
      const resultIndex = buildResultIndex({
        summary: emptyReport.summary,
        findings: [],
        parseState: 'empty',
      });
      const session = options.saveSession
        ? await options.saveSession({
            tool: 'bridge',
            mode,
            projectDir,
            workspace: ctx.workspace,
            runId,
            summary: emptyReport.summary,
            findings: [],
            contextIndex,
            resultIndex,
            status: 'complete',
            diffDigest: ctx.diffDigest,
          })
        : { id: 'unsaved' };
      return {
        runId,
        sessionId: session.id,
        report: emptyReport,
        toolContributions: {},
      };
    }

    // Phase 3: Write security-specific prompt files per adapter
    onProgress?.('scan', 'Writing security prompt files...');
    const promptDir = path.join(ctx.workspace, 'prompt');
    await ensureDir(promptDir);

    const resolvedTools = tools[0] === 'all' && options.listInstalledTools ? await options.listInstalledTools() : tools;

    await Promise.all(
      resolvedTools.map(async (tool) => {
        const promptContent = buildSecurityPrompt(tool, scope, scopedFiles, compliance);
        const promptPath = path.join(promptDir, `${tool}.md`);
        await fs.writeFile(promptPath, promptContent, 'utf8');
      }),
    );

    // Phase 4: Orchestrate security reviews in parallel
    onProgress?.('scan', `Running ${resolvedTools.length} tool(s) in parallel...`);
    const orchResult = await orchestrateReview({
      tools: resolvedTools,
      workspace: ctx.workspace,
      mode,
      baseRef: ctx.baseRef,
      changedFiles: scopedFiles,
      runAdapter: (tool, opts) => options.runAdapter(tool, opts),
      onStdout,
      onToolProgress: async (tool, status) => {
        onProgress?.('scan', `${tool}: ${status}`);
      },
    });

    const toolContributions: Record<string, { findingCount: number; rawText: string }> = {};
    for (const result of orchResult.results) {
      toolContributions[result.tool] = {
        findingCount: result.findings.length,
        rawText: result.summary,
      };
    }

    // Phase 5: Bridge consensus (if enabled)
    let mergedFindings: Finding[] = [];
    let bridgeSummary: string | null = null;

    if (bridge !== 'none' && resolvedTools.length > 1) {
      onProgress?.('bridge', 'Running bridge consensus for security findings...');
      const bridgeResult = await runBridge({
        profile: bridgeProfile,
        interpret: false,
        workspace: ctx.workspace,
        changedFiles: scopedFiles,
        results: orchResult.results.map((r) => ({
          tool: r.tool,
          findings: r.findings,
          summary: r.summary,
          skipped: r.skipped,
        })),
      });
      mergedFindings = bridgeResult.findings;
      bridgeSummary = bridgeResult.summary;
    } else {
      // Single tool: collect all findings
      const allFindings: Finding[] = [];
      for (const result of orchResult.results) {
        if (!result.skipped) {
          allFindings.push(...result.findings);
        }
      }
      const enriched = enrichFindings(allFindings, scopedFiles);
      mergedFindings = enriched.findings;
    }

    // Phase 6: Classify findings (CWE mapping)
    onProgress?.('classify', 'Classifying findings against CWE database...');
    const securityFindings: SecurityFinding[] = classifyFindings(mergedFindings, scope, compliance);

    // Phase 7: Build attack surface
    onProgress?.('surface', 'Building attack surface map...');
    const attackSurface = buildAttackSurface(scopedFiles, securityFindings);

    // Phase 8: Optional interpretation
    let interpretation: InterpretResult | null = null;
    if (bridge === 'interpreted' && securityFindings.length > 0) {
      onProgress?.('interpret', 'Validating security findings...');
      try {
        interpretation = await interpretFindings({
          mergedFindings: securityFindings,
          changedFiles: scopedFiles,
          projectContext: '',
          workspace: ctx.workspace,
        });
      } catch {
        // Interpretation failure is non-critical
      }
    }

    // Phase 9: Build report
    onProgress?.('report', 'Building security report...');
    const severityCounts: SecurityReport['severityCounts'] = { P0: 0, P1: 0, P2: 0, P3: 0 };
    for (const f of securityFindings) {
      severityCounts[f.securitySeverity] = (severityCounts[f.securitySeverity] ?? 0) + 1;
    }

    const complianceSummary: Record<string, number> = {};
    if (compliance.length > 0) {
      for (const framework of compliance) {
        complianceSummary[framework] = securityFindings.filter((f) => {
          const tags = f.complianceTags;
          if (!tags) return false;
          return tags.some((tag) => tag === framework);
        }).length;
      }
    }

    const summary = [
      `Security audit (${scope}): ${securityFindings.length} finding(s)`,
      severityCounts.P0 > 0 ? `${severityCounts.P0} P0` : '',
      severityCounts.P1 > 0 ? `${severityCounts.P1} P1` : '',
      severityCounts.P2 > 0 ? `${severityCounts.P2} P2` : '',
      severityCounts.P3 > 0 ? `${severityCounts.P3} P3` : '',
      attackSurface.length > 0 ? `${attackSurface.length} entry point(s)` : '',
    ]
      .filter(Boolean)
      .join(', ');

    const report: SecurityReport = {
      profile: bridgeProfile,
      scope,
      totalInputs: orchResult.results.filter((r) => !r.skipped).length,
      findings: securityFindings,
      attackSurface,
      summary,
      severityCounts,
      complianceSummary,
      interpretation: interpretation ?? undefined,
    };

    // Phase 10: Save session
    const resultIndex = buildResultIndex({
      summary,
      findings: securityFindings,
      bridgeSummary: bridgeSummary ?? undefined,
      parseState: 'structured',
    });

    const session = options.saveSession
      ? await options.saveSession({
          tool: resolvedTools.length > 1 ? 'bridge' : (resolvedTools[0] ?? 'unknown'),
          mode,
          projectDir,
          workspace: ctx.workspace,
          runId,
          summary,
          findings: securityFindings,
          contextIndex,
          resultIndex,
          toolResults: orchResult.results.map((r) => ({
            tool: r.tool,
            findingCount: r.findings.length,
            skipped: r.skipped,
            error: r.error,
          })),
          interpretation,
          status: 'complete',
          diffDigest: ctx.diffDigest,
        })
      : { id: 'unsaved' };

    return {
      runId,
      sessionId: session.id,
      report,
      toolContributions,
    };
  } finally {
    await cleanupContext(ctx.workspace).catch(() => {});
  }
}
