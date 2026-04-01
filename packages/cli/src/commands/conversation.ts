import { AgentLoop, BUILTIN_TOOLS, ToolRegistry, buildSystemPrompt } from '@mmbridge/agent';
import { AuthStore } from '@mmbridge/auth';
import type { AgentEvent } from '@mmbridge/agent';
import { execSync } from 'node:child_process';

export interface ConversationOptions {
  model?: string;
  project?: string;
}

function getGitBranch(projectDir: string): string {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: projectDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function getChangedFiles(projectDir: string): string[] {
  try {
    const output = execSync('git diff --name-only HEAD', {
      cwd: projectDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return output.length > 0 ? output.split('\n').filter((f) => f.length > 0) : [];
  } catch {
    return [];
  }
}

export async function runConversation(options: ConversationOptions): Promise<void> {
  // 1. Get API key from auth store
  const authStore = new AuthStore();
  const state = await authStore.load();
  const providerToken = state.providers['anthropic']?.accessToken;
  const apiKeyEntry = state.apiKeys['anthropic'];
  const token = providerToken ?? apiKeyEntry?.key ?? process.env['ANTHROPIC_API_KEY'];

  if (!token) {
    process.stderr.write('[mmbridge] Not authenticated. Run `mmbridge login` first.\n');
    process.exit(1);
  }

  // 2. Build tool registry with builtin tools
  const registry = new ToolRegistry();
  for (const tool of BUILTIN_TOOLS) {
    registry.register(tool);
  }

  // 3. Get project context
  const projectDir = options.project ?? process.cwd();
  const branch = getGitBranch(projectDir);
  const changedFiles = getChangedFiles(projectDir);

  // 4. Build system prompt
  const systemPrompt = buildSystemPrompt({
    tools: registry.list(),
    projectContext: { branch, changedFiles },
  });

  // 5. Create agent loop
  const agent = new AgentLoop({
    model: options.model ?? 'claude-sonnet-4-6',
    apiKey: token,
    systemPrompt,
    tools: registry.list(),
    maxTurns: 30,
  });

  // 6. Start REPL with readline
  const readline = await import('node:readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '\x1b[32mmmbridge>\x1b[0m ',
  });

  // Show welcome
  process.stdout.write('\x1b[1;35mmmbridge\x1b[0m v2 — conversational multi-model orchestrator\n');
  if (branch.length > 0) {
    process.stdout.write(`Project: ${projectDir}  Branch: ${branch}\n`);
  } else {
    process.stdout.write(`Project: ${projectDir}\n`);
  }
  process.stdout.write('Type naturally or use /help. Ctrl+C to exit.\n\n');
  rl.prompt();

  rl.on('line', async (input: string) => {
    const trimmed = input.trim();
    if (trimmed.length === 0) {
      rl.prompt();
      return;
    }
    if (trimmed === '/quit' || trimmed === '/exit') {
      rl.close();
      return;
    }
    if (trimmed === '/help') {
      process.stdout.write('Just type naturally. mmbridge will use the right tools.\n');
      process.stdout.write('Examples:\n');
      process.stdout.write('  review this PR\n');
      process.stdout.write('  security audit on auth module\n');
      process.stdout.write('  compare approaches for caching\n');
      process.stdout.write('  이 PR 리뷰해줘\n\n');
      process.stdout.write('Slash commands:\n');
      process.stdout.write('  /help    Show this message\n');
      process.stdout.write('  /exit    Exit the REPL\n\n');
      rl.prompt();
      return;
    }

    // Run agent
    try {
      for await (const event of agent.run(trimmed)) {
        renderEvent(event);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stdout.write(`\x1b[31m✗ ${msg}\x1b[0m\n`);
    }
    process.stdout.write('\n');
    rl.prompt();
  });

  rl.on('close', () => {
    process.stdout.write('\nGoodbye.\n');
    process.exit(0);
  });
}

function renderEvent(event: AgentEvent): void {
  switch (event.type) {
    case 'text':
      process.stdout.write(event.text);
      break;
    case 'tool_use':
      process.stdout.write(`\n\x1b[33m● Using ${event.name}...\x1b[0m\n`);
      break;
    case 'tool_result':
      process.stdout.write(`\x1b[32m✓ ${event.name} complete\x1b[0m\n`);
      break;
    case 'error':
      process.stdout.write(`\x1b[31m✗ ${event.error}\x1b[0m\n`);
      break;
    case 'done':
      // Silent — just return to prompt
      break;
  }
}
