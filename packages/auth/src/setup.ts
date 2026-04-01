import { createInterface } from 'node:readline';
import { AuthStore } from './store.js';
import { startOAuthFlow } from './oauth.js';

// ─── ANSI helpers ────────────────────────────────────────────────────────────

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

// ─── Provider definitions ────────────────────────────────────────────────────

interface ProviderChoice {
  key: string;
  name: string;
  authType: 'oauth' | 'api-key';
  description: string;
  envVar?: string;
}

const PROVIDERS: ProviderChoice[] = [
  { key: 'anthropic', name: 'Anthropic (Claude)', authType: 'oauth', description: 'OAuth — recommended for Claude Code users', envVar: 'ANTHROPIC_API_KEY' },
  { key: 'openai', name: 'OpenAI (GPT / Codex)', authType: 'oauth', description: 'OAuth — for Codex CLI users', envVar: 'OPENAI_API_KEY' },
  { key: 'kimi', name: 'Moonshot (Kimi)', authType: 'api-key', description: 'API key', envVar: 'KIMI_API_KEY' },
  { key: 'qwen', name: 'Alibaba (Qwen)', authType: 'api-key', description: 'API key', envVar: 'QWEN_API_KEY' },
  { key: 'gemini', name: 'Google (Gemini)', authType: 'api-key', description: 'API key', envVar: 'GEMINI_API_KEY' },
  { key: 'droid', name: 'Droid', authType: 'api-key', description: 'API key' },
];

const MODELS = [
  { key: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', description: 'Fast, capable — recommended' },
  { key: 'claude-opus-4-6', label: 'Claude Opus 4.6', description: 'Most capable, slower' },
  { key: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', description: 'Fastest, lightweight' },
];

// ─── Input helpers ───────────────────────────────────────────────────────────

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

function askSecret(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    if (!process.stdin.setRawMode) { resolve(''); return; }
    process.stdin.setRawMode(true);
    process.stdin.resume();
    let input = '';
    const onData = (chunk: Buffer) => {
      const char = chunk.toString();
      if (char === '\r' || char === '\n') {
        process.stdin.setRawMode?.(false);
        process.stdin.removeListener('data', onData);
        process.stdin.pause();
        process.stdout.write('\n');
        resolve(input);
      } else if (char === '\u0003') {
        process.stdin.setRawMode?.(false);
        process.exit(1);
      } else if (char === '\u007f') {
        input = input.slice(0, -1);
      } else {
        input += char;
        process.stdout.write('*');
      }
    };
    process.stdin.on('data', onData);
  });
}

function selectMenu(title: string, items: Array<{ key: string; label: string; description: string }>): Promise<string> {
  process.stdout.write(`\n${bold(title)}\n\n`);
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item) continue;
    process.stdout.write(`  ${cyan(`${i + 1})`)} ${item.label}  ${dim(item.description)}\n`);
  }
  process.stdout.write('\n');
  return ask(`Select (1-${items.length}): `).then((answer) => {
    const idx = parseInt(answer, 10) - 1;
    return items[idx]?.key ?? items[0]?.key ?? '';
  });
}

// ─── Setup flow ──────────────────────────────────────────────────────────────

export async function runSetup(): Promise<void> {
  const store = new AuthStore();

  process.stdout.write('\n');
  process.stdout.write(`${bold('mmbridge setup')}\n`);
  process.stdout.write(`${dim('Configure your AI providers and default settings')}\n`);
  process.stdout.write('\n');

  // Step 1: Select primary provider
  const providerKey = await selectMenu('Select your primary AI provider:', PROVIDERS.map((p) => ({
    key: p.key,
    label: p.name,
    description: p.description,
  })));

  const provider = PROVIDERS.find((p) => p.key === providerKey);
  if (!provider) { process.stderr.write('Invalid selection.\n'); return; }

  // Step 2: Authenticate
  process.stdout.write(`\n${bold('Authenticating with ' + provider.name + '...')}\n\n`);

  if (provider.authType === 'oauth') {
    // Check if env var has a key first
    const envKey = provider.envVar ? process.env[provider.envVar] : undefined;
    if (envKey) {
      process.stdout.write(`${green('✓')} Found ${provider.envVar} in environment.\n`);
      const useEnv = await ask('Use this key? [Y/n] ');
      if (useEnv.toLowerCase() !== 'n') {
        await store.setApiKey(provider.key, envKey);
        process.stdout.write(`${green('✓')} API key saved.\n`);
      } else {
        await doOAuth(provider.key);
      }
    } else {
      // Use claude setup-token for long-lived OAuth (like Hermes)
      await doClaudeSetupToken(store);
    }
  } else {
    // API key providers
    const envKey = provider.envVar ? process.env[provider.envVar] : undefined;
    if (envKey) {
      process.stdout.write(`${green('✓')} Found ${provider.envVar} in environment.\n`);
      await store.setApiKey(provider.key, envKey);
    } else {
      await doApiKey(store, provider.key);
    }
  }

  // Step 3: Additional providers
  const addMore = await ask('\nConfigure additional providers? [y/N] ');
  if (addMore.toLowerCase() === 'y') {
    const remaining = PROVIDERS.filter((p) => p.key !== providerKey);
    for (const p of remaining) {
      const configure = await ask(`Configure ${p.name}? [y/N] `);
      if (configure.toLowerCase() === 'y') {
        await doApiKey(store, p.key);
      }
    }
  }

  // Step 4: Default model
  const modelKey = await selectMenu('Default model for conversations:', MODELS.map((m) => ({
    key: m.key,
    label: m.label,
    description: m.description,
  })));

  // Step 5: Save config
  process.stdout.write(`\n${bold('Setup complete!')}\n\n`);
  process.stdout.write(`  Provider:  ${green(provider.name)}\n`);
  process.stdout.write(`  Model:     ${green(modelKey)}\n`);
  process.stdout.write(`  Config:    ${dim('~/.mmbridge/auth.json')}\n`);
  process.stdout.write(`\n  Run ${cyan('mmbridge')} to start a conversation.\n\n`);
  process.exit(0);
}

