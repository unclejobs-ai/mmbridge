import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';

import type { ApsCommandOptions } from './commands/aps.js';
import type { ContextPacketCommandOptions, ContextTreeCommandOptions } from './commands/context.js';
import type { ConversationOptions } from './commands/conversation.js';
import type { DebateCommandOptions } from './commands/debate.js';
import type { DiffCommandOptions } from './commands/diff.js';
import type { DoctorOptions } from './commands/doctor.js';
import type { EmbraceCommandOptions } from './commands/embrace.js';
import type { FollowupCommandOptions } from './commands/followup.js';
import type { GateCommandOptions } from './commands/gate.js';
import type { HandoffCommandOptions } from './commands/handoff.js';
import type { HookCommandOptions } from './commands/hook.js';
import type { InitCommandOptions } from './commands/init.js';
import type {
  MemorySearchCommandOptions,
  MemoryShowCommandOptions,
  MemoryTimelineCommandOptions,
} from './commands/memory.js';
import type { ResearchCommandOptions } from './commands/research.js';
import type { ResumeCommandOptions } from './commands/resume.js';
import type { ReviewCommandOptions } from './commands/review.js';
import type { RunTaskCommandOptions } from './commands/run.js';
import type { SecurityCommandOptions } from './commands/security.js';
import type { SyncAgentsOptions } from './commands/sync-agents.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')) as { version: string };

export type {
  ConversationOptions,
  ReviewCommandOptions,
  RunTaskCommandOptions,
  ResumeCommandOptions,
  FollowupCommandOptions,
  GateCommandOptions,
  HandoffCommandOptions,
  DoctorOptions,
  MemorySearchCommandOptions,
  MemoryShowCommandOptions,
  MemoryTimelineCommandOptions,
  SyncAgentsOptions,
  InitCommandOptions,
  DiffCommandOptions,
  HookCommandOptions,
  ResearchCommandOptions,
  DebateCommandOptions,
  SecurityCommandOptions,
  EmbraceCommandOptions,
  ContextTreeCommandOptions,
  ContextPacketCommandOptions,
};

function supportsInteractiveTui(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY && typeof process.stdin.setRawMode === 'function');
}

function isCommand(value: unknown): value is Command {
  return (
    typeof value === 'object' &&
    value !== null &&
    'opts' in value &&
    typeof (value as { opts?: unknown }).opts === 'function'
  );
}

function commandOptions<T extends object>(value: T | Command): T {
  return isCommand(value) ? (value.opts() as T) : value;
}

async function runTuiOrFallback(
  program: Command,
  options?: { tab?: 'dashboard' | 'sessions' | 'config' },
): Promise<void> {
  if (!supportsInteractiveTui()) {
    process.stderr.write(
      '[mmbridge] Interactive TUI requires a terminal with raw input mode. Falling back to help.\n\n',
    );
    program.outputHelp();
    process.stderr.write(
      '\nTry `mmbridge doctor`, `mmbridge review --json`, or run `mmbridge tui` in an interactive terminal.\n',
    );
    return;
  }

  const { renderTui } = await import('@mmbridge/tui');
  const { executeReplCommand } = await import('./commands/repl-router.js');
  await renderTui({
    tab: options?.tab,
    version: program.version(),
    onReplCommand: async (command: string) => {
      return await executeReplCommand(command);
    },
  });
}

