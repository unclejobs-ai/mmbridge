import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, Option } from 'commander';

import type { DiffCommandOptions } from './commands/diff.js';
import type { DoctorOptions } from './commands/doctor.js';
import type { FollowupCommandOptions } from './commands/followup.js';
import type { HandoffCommandOptions } from './commands/handoff.js';
import type { HookCommandOptions } from './commands/hook.js';
import type { InitCommandOptions } from './commands/init.js';
import type {
  MemorySearchCommandOptions,
  MemoryShowCommandOptions,
  MemoryTimelineCommandOptions,
} from './commands/memory.js';
import type { ReviewCommandOptions } from './commands/review.js';
import type { SyncAgentsOptions } from './commands/sync-agents.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')) as { version: string };

export type {
  ReviewCommandOptions,
  FollowupCommandOptions,
  HandoffCommandOptions,
  DoctorOptions,
  MemorySearchCommandOptions,
  MemoryShowCommandOptions,
  MemoryTimelineCommandOptions,
  SyncAgentsOptions,
  InitCommandOptions,
  DiffCommandOptions,
  HookCommandOptions,
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
  await renderTui({
    tab: options?.tab,
    version: program.version(),
  });
}

export async function main(): Promise<void> {
  const program = new Command();

  program
    .name('mmbridge')
    .description('Multi-model code review bridge')
    .version(pkg.version)
    .action(async () => {
      await runTuiOrFallback(program);
    });

  // ── review ──
  program
    .command('review')
    .description('Run a code review. Use --all for consensus or --manager for supervised consensus.')
    .option('-t, --tool <tool>', 'AI tool to use (kimi|qwen|codex|gemini|droid|claude)')
    .option('--all', 'Run all installed review tools in parallel and merge by consensus')
    .option('--manager', 'Run supervisor-managed consensus review (implies --all)')
    .option('-m, --mode <mode>', 'Review mode (review|security|architecture)', 'review')
    .addOption(new Option('--bridge <profile>', 'Legacy bridge mode (standard|interpreted)').hideHelp())
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
    .description('Send a follow-up prompt to an existing review session')
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

  // ── doctor ──
  program
    .command('doctor')
    .description('Check environment and binary installation')
    .option('--json', 'Output JSON instead of TUI')
    .option('--setup', 'Show the interactive setup wizard')
    .action(async (opts: DoctorOptions) => {
      const { runDoctorCommand } = await import('./commands/doctor.js');
      await runDoctorCommand(opts);
    });

  // ── handoff ──
  program
    .command('handoff')
    .description('Show or export the latest session handoff artifact for this project')
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
    .description('Sync agent definitions to Claude agents directory')
    .option('--dry-run', 'Preview changes without writing files')
    .action(async (opts: SyncAgentsOptions) => {
      const { runSyncAgentsCommand } = await import('./commands/sync-agents.js');
      await runSyncAgentsCommand(opts);
    });

  // ── init ──
  program
    .command('init')
    .description('Initialize mmbridge config for a project')
    .option('-p, --project <dir>', 'Project directory (default: cwd)')
    .option('-y, --yes', 'Skip prompts and use detected defaults')
    .action(async (opts: InitCommandOptions) => {
      const { runInitCommand } = await import('./commands/init.js');
      await runInitCommand(opts);
    });

  // ── tui ──
  program
    .command('tui')
    .description('Open the interactive TUI hub')
    .option('--tab <tab>', 'Open directly to a tab (dashboard|sessions|config)')
    .action(async (opts: { tab?: string }) => {
      await runTuiOrFallback(program, {
        tab: opts.tab as 'dashboard' | 'sessions' | 'config',
      });
    });

  // ── diff ──
  program
    .command('diff')
    .description('Show git diff annotated with review findings')
    .option('-t, --tool <tool>', 'Filter findings by tool')
    .option('--base-ref <ref>', 'Git base ref for diff')
    .option('-p, --project <dir>', 'Project directory (default: cwd)')
    .option('--session <id>', 'Specific session ID to use')
    .action(async (opts: DiffCommandOptions) => {
      const { runDiffCommand } = await import('./commands/diff.js');
      await runDiffCommand(opts);
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

  await program.parseAsync(process.argv);
}
