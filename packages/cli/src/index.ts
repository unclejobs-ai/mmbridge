import { Command } from 'commander';

import type { ReviewCommandOptions } from './commands/review.js';
import type { FollowupCommandOptions } from './commands/followup.js';
import type { DashboardOptions } from './commands/dashboard.js';
import type { DoctorOptions } from './commands/doctor.js';
import type { SyncAgentsOptions } from './commands/sync-agents.js';
import type { InitCommandOptions } from './commands/init.js';

export type { ReviewCommandOptions, FollowupCommandOptions, DashboardOptions, DoctorOptions, SyncAgentsOptions, InitCommandOptions };

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
    .option('--export <path>', 'Export review report to markdown file')
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

  // ── dashboard ──
  program
    .command('dashboard')
    .description('Open the mmbridge TUI dashboard')
    .option('-m, --mode <mode>', 'Filter sessions by mode')
    .option('-p, --project <dir>', 'Project directory (default: cwd)')
    .option('--json', 'Output JSON instead of TUI')
    .action(async (opts: DashboardOptions) => {
      const { runDashboardCommand } = await import('./commands/dashboard.js');
      await runDashboardCommand(opts);
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

  await program.parseAsync(process.argv);
}
