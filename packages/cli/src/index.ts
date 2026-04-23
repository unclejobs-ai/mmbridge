import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';

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
import type { SecurityCommandOptions } from './commands/security.js';
import type { SyncAgentsOptions } from './commands/sync-agents.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')) as { version: string };

export type {
  ConversationOptions,
  ReviewCommandOptions,
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
    .action(async (opts: GateCommandOptions) => {
      const { runGateCommand } = await import('./commands/gate.js');
      await runGateCommand(opts);
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
    .option('--json', 'Output JSON')
    .action(async (opts: { global?: boolean; json?: boolean }) => {
      const { runHookInstallCommand } = await import('./commands/hook.js');
      await runHookInstallCommand(opts);
    });

  hookCmd
    .command('uninstall')
    .description('Remove mmbridge hooks from Claude Code settings')
    .option('--global', 'Remove from global ~/.claude/settings.json')
    .option('--json', 'Output JSON')
    .action(async (opts: { global?: boolean; json?: boolean }) => {
      const { runHookUninstallCommand } = await import('./commands/hook.js');
      await runHookUninstallCommand(opts);
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

  await program.parseAsync(process.argv);
}