export async function main(): Promise<void> {
  const program = new Command();

  program
    .name('mmbridge')
    .description('Multi-model thinking and review control plane for coding agents')
    .version(pkg.version)
    .option('--model <model>', 'Claude model to use for the conversational REPL')
    .option('-p, --project <dir>', 'Project directory (default: cwd)')
    .action(async (opts: ConversationOptions) => {
      const { runConversation } = await import('./commands/conversation.js');
      await runConversation({ model: opts.model, project: opts.project });
    });

  // ── review ──
  program
    .command('review')
    .description('Run a multi-model review for a change or commit')
    .option('-t, --tool <tool>', 'AI tool to use (kimi|qwen|codex|gemini|droid|claude|pi|all)', 'kimi')
    .option('-m, --mode <mode>', 'Review mode (review|security|architecture)', 'review')
    .option('--bridge <profile>', 'Bridge aggregation profile')
    .option('--base-ref <ref>', 'Git base ref for diff (default: HEAD~1)')
    .option('--commit <sha>', 'Specific commit to review')
    .option('-p, --project <dir>', 'Project directory (default: cwd)')
    .option('--json', 'Output JSON instead of TUI')
    .option('--export <path>', 'Export review report to markdown file')
    .option('-s, --stream', 'Stream real-time output to terminal')
    .action(async (opts: ReviewCommandOptions) => {
      const { runReviewCommand } = await import('./commands/review.js');
      await runReviewCommand(opts);
    });

  // ── run ──
  program
    .command('run <task>')
    .description('Run one task through a declared read-only adapter')
    .option('-t, --tool <tool>', 'Adapter to use (defaults to the first capable installed adapter)')
    .option('-p, --project <dir>', 'Project directory (default: cwd)')
    .option('--readonly', 'Require a declared read-only execution path')
    .option('--json', 'Output structured JSON')
    .action(async (task: string, _opts: Omit<RunTaskCommandOptions, 'task'>, command: Command) => {
      const { runTaskCommand } = await import('./commands/run.js');
      const opts = command.optsWithGlobals() as Omit<RunTaskCommandOptions, 'task'>;
      await runTaskCommand({ ...opts, task });
    });

  // ── followup ──
  program
    .command('followup')
    .description('Send a follow-up prompt to an existing session')
    .requiredOption('-t, --tool <tool>', 'AI tool that ran the original review')
    .requiredOption('--prompt <text>', 'Follow-up prompt to send')
    .option('--session <id>', 'External session ID (overrides stored session)')
    .option('--latest', 'Use the latest stored session for this tool')
    .option('-p, --project <dir>', 'Project directory (default: cwd)')
    .option('--json', 'Output JSON instead of TUI')
    .action(
      async (opts: {
        tool: string;
        prompt: string;
        session?: string;
        latest?: boolean;
        project?: string;
        json?: boolean;
      }) => {
        const { runFollowupCommand } = await import('./commands/followup.js');
        await runFollowupCommand({
          tool: opts.tool,
          prompt: opts.prompt,
          json: opts.json,
          explicitSessionId: opts.session,
          projectDir: opts.project,
          useLatestWhenMissing: opts.latest,
        });
      },
    );

  // ── resume ──
  program
    .command('resume')
    .description('Continue the review workflow with a recommended next action')
    .option('-p, --project <dir>', 'Project directory (default: cwd)')
    .option('--session <id>', 'Specific local session ID')
    .option('--action <action>', 'Action to run (followup|rerun|bridge-rerun)')
    .option('-y, --yes', 'Execute without interactive confirmation')
    .option('--json', 'Output JSON instead of TUI/text')
    .action(async (opts: ResumeCommandOptions) => {
      const { runResumeCommand } = await import('./commands/resume.js');
      await runResumeCommand(opts);
    });

  // ── doctor ──
  program
    .command('doctor')
    .description('Inspect local tooling and binary installation')
    .option('--json', 'Output JSON instead of TUI')
    .option('--setup', 'Show the interactive setup wizard')
    .action(async (opts: DoctorOptions) => {
      const { runDoctorCommand } = await import('./commands/doctor.js');
      await runDoctorCommand(opts);
    });

  // ── gate ──
  program
    .command('gate')
    .description('Check whether the current diff has fresh review coverage')
    .option('-p, --project <dir>', 'Project directory (default: cwd)')
    .option('--base-ref <ref>', 'Git base ref for diff')
    .option('-m, --mode <mode>', 'Review mode to evaluate (review|security|architecture)')
    .option('--format <format>', 'Output format (compact|json)', 'compact')
    .option('--strict', 'Exit non-zero when gate status is warn')
    .action(async (opts: GateCommandOptions | Command) => {
      const { runGateCommand } = await import('./commands/gate.js');
      await runGateCommand(commandOptions<GateCommandOptions>(opts));
    });

  // ── handoff ──
  program
    .command('handoff')
    .description('Inspect or export the latest session handoff artifact')
    .option('--session <id>', 'Specific local session ID')
    .option('-p, --project <dir>', 'Project directory (default: cwd)')
    .option('--write <path>', 'Copy the markdown handoff artifact to a path')
    .option('--json', 'Output JSON instead of text')
    .action(async (opts: HandoffCommandOptions) => {
      const { runHandoffCommand } = await import('./commands/handoff.js');
      await runHandoffCommand(opts);
    });

  // ── memory ──
  const memoryCmd = program.command('memory').description('Search and inspect project memory');

  memoryCmd
    .command('search <query>')
    .description('Search indexed project memory')
    .option('-p, --project <dir>', 'Project directory (default: cwd)')
    .option('--type <type>', 'Memory bucket type')
    .option('--limit <n>', 'Result limit')
    .option('--json', 'Output JSON')
    .action(async (query: string, opts: Omit<MemorySearchCommandOptions, 'query'>) => {
      const { runMemorySearchCommand } = await import('./commands/memory.js');
      await runMemorySearchCommand({ ...opts, query });
    });

  memoryCmd
    .command('timeline')
    .description('Show recent memory entries for a session or query')
    .option('--session <id>', 'Specific local session ID')
    .option('--query <text>', 'Search query')
    .option('-p, --project <dir>', 'Project directory (default: cwd)')
    .option('--limit <n>', 'Result limit')
    .option('--json', 'Output JSON')
    .action(async (opts: MemoryTimelineCommandOptions) => {
      const { runMemoryTimelineCommand } = await import('./commands/memory.js');
      await runMemoryTimelineCommand(opts);
    });

  memoryCmd
    .command('show')
    .description('Show specific memory entries by id')
    .requiredOption('--ids <id,id,...>', 'Comma-separated memory ids')
    .option('-p, --project <dir>', 'Project directory (default: cwd)')
    .option('--json', 'Output JSON')
    .action(async (opts: MemoryShowCommandOptions) => {
      const { runMemoryShowCommand } = await import('./commands/memory.js');
      await runMemoryShowCommand(opts);
    });

  // ── sync-agents ──
  program
    .command('sync-agents')
    .description('Sync agent definitions to Claude Code')
    .option('--dry-run', 'Preview changes without writing files')
    .action(async (opts: SyncAgentsOptions) => {
      const { runSyncAgentsCommand } = await import('./commands/sync-agents.js');
      await runSyncAgentsCommand(opts);
    });

  // ── init ──
  program
    .command('init')
    .description('Initialize project config interactively')
    .option('-p, --project <dir>', 'Project directory (default: cwd)')
    .option('-y, --yes', 'Skip prompts and use detected defaults')
    .action(async (opts: InitCommandOptions) => {
      const { runInitCommand } = await import('./commands/init.js');
      await runInitCommand(opts);
    });

  // ── login ──
  program
    .command('login [provider]')
    .description('Authenticate with a provider (anthropic, openai, or an API key name)')
    .action(async (provider?: string) => {
      const { login } = await import('@mmbridge/auth');
      await login(provider);
    });

  // ── logout ──
  program
    .command('logout [provider]')
    .description('Remove stored credentials for a provider (or all providers if omitted)')
    .action(async (provider?: string) => {
      const { logout } = await import('@mmbridge/auth');
      await logout(provider);
    });

  // ── auth ──
  const authCmd = program.command('auth').description('Manage mmbridge authentication');

  authCmd
    .command('status')
    .description('Show current authentication status for all providers')
    .action(async () => {
      const { status } = await import('@mmbridge/auth');
      await status();
    });

  authCmd
    .command('login [provider]')
    .description('Authenticate with a provider')
    .action(async (provider?: string) => {
      const { login } = await import('@mmbridge/auth');
      await login(provider);
    });

  authCmd
    .command('logout [provider]')
    .description('Remove stored credentials for a provider')
    .action(async (provider?: string) => {
      const { logout } = await import('@mmbridge/auth');
      await logout(provider);
    });

  authCmd
    .command('whoami')
    .description('Show which account is currently authenticated')
    .action(async () => {
      const { whoami } = await import('@mmbridge/auth');
      await whoami();
    });

  // ── setup ──
  program
    .command('setup')
    .description('Interactive setup wizard — configure providers, auth, and defaults')
    .action(async () => {
      const { runSetup } = await import('@mmbridge/auth');
      await runSetup();
    });

  // ── tui ──
  program
    .command('tui')
    .description('Open the interactive TUI control plane')
    .option('--tab <tab>', 'Open directly to a tab (dashboard|sessions|config)')
    .action(async (opts: { tab?: string }) => {
      await runTuiOrFallback(program, {
        tab: opts.tab as 'dashboard' | 'sessions' | 'config',
      });
    });

  // ── diff ──
  program
    .command('diff')
    .description('Show a git diff annotated with review findings')
    .option('-t, --tool <tool>', 'Filter findings by tool')
    .option('--base-ref <ref>', 'Git base ref for diff')
    .option('-p, --project <dir>', 'Project directory (default: cwd)')
    .option('--session <id>', 'Specific session ID to use')
    .action(async (opts: DiffCommandOptions) => {
      const { runDiffCommand } = await import('./commands/diff.js');
      await runDiffCommand(opts);
    });

  // ── research ──
  program
    .command('research <topic>')
    .description('Research a topic using multiple AI models')
    .option('-t, --type <type>', 'Research type (code-aware|open)', 'open')
    .option('--tool <tools>', 'Comma-separated tools (default: all installed)')
    .option('-p, --project <dir>', 'Project directory (default: cwd)')
    .option('--json', 'Output JSON')
    .option('-s, --stream', 'Stream real-time output')
    .action(async (topic: string, opts: Omit<ResearchCommandOptions, 'topic'>) => {
      const { runResearchCommand } = await import('./commands/research.js');
      await runResearchCommand({ ...opts, topic });
    });

  // ── debate ──
  program
    .command('debate <proposition>')
    .description('Run a multi-model debate on a proposition')
    .option('-r, --rounds <n>', 'Number of debate rounds', '3')
    .option('--teams <spec>', 'Team assignment "for_tools:against_tools"')
    .option('--tool <tools>', 'Comma-separated tools (default: all installed)')
    .option('-p, --project <dir>', 'Project directory (default: cwd)')
    .option('--json', 'Output JSON')
    .option('-s, --stream', 'Stream real-time output')
    .action(async (proposition: string, opts: Omit<DebateCommandOptions, 'proposition'>) => {
      const { runDebateCommand } = await import('./commands/debate.js');
      await runDebateCommand({ ...opts, proposition });
    });

  // ── security ──
  program
    .command('security')
    .description('Run a security audit workflow with model assistance')
    .option('--scope <scope>', 'Audit scope (auth|api|infra|all)', 'all')
    .option('--tool <tools>', 'Comma-separated tools (default: all installed)')
    .option('--compliance <list>', 'Compliance frameworks (GDPR,SOC2,HIPAA,PCI-DSS)')
    .option('--bridge <mode>', 'Bridge mode (none|standard|interpreted)', 'standard')
    .option('--base-ref <ref>', 'Git base ref for diff')
    .option('-p, --project <dir>', 'Project directory (default: cwd)')
    .option('--json', 'Output JSON')
    .option('-s, --stream', 'Stream real-time output')
    .action(async (opts: SecurityCommandOptions) => {
      const { runSecurityCommand } = await import('./commands/security.js');
      await runSecurityCommand(opts);
    });

  // ── embrace ──
  program
    .command('embrace <task>')
    .description('Orchestrate research, debate, checkpointing, review, and security')
    .option('--resume [id]', 'Resume a paused embrace run')
    .option('--resolve <text>', 'Resolve a checkpoint with this response')
    .option('--skip-phases <phases>', 'Comma-separated phases to skip')
    .option('--tool <tools>', 'Comma-separated tools (default: all installed)')
    .option('-p, --project <dir>', 'Project directory (default: cwd)')
    .option('--json', 'Output JSON')
    .option('-s, --stream', 'Stream real-time output')
    .option('--non-interactive', 'Auto-proceed through checkpoints')
    .action(async (task: string, opts: Omit<EmbraceCommandOptions, 'task'>) => {
      const { runEmbraceCommand } = await import('./commands/embrace.js');
      await runEmbraceCommand({ ...opts, task });
    });

  // ── hook ──
  const hookCmd = program.command('hook').description('Manage Claude Code hooks');

  hookCmd
    .command('install')
    .description('Install mmbridge hooks into Claude Code settings')
    .option('--global', 'Install to global ~/.claude/settings.json')
    .option('--settings <name>', 'Settings file target (default|local)', 'default')
    .option('--json', 'Output JSON')
    .action(async (opts: HookCommandOptions | Command) => {
      const { runHookInstallCommand } = await import('./commands/hook.js');
      await runHookInstallCommand(commandOptions<HookCommandOptions>(opts));
    });

  hookCmd
    .command('uninstall')
    .description('Remove mmbridge hooks from Claude Code settings')
    .option('--global', 'Remove from global ~/.claude/settings.json')
    .option('--settings <name>', 'Settings file target (default|local)', 'default')
    .option('--json', 'Output JSON')
    .action(async (opts: HookCommandOptions | Command) => {
      const { runHookUninstallCommand } = await import('./commands/hook.js');
      await runHookUninstallCommand(commandOptions<HookCommandOptions>(opts));
    });

  // ── context ──
  const contextCmd = program.command('context').description('Inspect the context broker tree and packets');

  contextCmd
    .command('tree')
    .description('Show recent context tree nodes for a project')
    .option('-p, --project <dir>', 'Project directory (default: cwd)')
    .option('--limit <n>', 'Number of recent nodes to show', '10')
    .option('--json', 'Output JSON')
    .action(async (opts: ContextTreeCommandOptions) => {
      const { runContextTreeCommand } = await import('./commands/context.js');
      await runContextTreeCommand(opts);
    });

  contextCmd
    .command('packet')
    .description('Assemble and preview a ContextPacket for a project')
    .option('-p, --project <dir>', 'Project directory (default: cwd)')
    .option('--task <text>', 'Task description for context assembly', 'preview context packet')
    .option('--command <cmd>', 'Command context for assembly', 'mmbridge context packet')
    .option('--budget <n>', 'Recall token budget')
    .option('--json', 'Output JSON')
    .action(async (opts: ContextPacketCommandOptions) => {
      const { runContextPacketCommand } = await import('./commands/context.js');
      await runContextPacketCommand(opts);
    });

  // APS handlers are deliberately lazy so unrelated --help does not load node:sqlite.
  const apsCmd = program.command('aps').description('APS work-card ledger');
  apsCmd
    .command('gate')
    .description('Run repository engineering gates and enforce baseline ratchets')
    .option('--project-dir <dir>', 'Repository directory (default: cwd)')
    .option('--update-baseline', 'Record passing metrics in the baseline')
    .option('--base-ref <ref>', 'Trusted baseline/exemptions git ref and changed-path base')
    .option('--format <format>', 'table|json (default: table)')
    .option('--card <id>', 'Append gate evidence to an APS card')
    .option('--db <path>', 'Ledger path (with --card)')
    .option('--by <agent>', 'Acting agent (default: APS_AGENT, with --card)')
    .option('--json', 'Output JSON instead of a human table')
    .exitOverride((error) => {
      process.exit(error.exitCode === 0 ? 0 : 2);
    })
    .action(async (options) => {
      const { runApsGateCommand } = await import('./commands/aps-gate.js');
      await runApsGateCommand(options);
    });
  const addAps = (
    parent: Command,
    spec: string,
    action: string,
    flags: [string, string][],
    loader: () => Promise<{
      runApsCommand: (action: string, id: string | undefined, options: ApsCommandOptions) => Promise<void>;
    }> = () => import('./commands/aps.js'),
  ) => {
    const cmd = parent
      .command(spec)
      .description(`APS ${action.replaceAll('-', ' ')}`)
      .option('--db <path>', 'Ledger path')
      .option('--json', 'Output JSON')
      .option('--by <agent>', 'Acting agent (default: APS_AGENT)')
      .option('--project-dir <dir>', 'Git project directory (default: cwd)')
      .exitOverride((error) => {
        process.exit(error.exitCode === 0 ? 0 : 2);
      });
    for (const [flag, description] of flags) cmd.option(flag, description);
    cmd.action(async (...args: unknown[]) => {
      const command = args.at(-1) as Command;
      const id = typeof args[0] === 'string' ? args[0] : undefined;
      const { runApsCommand } = await loader();
      await runApsCommand(action, id, command.optsWithGlobals() as ApsCommandOptions);
    });
    return cmd;
  };
  addAps(apsCmd, 'init', 'init', []);
  addAps(apsCmd, 'doctor', 'doctor', []);
  const apsProject = apsCmd.command('project').description('Ledger projects');
  addAps(apsProject, 'add <id>', 'project-add', [
    ['--prefix <prefix>', 'Card prefix'],
    ['--name <name>', 'Project name'],
  ]);
  const apsAgent = apsCmd.command('agent').description('Agent sessions');
  addAps(apsAgent, 'new', 'agent-new', [
    ['--name <name>', 'Worker identity'],
    ['--layer <layer>', 'L0|L1|L2|L3'],
    ['--model <model>', 'Model'],
    ['--vendor <vendor>', 'Vendor'],
    ['--project <id>', 'Ledger project'],
    ['--herdr-pane <pane>', 'Pane ID'],
  ]);
  addAps(apsAgent, 'list', 'agent-list', [
    ['--status <status>', 'active|idle|closed|open|all (default open)'],
    ['--project <id>', 'Filter project'],
    ['--layer <layer>', 'L0|L1|L2|L3'],
  ]);
  const apsCard = apsCmd.command('card').description('Work cards');
  addAps(apsCard, 'new', 'card-new', [
    ['--project <id>', 'Ledger project'],
    ['--title <title>', 'Goal'],
    ['--kind <kind>', 'mech|design|review|vision|research'],
    ['--size <size>', 'S|M|L'],
    ['--scope <scope>', 'Scope'],
    ['--acceptance <file>', 'Acceptance JSON file'],
    ['--forbidden <text>', 'Forbidden actions'],
    ['--needs-owner <bit>', '0|1'],
    ['--needs-vision <bit>', '0|1'],
    ['--owner <agent>', 'Manager'],
    ['--assignee <agent>', 'Worker session'],
    ['--parent <card>', 'Parent card'],
    ['--body <file>', 'Details markdown'],
    ['--source-ref <ref>', 'Source reference'],
  ]);
  addAps(apsCard, 'show <id>', 'card-show', [['--as-prompt', 'Worker prompt']]);
  addAps(apsCard, 'list', 'card-list', [
    ['--project <id>', 'Filter project'],
    ['--state <state>', 'Filter state'],
    ['--assignee <agent>', 'Filter worker'],
  ]);
  addAps(apsCmd, 'start <card>', 'start', [['--assignee <agent>', 'Worker session']]);
  addAps(
    apsCmd,
    'dispatch <card>',
    'dispatch',
    [
      ['--harness <harness>', 'herdr|omp|devin|grok'],
      ['--kind <kind>', 'herdr worker kind: omp|devin|grok'],
      ['--lane <name>', 'Stable worker identity'],
      ['--layer <layer>', 'L2|L3'],
      ['--model <model>', 'Worker model'],
      ['--vendor <vendor>', 'Worker vendor'],
      ['--worktree <path>', 'Existing clean absolute git worktree'],
      ['--branch <branch>', 'Checked-out worktree branch'],
      ['--workspace <workspace>', 'herdr workspace ID or label (default: card project)'],
      ['--permission-mode <mode>', 'Harness-specific permission mode'],
      ['--omp-id <id>', 'omp task agent ID (pointer mode); omit for a headless `omp -p` run'],
      ['--omp-agent <name>', 'omp agent definition appended to a headless omp run (e.g. w-glm)'],
      ['--dry-run', 'Print packet and spawn argv without writes'],
      ['--auto', 'Pick the worker from the registry by quota, vendor load and tier (APS §14)'],
      ['--tier <tier>', '--auto: L3 (default) or L2'],
      ['--role <role>', '--auto: mech (default) | review | design | vision'],
      ['--workers <ids>', '--auto: explicit comma fallback chain of registry ids'],
      ['--exclude <ids>', '--auto: registry ids to skip'],
      ['--ignore-quota', '--auto: do not skip quota-blocked providers'],
      ['--quota-json <file>', '--auto: omp/codexbar usage JSON instead of a live probe'],
      ['--workers-file <file>', '--auto: worker registry JSON (default: built-in)'],
      ['--probe <seconds>', '--auto: watch each launch for an early usage/auth/outage exit (default 60)'],
    ],
    async () => {
      const { runApsDispatchCommand } = await import('./commands/aps-dispatch.js');
      const { runAutoDispatchCommand } = await import('./commands/aps-dispatch-auto.js');
      return {
        runApsCommand: (action, id, options) =>
          options.auto ? runAutoDispatchCommand(id, options) : runApsDispatchCommand(action, id, options),
      };
    },
  );
  addAps(
    apsCmd,
    'adopt <card>',
    'adopt',
    [
      ['--agent <agent>', 'Existing open worker session'],
      ['--worktree <path>', 'Absolute git worktree checked out on --branch'],
      ['--branch <branch>', 'Checked-out worktree branch'],
      ['--base-sha <sha>', '40 or 64 hex base sha (default: merge-base origin/main, else main)'],
      ['--pid <pid>', 'Live process id of the lane'],
      ['--pane <pane>', 'Live herdr pane id'],
      ['--harness <harness>', 'herdr|omp|devin|grok (default: herdr if --pane, else omp)'],
      ['--kind <kind>', 'herdr worker kind: omp|devin|grok (default omp)'],
      ['--model <model>', 'Worker model (default: agent model)'],
      ['--session-ref <path>', 'Session transcript or directory'],
    ],
    async () => {
      const { runApsAdoptCommand } = await import('./commands/aps-adopt.js');
      return { runApsCommand: runApsAdoptCommand };
    },
  );
  addAps(
    apsCmd,
    'collect [card]',
    'collect',
    [
      ['--all', 'Collect every launched or reported run'],
      ['--wait <dur>', 'Poll for report.json (e.g. 90s, 30m, 2h)'],
      ['--abandon', 'Abandon a run that ended without report.json'],
      ['--close-only', 'Close the launched run of a card past working from report.json (no report row, card stays)'],
      ['--omp-session-dir <dir>', 'Resolve an ambiguous omp transcript dir'],
    ],
    async () => {
      const { runApsCollectCommand } = await import('./commands/aps-collect.js');
      return { runApsCommand: runApsCollectCommand };
    },
  );
  const apsLane = apsCmd.command('lane').description('omp task lanes that record themselves');
  const laneLoader = async () => {
    const { runApsLaneCommand } = await import('./commands/aps-lane.js');
    return { runApsCommand: runApsLaneCommand };
  };
  addAps(
    apsLane,
    'start <card>',
    'lane-start',
    [
      ['--omp-id <id>', 'omp task agent ID'],
      ['--lane <name>', 'Lane name = agent name; an open agent with it is reused'],
      ['--model <model>', 'Worker model (default: reused agent, else the task transcript)'],
      ['--layer <layer>', 'L2|L3 for a new agent (default L3)'],
      ['--vendor <vendor>', 'Vendor for a new agent (default: model provider)'],
      ['--worktree <path>', 'Absolute git worktree of the lane (default: --project-dir)'],
      ['--branch <branch>', 'Checked-out worktree branch'],
      ['--omp-session-dir <dir>', 'Required: parent session artifacts dir holding <omp-id>.jsonl'],
    ],
    laneLoader,
  );
  addAps(
    apsLane,
    'end <card>',
    'lane-end',
    [
      ['--omp-id <id>', 'omp task agent ID of the live run'],
      ['--omp-session-dir <dir>', 'Resolve an ambiguous omp transcript dir'],
      ['--abandon', 'Abandon a run that yielded without report.json'],
    ],
    laneLoader,
  );
  const foremanFlags: [string, string][] = [
    ['--repo <path>', 'Absolute git repo; per-card worktrees go to <repo>.foreman/<card>'],
    ['--max <n>', 'Max live lanes for this parent (default 6)'],
    ['--wait <dur>', 'Keep passing every 30s while lanes run, up to this long (90s, 30m, 2h)'],
    ['--workers <ids>', 'Explicit comma fallback chain of registry ids'],
    ['--exclude <ids>', 'Registry ids to skip'],
    ['--ignore-quota', 'Do not skip quota-blocked providers'],
    ['--quota-json <file>', 'omp/codexbar usage JSON instead of a live probe'],
    ['--workers-file <file>', 'Worker registry JSON (default: built-in)'],
    ['--probe <seconds>', 'Watch each launch for an early usage/auth/outage exit (default 60)'],
    ['--ac-timeout <seconds>', 'Timeout per acceptance command (default 600)'],
  ];
  const foremanLoader = async () => {
    const { runForemanCommand } = await import('./commands/aps-foreman.js');
    return {
      runApsCommand: (_action: string, id: string | undefined, options: ApsCommandOptions) =>
        runForemanCommand(id, options),
    };
  };
  const auditFlags: [string, string][] = [
    ['--out <file>', 'Also write the markdown report here (atomic)'],
    ['--quota-json <file>', 'omp/codexbar usage JSON instead of a live probe'],
    ['--no-herdr', 'Skip herdr lanes'],
    ['--stall-min <minutes>', 'Working lane without output this long is stalled (default 30)'],
    ['--idle-min <minutes>', 'Idle or done open session with no output this long is IDLE_OPEN (default 10, minimum 1)'],
    ['--close-idle', 'Close IDLE_OPEN sessions (herdr pane close, then close-session). Requires --by'],
    ['--ps', 'Also scan omp/grok/claude/devin processes with no herdr pane'],
    ['--ignore-pid <pids>', 'Comma-separated pids to skip in the --ps scan'],
    ['--no-omp-sessions', 'Skip omp subagent transcript discovery (D3)'],
    ['--omp-live-min <minutes>', 'omp subagent transcript written within this long counts as live (default 10)'],
  ];
  const auditLoader = async () => {
    const { runApsAuditCommand } = await import('./commands/aps-audit.js');
    return {
      runApsCommand: (_action: string, _id: string | undefined, options: ApsCommandOptions) =>
        runApsAuditCommand(options),
    };
  };
  // 반장 (APS §14): top-level for operators, also under `aps` next to dispatch/collect.
  for (const parent of [program, apsCmd]) {
    addAps(parent, 'foreman <parent-card>', 'foreman', foremanFlags, foremanLoader);
    addAps(parent, 'audit', 'audit', auditFlags, auditLoader);
  }
  addAps(apsCmd, 'return <card>', 'return', [['--note <text>', 'Return reason']]);
  addAps(apsCmd, 'reject <card>', 'reject', [['--note <text>', 'Rejection reason']]);
  addAps(apsCmd, 'done <card>', 'done', []);
  addAps(apsCmd, 'report <card>', 'report', [
    ['--sha <sha>', 'Reported commit'],
    ['--branch <branch>', 'Branch'],
    ['--files <json>', 'JSON or @file'],
    ['--evidence <file>', 'Evidence JSON'],
    ['--status <status>', 'DONE|DONE_WITH_CONCERNS|BLOCKED'],
    ['--risks <text>', 'Concerns'],
    ['--pr <url>', 'Pull request'],
    ['--body <file>', 'Report markdown'],
    ['--recorded-by <agent>', 'Proxy recorder'],
  ]);
  addAps(apsCmd, 'close-session <agent>', 'close-session', [
    ['--note <text>', 'Closure evidence'],
    ['--abandon', 'Return working cards'],
  ]);
  addAps(apsCmd, 'review <card>', 'review', [
    ['--verdict <verdict>', 'accept|revise|reject'],
    ['--items <file>', 'Findings JSON'],
    ['--from-session <uuid>', 'Local mmbridge session'],
    ['--owner', 'On behalf of owner'],
    ['--category <category>', 'Imported findings category'],
    ['--partial', 'Record an accept without advancing to merge_wait'],
    ['--recorded-by <agent>', 'Proxy recorder'],
  ]);
  addAps(apsCmd, 'vision <card>', 'vision', [
    ['--shots <file>', 'Screenshot JSON'],
    ['--verdict <verdict>', 'pass|fail'],
    ['--items <file>', 'Findings JSON'],
    ['--notes <text>', 'Notes'],
  ]);
  addAps(apsCmd, 'owner-ok <card>', 'owner-ok', [
    ['--quote <text>', 'Owner quote'],
    ['--source-ref <ref>', 'Source reference'],
  ]);
  addAps(apsCmd, 'merge <card>', 'merge', [
    ['--merged-sha <sha>', 'Merged commit'],
    ['--applied-ref <ref>', 'Applied non-git change'],
    ['--target <target>', 'Merge/apply target'],
    ['--gate', 'Record gate'],
    ['--base-ref <ref>', 'Gate base ref'],
    ['--project <id>', 'Require the card to belong to this project (default: config aps.project)'],
  ]);
  addAps(apsCmd, 'todo-render', 'todo-render', [
    ['--out <path>', 'Atomically write markdown'],
    ['--project <id>', 'Filter project'],
  ]);
  addAps(apsCmd, 'brief', 'brief', [
    ['--level <level>', 'L0|L1|L2'],
    ['--since <iso>', 'Period start'],
    ['--save', 'Persist briefing'],
    ['--project <id>', 'Filter kanban'],
  ]);
  addAps(apsCmd, 'metrics', 'metrics', [
    ['--week', 'Last seven days'],
    ['--since <iso>', 'Period start'],
  ]);
  addAps(apsCmd, 'chart', 'chart', [
    ['--metric <metric>', 'rework|pass|cycle'],
    ['--days <days>', 'Daily points (default 14)'],
  ]);
  const apsFeedback = apsCmd.command('feedback').description('Feedback ledger');
  addAps(apsFeedback, 'new', 'feedback-new', [
    ['--to <agent>', 'Recipient'],
    ['--kind <kind>', 'objection|proposal|andon'],
    ['--body <text>', 'Feedback'],
    ['--card <card>', 'Card'],
  ]);
  addAps(apsFeedback, 'respond <id>', 'feedback-respond', [
    ['--response <response>', 'accept|partial|reject'],
    ['--reason <text>', 'Reason'],
  ]);
  const apsDefect = apsCmd.command('defect').description('External defects');
  addAps(apsDefect, 'add <card>', 'defect-add', [
    ['--source <source>', 'ci|revert|owner'],
    ['--category <category>', 'Category'],
    ['--severity <severity>', 'blocker|major|minor|nit'],
    ['--text <text>', 'Description'],
    ['--ref <ref>', 'Reference'],
  ]);

  await program.parseAsync(process.argv);
}
