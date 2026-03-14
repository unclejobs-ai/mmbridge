import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { Command } from 'commander';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ReviewCommandOptions {
  tool?: string;
  mode?: string;
  bridge?: string;
  baseRef?: string;
  commit?: string;
  project?: string;
  json?: boolean;
}

export interface FollowupCommandOptions {
  tool: string;
  prompt: string;
  json?: boolean;
  explicitSessionId?: string;
  projectDir?: string;
  useLatestWhenMissing?: boolean;
}

export interface SyncAgentsOptions {
  dryRun?: boolean;
  verbose?: boolean;
}

export interface DashboardOptions {
  mode?: string;
  project?: string;
  json?: boolean;
}

export interface DoctorOptions {
  json?: boolean;
  setup?: boolean;
}

// ─── Lazy dependency loaders ──────────────────────────────────────────────────
// Each dependency is loaded lazily so that `mmbridge --help` remains fast
// and doesn't fail if optional peer packages are absent.

const importCore = () => import('@mmbridge/core');
const importAdapters = () => import('@mmbridge/adapters');
const importSessionStore = () => import('@mmbridge/session-store');
const importTui = () => import('@mmbridge/tui');
const importIntegrations = () => import('@mmbridge/integrations');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveProjectDir(option: string | undefined): string {
  return option ? path.resolve(option) : process.cwd();
}

