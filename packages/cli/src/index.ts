import { Command } from 'commander';

import type { ReviewCommandOptions } from './commands/review.js';
import type { FollowupCommandOptions } from './commands/followup.js';
import type { DoctorOptions } from './commands/doctor.js';
import type { SyncAgentsOptions } from './commands/sync-agents.js';
import type { InitCommandOptions } from './commands/init.js';
import type { DiffCommandOptions } from './commands/diff.js';
import type { HookCommandOptions } from './commands/hook.js';

export type { ReviewCommandOptions, FollowupCommandOptions, DoctorOptions, SyncAgentsOptions, InitCommandOptions, DiffCommandOptions, HookCommandOptions };

export async function main(): Promise<void> {
  const program = new Command();

  program
    .name('mmbridge')
    .description('Multi-model code review bridge')
    .version('0.2.0')
    .action(async () => {
      const { renderTui } = await import('@mmbridge/tui');
      await renderTui();
    });

  // ── review ──
  program
    .command('review')
    .description('Run a code review with the specified AI tool')
    .option('-t, --tool <tool>', 'AI tool to use (kimi|qwen|codex|gemini|droid|claude|all)', 'kimi')
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
      const { runFollowupCommand } = await import('./commands/followup.js');
      await runFollowupCommand({
        tool: opts.tool,
        prompt: opts.prompt,
        json: opts.json,
        explicitSessionId: opts.session,
        projectDir: opts.project,
        useLatestWhenMissing: opts.latest,
      });
    });

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
    .option('--tab <tab>', 'Open directly to a tab (review|config|sessions|diff)')
    .action(async (opts: { tab?: string }) => {
      const { renderTui } = await import('@mmbridge/tui');
      await renderTui({ tab: opts.tab as 'status' | 'review' | 'sessions' | 'config' });
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
