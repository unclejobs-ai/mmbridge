import type { DoctorOptions } from './doctor.js';
import type { FollowupCommandOptions } from './followup.js';
import type { GateCommandOptions } from './gate.js';
import type { HandoffCommandOptions } from './handoff.js';
import { resolveProjectDir } from './helpers.js';
import type { MemorySearchCommandOptions } from './memory.js';
import type { ReviewCommandOptions } from './review.js';
import type { SecurityCommandOptions } from './security.js';

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type ReplResult =
  | { type: 'success'; message: string }
  | {
      type: 'findings';
      tool: string;
      findings: Array<{ severity: string; file: string; line: number | null; message: string }>;
      duration: number;
    }
  | { type: 'text'; content: string }
  | { type: 'error'; message: string }
  | { type: 'status'; data: Record<string, string> };

// ---------------------------------------------------------------------------
// Command registry type
// ---------------------------------------------------------------------------

export interface ReplCommand {
  name: string;
  aliases: string[];
  description: string;
  usage: string;
  execute: (args: string[], projectDir: string) => Promise<ReplResult>;
}

// ---------------------------------------------------------------------------
// Argument parsing helpers
// ---------------------------------------------------------------------------

function splitArgs(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  for (const ch of input) {
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (ch === ' ' && !inSingle && !inDouble) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

function getFlag(args: string[], flag: string): string | undefined {
  const prefix = `--${flag}=`;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === `--${flag}` && i + 1 < args.length) return args[i + 1];
    if (arg?.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return undefined;
}

function positionalArgs(args: string[]): string[] {
  const result: string[] = [];
  let skip = false;
  for (const arg of args) {
    if (skip) {
      skip = false;
      continue;
    }
    if (arg.startsWith('--')) {
      if (!arg.includes('=')) skip = true;
      continue;
    }
    result.push(arg);
  }
  return result;
}

async function wrap(fn: () => Promise<void>, successMsg: string): Promise<ReplResult> {
  try {
    await fn();
    return { type: 'success', message: successMsg };
  } catch (error) {
    return { type: 'error', message: error instanceof Error ? error.message : String(error) };
  }
}

// ---------------------------------------------------------------------------
// REPL command registry
// ---------------------------------------------------------------------------

export const REPL_COMMANDS: ReplCommand[] = [
  {
    name: 'review',
    aliases: ['r'],
    description: 'Run a multi-model review on the current diff',
    usage: '/review [--tool <name>] [--mode <mode>]',
    async execute(args, projectDir) {
      const { runReviewCommandStructured } = await import('./review.js');
      const opts: ReviewCommandOptions = {
        tool: getFlag(args, 'tool'),
        mode: getFlag(args, 'mode'),
        bridge: getFlag(args, 'bridge'),
        project: projectDir,
      };
      try {
        const result = await runReviewCommandStructured(opts);
        if (result.findings.length === 0) {
          return { type: 'success', message: `${result.tool} review: no findings.` };
        }
        return {
          type: 'findings',
          tool: result.tool,
          findings: result.findings.map((f) => ({
            severity: f.severity,
            file: f.file,
            line: f.line ?? null,
            message: f.message,
          })),
          duration: result.durationMs,
        };
      } catch (err) {
        return { type: 'error', message: err instanceof Error ? err.message : String(err) };
      }
    },
  },
  {
    name: 'followup',
    aliases: ['f', 'fu'],
    description: 'Send a follow-up prompt to the latest review session',
    usage: '/followup [--tool <name>] <text>',
    async execute(args, projectDir) {
      const prompt = positionalArgs(args).join(' ').trim();
      if (!prompt) return { type: 'error', message: 'Followup requires a prompt. Usage: /followup <text>' };
      const { runFollowupCommand } = await import('./followup.js');
      const opts: FollowupCommandOptions = {
        tool: getFlag(args, 'tool') ?? 'kimi',
        prompt,
        projectDir,
        useLatestWhenMissing: true,
      };
      return wrap(() => runFollowupCommand(opts), 'Follow-up sent.');
    },
  },
  {
    name: 'status',
    aliases: ['s', 'st'],
    description: 'Show project info, tool availability, and last review summary',
    usage: '/status',
    async execute(_args, projectDir) {
      const { importAdapters, importSessionStore, importCore } = await import('./helpers.js');
      const { commandExists } = await importCore();
      const { defaultRegistry } = await importAdapters(projectDir);
      const { SessionStore } = await importSessionStore();
      const sessionStore = new SessionStore();
      const sessions = await sessionStore.list({ projectDir, limit: 1 });
      const lastSession = sessions[0] ?? null;
      const toolChecks = await Promise.all(
        defaultRegistry.list().map(async (name) => {
          const adapter = defaultRegistry.get(name);
          const installed = adapter ? await commandExists(adapter.binary) : false;
          return [`tool:${name}`, installed ? 'available' : 'not installed'] as [string, string];
        }),
      );
      const data: Record<string, string> = {
        project: projectDir,
        ...Object.fromEntries(toolChecks),
        lastReview: lastSession
          ? `${lastSession.tool} · ${lastSession.mode} · ${lastSession.status} · ${lastSession.id}`
          : 'none',
      };
      return { type: 'status', data };
    },
  },
  {
    name: 'memory',
    aliases: ['mem', 'm'],
    description: 'Search project memory for relevant entries',
    usage: '/memory <query>',
    async execute(args, projectDir) {
      const query = positionalArgs(args).join(' ').trim();
      if (!query) return { type: 'error', message: 'Memory search requires a query. Usage: /memory <query>' };
      const { runMemorySearchCommand } = await import('./memory.js');
      const opts: MemorySearchCommandOptions = { project: projectDir, query };
      return wrap(() => runMemorySearchCommand(opts), 'Memory search complete.');
    },
  },
  {
    name: 'handoff',
    aliases: ['ho'],
    description: 'Show the latest handoff document for this project',
    usage: '/handoff',
    async execute(_args, projectDir) {
      const { runHandoffCommand } = await import('./handoff.js');
      const opts: HandoffCommandOptions = { project: projectDir };
      return wrap(() => runHandoffCommand(opts), 'Handoff displayed.');
    },
  },
  {
    name: 'doctor',
    aliases: ['doc', 'dr'],
    description: 'Check tool installation and configuration',
    usage: '/doctor',
    async execute(_args, _projectDir) {
      const { runDoctorCommand } = await import('./doctor.js');
      const opts: DoctorOptions = {};
      return wrap(() => runDoctorCommand(opts), 'Doctor check complete.');
    },
  },
  {
    name: 'gate',
    aliases: ['g'],
    description: 'Check if current diff has been reviewed',
    usage: '/gate',
    async execute(_args, projectDir) {
      const { runGateCommand } = await import('./gate.js');
      const opts: GateCommandOptions = { project: projectDir };
      return wrap(() => runGateCommand(opts), 'Gate check complete.');
    },
  },
  {
    name: 'security',
    aliases: ['sec'],
    description: 'Run a security audit on this project',
    usage: '/security [--scope <auth|api|infra|all>]',
    async execute(args, projectDir) {
      const { runSecurityCommand } = await import('./security.js');
      const opts: SecurityCommandOptions = {
        project: projectDir,
        scope: getFlag(args, 'scope'),
        tool: getFlag(args, 'tool'),
        stream: true,
      };
      return wrap(() => runSecurityCommand(opts), 'Security audit complete.');
    },
  },
  {
    name: 'help',
    aliases: ['h', '?'],
    description: 'List all available REPL commands',
    usage: '/help',
    async execute(_args, _projectDir) {
      const lines = REPL_COMMANDS.map(
        (cmd) =>
          `  ${cmd.usage.padEnd(42)} ${cmd.description}${cmd.aliases.length > 0 ? `  [${cmd.aliases.map((a) => `/${a}`).join(' ')}]` : ''}`,
      );
      return { type: 'text', content: ['Available commands:', ...lines].join('\n') };
    },
  },
  {
    name: 'clear',
    aliases: ['cls'],
    description: 'Clear the terminal output',
    usage: '/clear',
    async execute(_args, _projectDir) {
      process.stdout.write('\x1b[2J\x1b[H');
      return { type: 'success', message: '' };
    },
  },
  {
    name: 'quit',
    aliases: ['exit', 'q'],
    description: 'Exit the REPL',
    usage: '/quit',
    async execute(_args, _projectDir): Promise<ReplResult> {
      return { type: 'success', message: 'Goodbye.' };
    },
  },
];

// ---------------------------------------------------------------------------
// Internal lookup map (name + all aliases → command)
// ---------------------------------------------------------------------------

const commandByName = new Map<string, ReplCommand>();
for (const cmd of REPL_COMMANDS) {
  commandByName.set(cmd.name, cmd);
  for (const alias of cmd.aliases) commandByName.set(alias, cmd);
}

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

export type ParsedReplInput =
  | { kind: 'command'; command: string; args: string[] }
  | { kind: 'shell'; raw: string }
  | { kind: 'implicit-review'; context: string };

export function parseReplInput(input: string): ParsedReplInput {
  const trimmed = input.trim();
  if (trimmed.startsWith('!')) return { kind: 'shell', raw: trimmed.slice(1).trim() };
  if (trimmed.startsWith('/')) {
    const tokens = splitArgs(trimmed.slice(1));
    return { kind: 'command', command: tokens[0] ?? '', args: tokens.slice(1) };
  }
  return { kind: 'implicit-review', context: trimmed };
}

// ---------------------------------------------------------------------------
// Autocomplete
// ---------------------------------------------------------------------------

export interface CommandMatch {
  name: string;
  description: string;
  usage: string;
}

export function matchCommands(partial: string): CommandMatch[] {
  const lower = partial.toLowerCase().replace(/^\//, '');
  if (!lower) return REPL_COMMANDS.map(({ name, description, usage }) => ({ name, description, usage }));
  return REPL_COMMANDS.filter((cmd) => cmd.name.includes(lower) || cmd.aliases.some((a) => a.includes(lower))).map(
    ({ name, description, usage }) => ({ name, description, usage }),
  );
}

// ---------------------------------------------------------------------------
// Main executor
// ---------------------------------------------------------------------------

export async function executeReplCommand(input: string, projectDir?: string): Promise<ReplResult> {
  const resolvedDir = resolveProjectDir(projectDir);
  const parsed = parseReplInput(input);

  if (parsed.kind === 'shell') {
    return { type: 'text', content: `Shell pass-through: ${parsed.raw}\n(Run this in your terminal directly.)` };
  }

  if (parsed.kind === 'implicit-review') {
    return {
      type: 'error',
      message: `Unknown input: "${parsed.context}". Commands start with /. Type /help for a list.`,
    };
  }

  const { command, args } = parsed;
  const cmd = commandByName.get(command);
  if (!cmd) {
    const suggestions = matchCommands(command)
      .slice(0, 3)
      .map((m) => `/${m.name}`)
      .join(', ');
    const hint = suggestions ? ` Did you mean: ${suggestions}?` : '';
    return { type: 'error', message: `Unknown command "/${command}".${hint} Type /help for a list.` };
  }

  return cmd.execute(args, resolvedDir);
}