function jsonOutput(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

function exitWithError(message: string, code = 1): never {
  process.stderr.write(`[mmbridge] ${message}\n`);
  // process.exit returns never once @types/node is installed;
  // the throw below satisfies TypeScript until then.
  process.exit(code);
  throw new Error('unreachable');
}

// ─── Command: review ──────────────────────────────────────────────────────────

async function runReviewCommand(options: ReviewCommandOptions): Promise<void> {
  const projectDir = resolveProjectDir(options.project);
  const mode = options.mode ?? 'review';

  const {
    buildContextIndex,
    buildProjectContext,
    buildResultIndex,
    commandExists,
    createContext,
    enrichFindings,
    runBridge,
  } = await importCore();

  const { defaultRegistry, runReviewAdapter } = await importAdapters();
  const { SessionStore } = await importSessionStore();
  const { renderReviewConsole } = await importTui();

  const tool = options.tool ?? 'kimi';
  const adapter = defaultRegistry.get(tool);
  if (!adapter) {
    exitWithError(`Unknown tool: ${tool}. Available: ${defaultRegistry.list().join(', ')}`);
  }
  const isInstalled = await commandExists(adapter.binary);
  if (!isInstalled) {
    exitWithError(
      `Binary "${adapter.binary}" not found in PATH. Install it to use the "${tool}" adapter.`,
    );
  }

  const workspace = await createContext({
    projectDir,
    mode,
    baseRef: options.baseRef,
    commit: options.commit,
  });

  const contextIndex = buildContextIndex({
    workspace: workspace.workspace,
    projectDir: workspace.projectDir,
    mode: workspace.mode,
    baseRef: workspace.baseRef,
    head: workspace.head,
    changedFiles: workspace.changedFiles,
    copiedFileCount: workspace.copiedFileCount,
    redaction: workspace.redaction,
  });

  const adapterResult = await runReviewAdapter(tool, {
    workspace: workspace.workspace,
    cwd: projectDir,
    mode,
    baseRef: options.baseRef,
    commit: options.commit,
    changedFiles: workspace.changedFiles,
    sessionId: workspace.workspace,
  });

  // enrichFindings operates on parsed Finding[], adapter returns raw text.
  // For now, treat adapter text as summary; finding parsing is a future enhancement.
  const enriched = enrichFindings([], workspace.changedFiles);

  const resultIndex = buildResultIndex({
    summary: adapterResult.text,
    findings: enriched.findings,
    filteredCount: enriched.filteredCount,
    promotedCount: enriched.promotedCount,
    followupSupported: adapterResult.followupSupported,
    rawOutput: adapterResult.text,
    parseState: 'raw',
  });

  const sessionStore = new SessionStore(projectDir);
  const savedSession = await sessionStore.save({
    tool,
    mode,
    projectDir,
    workspace: workspace.workspace,
    externalSessionId: adapterResult.externalSessionId,
    batchId: null,
    summary: adapterResult.text,
    findings: enriched.findings as unknown as Array<Record<string, unknown>>,
    contextIndex: contextIndex as unknown as Record<string, unknown>,
    resultIndex: resultIndex as unknown as Record<string, unknown>,
  });

  // Bridge aggregation when requested
  if (options.bridge) {
    const projectContext = await buildProjectContext({ projectDir });
    runBridge({
      profile: options.bridge,
      projectContext,
      results: [
        {
          tool,
          findings: enriched.findings,
          summary: adapterResult.text,
        },
      ],
    });
  }

  const report = {
    localSessionId: savedSession.id,
    externalSessionId: adapterResult.externalSessionId ?? undefined,
    workspace: workspace.workspace,
    summary: adapterResult.text,
    findings: enriched.findings,
    resultIndex,
    changedFiles: workspace.copiedFileCount,
    copiedFiles: workspace.copiedFileCount,
    followupSupported: adapterResult.followupSupported,
  };

  if (options.json) {
    jsonOutput(report);
    return;
  }

  await renderReviewConsole(report as unknown as Parameters<typeof renderReviewConsole>[0]);
}

// ─── Command: followup ────────────────────────────────────────────────────────

async function runFollowupCommand(options: FollowupCommandOptions): Promise<void> {
  const projectDir = resolveProjectDir(options.projectDir);

  const { SessionStore } = await importSessionStore();
  const { runFollowupAdapter } = await importAdapters();
  const { renderReviewConsole } = await importTui();

  const sessionStore = new SessionStore(projectDir);

  let sessionId = options.explicitSessionId;
  if (!sessionId) {
    if (options.useLatestWhenMissing) {
      const sessions = await sessionStore.list({ tool: options.tool });
      const latest = sessions[0] ?? null;
      if (!latest?.externalSessionId) {
        exitWithError(
          `No external session ID found for tool "${options.tool}". Run a review first.`,
        );
      }
      sessionId = latest.externalSessionId;
    } else {
      exitWithError('Session ID is required. Pass --session or run with --latest flag.');
    }
  }

  const result = await runFollowupAdapter(options.tool, {
    workspace: projectDir,
    cwd: projectDir,
    sessionId,
    prompt: options.prompt,
  });

  const report = {
    externalSessionId: result.externalSessionId ?? undefined,
    summary: result.text,
    findings: [],
    followupSupported: result.followupSupported,
  };

  if (options.json) {
    jsonOutput(report);
    return;
  }

  await renderReviewConsole(report);
}

// ─── Command: dashboard ───────────────────────────────────────────────────────

async function runDashboardCommand(options: DashboardOptions): Promise<void> {
  const projectDir = resolveProjectDir(options.project);

  const { commandExists } = await importCore();
  const { defaultRegistry } = await importAdapters();
  const { SessionStore } = await importSessionStore();
  const { renderDashboard } = await importTui();

  const sessionStore = new SessionStore(projectDir);
  const sessions = await sessionStore.list({ projectDir });

  const toolNames = defaultRegistry.list();
  const models = await Promise.all(
    toolNames.map(async (tool) => {
      const binary = defaultRegistry.get(tool)?.binary ?? tool;
      const installed = await commandExists(binary);
      const toolSessions = sessions.filter((s: { tool: string }) => s.tool === tool);
      const latest = toolSessions[0] ?? null;
      return {
        tool,
        binary,
        installed,
        totalSessions: toolSessions.length,
        latestMode: latest?.mode ?? null,
        latestCreatedAt: latest?.createdAt ?? null,
        latestSummary: latest?.summary ?? null,
        latestExternalSessionId: latest?.externalSessionId ?? null,
        latestResultIndex: latest?.resultIndex ?? null,
        latestContextIndex: latest?.contextIndex ?? null,
        latestBatchId: latest?.batchId ?? null,
        latestFollowupSupported: latest?.resultIndex
          ? Boolean((latest.resultIndex as Record<string, unknown>).followupSupported)
          : undefined,
        aggregateStats: null,
      };
    }),
  );

  const payload = {
    sessions,
    models,
    modeFilter: options.mode ?? 'all',
    projectDir,
    ui: options.json ? 'json' : undefined,
  };

  await renderDashboard(payload);
}

// ─── Command: doctor ──────────────────────────────────────────────────────────

async function runDoctorCommand(options: DoctorOptions): Promise<void> {
  const { commandExists } = await importCore();
  const { defaultRegistry } = await importAdapters();
  const { renderDoctor, renderSetupWizard } = await importTui();

  const adapterBinaries = defaultRegistry.list().map((t) => defaultRegistry.get(t)!.binary);
  const binaries = [...new Set([...adapterBinaries, 'claude'])];
  const checks = await Promise.all(
    binaries.map(async (binary) => ({
      binary,
      installed: await commandExists(binary),
    })),
  );

  const home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
  const mmbridgeHome = path.join(home, '.mmbridge');
  const claudeAgentsDir = path.join(home, '.claude', 'agents');
  const runtimeAuthModel = process.env.MMBRIDGE_AUTH_MODEL ?? 'claude-sonnet-4-5';

  // Gather session file hints
  const sessionFileHints: Record<string, string> = {};
  for (const tool of ['kimi', 'qwen', 'codex', 'gemini']) {
    const hint = path.join(mmbridgeHome, 'sessions', `${tool}.jsonl`);
    try {
      await fs.access(hint);
      sessionFileHints[tool] = hint;
    } catch {
      sessionFileHints[tool] = `${hint} (not found)`;
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    checks,
    mmbridgeHome,
    claudeAgentsDir,
    runtimeAuthModel,
    sessionFileHints,
  };

  if (options.json) {
    jsonOutput(report);
    return;
  }

  if (options.setup) {
    await renderSetupWizard(report);
  } else {
    await renderDoctor(report);
  }
}

// ─── Command: sync-agents ─────────────────────────────────────────────────────

async function runSyncAgentsCommand(options: SyncAgentsOptions): Promise<void> {
  const { syncClaudeAgents } = await importIntegrations();
  await syncClaudeAgents({ dryRun: options.dryRun ?? false });
}

// ─── CLI entry ────────────────────────────────────────────────────────────────

export async function main(): Promise<void> {
  const program = new Command();

  program
    .name('mmbridge')
    .description('Multi-model code review bridge')
    .version('0.1.0');

  // ── review ──
  program
    .command('review')
    .description('Run a code review with the specified AI tool')
    .option('-t, --tool <tool>', 'AI tool to use (kimi|qwen|codex|gemini)', 'kimi')
    .option('-m, --mode <mode>', 'Review mode (review|security|architecture)', 'review')
    .option('--bridge <profile>', 'Bridge aggregation profile')
    .option('--base-ref <ref>', 'Git base ref for diff (default: HEAD~1)')
    .option('--commit <sha>', 'Specific commit to review')
    .option('-p, --project <dir>', 'Project directory (default: cwd)')
    .option('--json', 'Output JSON instead of TUI')
    .action(async (opts: ReviewCommandOptions) => {
      await runReviewCommand(opts);
    });

  // ── followup ──
  program
    .command('followup')
    .description('Send a follow-up prompt to an existing review session')
    .requiredOption('-t, --tool <tool>', 'AI tool that ran the original review')
    .requiredOption('--prompt <text>', 'Follow-up prompt to send')
    .option('--session <id>', 'External session ID (overrides stored session)')
    .option('--latest', 'Use the latest stored session for this tool')
    .option('-p, --project <dir>', 'Project directory (default: cwd)')
    .option('--json', 'Output JSON instead of TUI')
    .action(async (opts: {
      tool: string;
      prompt: string;
      session?: string;
      latest?: boolean;
      project?: string;
      json?: boolean;
    }) => {
      await runFollowupCommand({
        tool: opts.tool,
        prompt: opts.prompt,
        json: opts.json,
        explicitSessionId: opts.session,
        projectDir: opts.project,
        useLatestWhenMissing: opts.latest,
      });
    });

  // ── dashboard ──
  program
    .command('dashboard')
    .description('Open the mmbridge TUI dashboard')
    .option('-m, --mode <mode>', 'Filter sessions by mode')
    .option('-p, --project <dir>', 'Project directory (default: cwd)')
    .option('--json', 'Output JSON instead of TUI')
    .action(async (opts: DashboardOptions) => {
      await runDashboardCommand(opts);
    });

  // ── doctor ──
  program
    .command('doctor')
    .description('Check environment and binary installation')
    .option('--json', 'Output JSON instead of TUI')
    .option('--setup', 'Show the interactive setup wizard')
    .action(async (opts: DoctorOptions) => {
      await runDoctorCommand(opts);
    });

  // ── sync-agents ──
  program
    .command('sync-agents')
    .description('Sync agent definitions to Claude agents directory')
    .option('--dry-run', 'Preview changes without writing files')
    .option('-v, --verbose', 'Verbose output')
    .action(async (opts: SyncAgentsOptions) => {
      await runSyncAgentsCommand(opts);
    });

  await program.parseAsync(process.argv);
}