async function doOAuth(provider: string): Promise<void> {
  process.stdout.write('Opening browser for OAuth...\n');
  const result = await startOAuthFlow(provider as 'anthropic' | 'openai');
  if (result.success) {
    process.stdout.write(`${green('✓')} ${result.message}\n`);
  } else {
    process.stderr.write(`${yellow('!')} OAuth failed: ${result.message}\n`);
    process.stdout.write('Falling back to API key entry.\n');
    const store = new AuthStore();
    await doApiKey(store, provider);
  }
}

async function doApiKey(store: AuthStore, provider: string): Promise<void> {
  const key = await askSecret(`Enter API key for ${provider}: `);
  if (!key) {
    process.stdout.write(`${yellow('!')} Skipped ${provider}.\n`);
    return;
  }
  await store.setApiKey(provider, key);
  process.stdout.write(`${green('✓')} API key for ${provider} saved.\n`);
}

async function doClaudeSetupToken(store: AuthStore): Promise<void> {
  process.stdout.write(`\n${bold('Authenticating via Claude Code...')}\n\n`);

  // Check if claude CLI is available
  const { execSync, spawn } = await import('node:child_process');
  try {
    execSync('which claude', { stdio: 'ignore' });
  } catch {
    process.stdout.write(`${yellow('!')} Claude CLI not found. Install it first: ${cyan('npm install -g @anthropic-ai/claude-code')}\n`);
    process.stdout.write('Falling back to API key entry.\n');
    await doApiKey(store, 'anthropic');
    return;
  }

  // Run claude setup-token — it handles the OAuth flow interactively
  process.stdout.write(`Running ${cyan('claude setup-token')}...\n`);
  process.stdout.write(`${dim('A browser window will open. Authorize access, then the token will be saved.')}\n\n`);

  try {
    const child = spawn('claude', ['setup-token'], { stdio: 'inherit' });

    await new Promise<void>((resolve, reject) => {
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`claude setup-token exited with code ${code}`));
      });
      child.on('error', reject);
    });

    process.stdout.write(`\n${bold('Paste the OAuth token shown above.')}\n`);
    process.stdout.write(`${dim('(Paste the full token, then press Enter twice to confirm)')}\n\n`);
    const lines: string[] = [];
    while (true) {
      const line = await ask(lines.length === 0 ? 'Token: ' : '');
      if (!line && lines.length > 0) break; // empty line = done
      if (line) lines.push(line);
    }
    const token = lines.join('').trim();
    if (token) {
      await store.setToken('anthropic', { accessToken: token });
      process.stdout.write(`${green('✓')} OAuth token saved. (${token.length} chars)\n`);
    } else {
      process.stdout.write(`${yellow('!')} No token provided.\n`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(`${yellow('!')} claude setup-token failed: ${msg}\n`);
    await doApiKey(store, 'anthropic');
  }
}

async function doPasteAuth(store: AuthStore, provider: string): Promise<void> {
  process.stdout.write(`\n${bold('Paste authentication')}\n\n`);
  process.stdout.write(`Open this URL in your browser:\n\n`);
  process.stdout.write(`  ${cyan('https://console.anthropic.com/settings/keys')}\n\n`);
  process.stdout.write(`Create a new API key and paste it below.\n`);
  process.stdout.write(`${dim('(Or paste an OAuth token if you have one)')}\n\n`);

  const token = await askSecret('Paste key or token: ');
  if (!token) {
    process.stdout.write(`${yellow('!')} Skipped.\n`);
    return;
  }

  const isOAuth = token.startsWith('sk-ant-oat') || token.startsWith('eyJ');
  if (isOAuth) {
    await store.setToken(provider, { accessToken: token });
    process.stdout.write(`${green('✓')} OAuth token saved.\n`);
  } else {
    await store.setApiKey(provider, token);
    process.stdout.write(`${green('✓')} API key saved.\n`);
  }
}

async function reuseClaudeCode(store: AuthStore): Promise<void> {
  try {
    const { execSync } = await import('node:child_process');
    const raw = execSync(
      'security find-generic-password -s "Claude Code-credentials" -w',
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const oauth = parsed['claudeAiOauth'] as Record<string, unknown> | undefined;
    const token = oauth?.['accessToken'];
    if (typeof token === 'string') {
      await store.setApiKey('anthropic', token);
      process.stdout.write(`${green('✓')} Claude Code OAuth token imported.\n`);
    } else {
      process.stdout.write(`${yellow('!')} Could not find token in Claude Code keychain.\n`);
    }
  } catch {
    process.stdout.write(`${yellow('!')} Claude Code credentials not found in keychain.\n`);
  }
}
