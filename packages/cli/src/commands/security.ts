import type { AttackSurfaceEntry, SecurityFinding, SecurityScope } from '@mmbridge/core';
import { StreamRenderer } from '../render/stream-renderer.js';
import {
  exitWithError,
  importAdapters,
  importCore,
  importSessionStore,
  jsonOutput,
  resolveProjectDir,
} from './helpers.js';

export interface SecurityCommandOptions {
  scope?: string;
  tool?: string;
  compliance?: string;
  bridge?: string;
  baseRef?: string;
  project?: string;
  json?: boolean;
  stream?: boolean;
}

function parseScope(raw: string | undefined): SecurityScope {
  const valid: SecurityScope[] = ['auth', 'api', 'infra', 'all'];
  const value = raw ?? 'all';
  if (!valid.includes(value as SecurityScope)) {
    exitWithError(`Invalid scope "${value}". Valid values: ${valid.join(', ')}`);
  }
  return value as SecurityScope;
}

function parseTools(raw: string | undefined): string[] {
  if (!raw || raw === 'all') return ['all'];
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

function parseCompliance(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean);
}

function formatSecurityReport(
  findings: SecurityFinding[],
  attackSurface: AttackSurfaceEntry[],
  severityCounts: Record<string, number>,
  complianceSummary: Record<string, number>,
  scope: SecurityScope,
  tools: string[],
  compliance: string[],
): void {
  process.stdout.write('=== MMBridge Security Audit ===\n');
  process.stdout.write(
    `Scope: ${scope} | Tools: ${tools.join(', ')} | Compliance: ${compliance.length > 0 ? compliance.join(', ') : 'none'}\n`,
  );
  process.stdout.write('\n');

  // Findings section
  process.stdout.write(`── Findings (${findings.length}) ──\n`);
  if (findings.length === 0) {
    process.stdout.write('No security findings.\n');
  } else {
    for (const f of findings) {
      const loc = f.line != null ? `:${f.line}` : '';
      const cweIds = f.cwe.map((c) => c.id).join(', ');
      const cweStr = cweIds ? ` (${cweIds})` : '';
      process.stdout.write(`[${f.securitySeverity}] ${f.file}${loc} — ${f.message}${cweStr}\n`);
      process.stdout.write(`  Remediation: ${f.remediation.description}\n`);
    }
  }

  process.stdout.write('\n');

  // Attack surface section
  process.stdout.write(
    `── Attack Surface (${attackSurface.length} entry point${attackSurface.length !== 1 ? 's' : ''}) ──\n`,
  );
  if (attackSurface.length === 0) {
    process.stdout.write('No entry points detected in scoped files.\n');
  } else {
    for (const entry of attackSurface) {
      const authStr = entry.authRequired ? 'auth: required' : 'auth: none';
      process.stdout.write(`• ${entry.type}: ${entry.entryPoint} (${authStr})\n`);
    }
  }

  process.stdout.write('\n');

  // Summary section
  process.stdout.write('── Summary ──\n');
  process.stdout.write(
    `P0: ${severityCounts.P0 ?? 0} | P1: ${severityCounts.P1 ?? 0} | P2: ${severityCounts.P2 ?? 0} | P3: ${severityCounts.P3 ?? 0}\n`,
  );
  if (Object.keys(complianceSummary).length > 0) {
    const complianceLine = Object.entries(complianceSummary)
      .map(([framework, count]) => `${framework}(${count})`)
      .join(' | ');
    process.stdout.write(`Compliance: ${complianceLine}\n`);
  }
}

export async function runSecurityCommand(options: SecurityCommandOptions): Promise<void> {
  const projectDir = resolveProjectDir(options.project);
  const scope = parseScope(options.scope);
  const tools = parseTools(options.tool);
  const compliance = parseCompliance(options.compliance);
  const VALID_BRIDGES = ['none', 'standard', 'interpreted'] as const;
  const bridgeRaw = options.bridge ?? 'standard';
  if (!VALID_BRIDGES.includes(bridgeRaw as (typeof VALID_BRIDGES)[number])) {
    exitWithError(`Invalid bridge "${bridgeRaw}". Valid values: ${VALID_BRIDGES.join(', ')}`);
  }
  const bridge = bridgeRaw as 'none' | 'standard' | 'interpreted';

  const { defaultRegistry, runReviewAdapter } = await importAdapters(projectDir);
  const { SessionStore } = await importSessionStore();
  const { runSecurityPipeline } = await importCore();

  // Validate all tools if specified
  if (!tools.includes('all')) {
    for (const tool of tools) {
      const adapter = defaultRegistry.get(tool);
      if (!adapter) {
        exitWithError(`Unknown tool: ${tool}. Available: ${defaultRegistry.list().join(', ')}`);
      }
    }
  }

  const sessionStore = new SessionStore();

  const saveSession = (data: Parameters<typeof sessionStore.save>[0]) =>
    sessionStore.save({
      ...data,
      recalledMemoryIds: [],
      contextDigest: null,
    });

  if (options.stream) {
    const renderer = new StreamRenderer(tools.join(','), 'security-audit');
    const startedAt = Date.now();
    renderer.start();

    try {
      const result = await runSecurityPipeline({
        scope,
        tools,
        projectDir,
        baseRef: options.baseRef,
        compliance,
        bridge,
        runAdapter: runReviewAdapter,
        listInstalledTools: () => defaultRegistry.listInstalled(),
        saveSession,
        onProgress: (phase, detail) => renderer.phase(phase, detail),
        onStdout: (_tool, chunk) => {
          for (const line of chunk.split('\n')) {
            renderer.streamLine(line);
          }
        },
      });

      const elapsedMs = Date.now() - startedAt;
      const elapsed = elapsedMs < 1000 ? `${elapsedMs}ms` : `${(elapsedMs / 1000).toFixed(1)}s`;

      renderer.printFindings(result.report.findings);
      renderer.printSummary(result.report.findings, elapsed);
      renderer.done(result.sessionId);

      if (options.json) {
        jsonOutput(result.report);
        return;
      }
      // Don't call formatSecurityReport in streaming mode — renderer already output everything
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[mmbridge] Security audit failed: ${message}\n`);
      process.exitCode = 1;
    } finally {
      renderer.cleanup();
    }

    return;
  }

  // Non-streaming mode
  try {
    const result = await runSecurityPipeline({
      scope,
      tools,
      projectDir,
      baseRef: options.baseRef,
      compliance,
      bridge,
      runAdapter: runReviewAdapter,
      listInstalledTools: () => defaultRegistry.listInstalled(),
      saveSession,
    });

    if (options.json) {
      jsonOutput(result.report);
      return;
    }

    formatSecurityReport(
      result.report.findings,
      result.report.attackSurface,
      result.report.severityCounts,
      result.report.complianceSummary,
      scope,
      tools,
      compliance,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[mmbridge] Security audit failed: ${message}\n`);
    process.exitCode = 1;
  }
}
