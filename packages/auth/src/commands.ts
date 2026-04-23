import { createInterface } from 'node:readline';
import { startOAuthFlow } from './oauth.js';
import { AuthStore } from './store.js';
import type { AuthProvider } from './types.js';

const SUPPORTED_OAUTH_PROVIDERS = ['anthropic', 'openai'] as const;
type OAuthProvider = (typeof SUPPORTED_OAUTH_PROVIDERS)[number];

function isOAuthProvider(value: string): value is OAuthProvider {
  return (SUPPORTED_OAUTH_PROVIDERS as readonly string[]).includes(value);
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function promptSecret(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    process.stdout.write(question);
    process.stdin.setRawMode?.(true);
    let input = '';
    process.stdin.on('data', function onData(chunk: Buffer) {
      const char = chunk.toString();
      if (char === '\r' || char === '\n') {
        process.stdin.setRawMode?.(false);
        process.stdin.removeListener('data', onData);
        process.stdout.write('\n');
        rl.close();
        resolve(input);
      } else if (char === '\u0003') {
        process.stdin.setRawMode?.(false);
        process.exit(1);
      } else if (char === '\u007f') {
        input = input.slice(0, -1);
      } else {
        input += char;
      }
    });
  });
}

export async function login(provider?: string): Promise<void> {
  const store = new AuthStore();
  let selectedProvider = provider;

  if (!selectedProvider) {
    const answer = await prompt('Provider to log in (anthropic, openai, or a name for an API key): ');
    selectedProvider = answer.toLowerCase();
  }

  if (isOAuthProvider(selectedProvider)) {
    process.stdout.write(`Starting OAuth flow for ${selectedProvider}...\n`);
    process.stdout.write('A browser window will open. Complete the authorization there.\n');
    const result = await startOAuthFlow(selectedProvider);
    if (result.success) {
      process.stdout.write(`${result.message}\n`);
    } else {
      process.stderr.write(`Login failed: ${result.message}\n`);
      process.exit(1);
    }
  } else {
    // API key flow
    const apiKey = await promptSecret(`Enter API key for ${selectedProvider}: `);
    if (!apiKey) {
      process.stderr.write('No API key provided. Aborting.\n');
      process.exit(1);
    }
    await store.setApiKey(selectedProvider, apiKey);
    process.stdout.write(`API key for ${selectedProvider} saved.\n`);
  }
}

export async function logout(provider?: string): Promise<void> {
  const store = new AuthStore();
  let selectedProvider = provider;

  if (!selectedProvider) {
    const answer = await prompt('Provider to log out (leave blank to log out of all): ');
    selectedProvider = answer.toLowerCase() || undefined;
  }

  if (!selectedProvider) {
    const confirm = await prompt('Remove ALL credentials? [y/N] ');
    if (confirm.toLowerCase() !== 'y') {
      process.stdout.write('Aborted.\n');
      return;
    }
    await store.clear();
    process.stdout.write('All credentials removed.\n');
    return;
  }

  await store.removeProvider(selectedProvider);
  process.stdout.write(`Credentials for ${selectedProvider} removed.\n`);
}

export async function status(): Promise<void> {
  const store = new AuthStore();
  const state = await store.load();

  const providerEntries = Object.entries(state.providers);
  const apiKeyEntries = Object.entries(state.apiKeys);

  if (providerEntries.length === 0 && apiKeyEntries.length === 0) {
    process.stdout.write('Not authenticated. Run `mmbridge auth login` to get started.\n');
    return;
  }

  process.stdout.write('Authentication status:\n\n');

  if (providerEntries.length > 0) {
    process.stdout.write('OAuth providers:\n');
    for (const [name, tokens] of providerEntries) {
      const expiry =
        tokens.expiresAt !== undefined
          ? tokens.expiresAt < Date.now()
            ? ' (EXPIRED)'
            : ` (expires ${new Date(tokens.expiresAt).toLocaleString()})`
          : ' (no expiry)';
      process.stdout.write(`  ${name}${expiry}\n`);
    }
    process.stdout.write('\n');
  }

  if (apiKeyEntries.length > 0) {
    process.stdout.write('API keys:\n');
    for (const [name] of apiKeyEntries) {
      process.stdout.write(`  ${name}: configured\n`);
    }
    process.stdout.write('\n');
  }

  process.stdout.write(`Active provider: ${state.activeProvider}\n`);
  process.stdout.write(`Last updated: ${state.updatedAt}\n`);
}

export async function whoami(): Promise<void> {
  const store = new AuthStore();
  const state = await store.load();
  const provider = state.activeProvider as AuthProvider;

  if (provider === 'api-key') {
    const keyCount = Object.keys(state.apiKeys).length;
    if (keyCount === 0) {
      process.stdout.write('No API keys configured.\n');
    } else {
      process.stdout.write(`Using API keys. Configured providers: ${Object.keys(state.apiKeys).join(', ')}\n`);
    }
    return;
  }

  const tokens = state.providers[provider];
  if (!tokens) {
    process.stdout.write(`Not authenticated with ${provider}.\n`);
    return;
  }

  if (tokens.accountId) {
    process.stdout.write(`Authenticated as ${tokens.accountId} via ${provider}\n`);
  } else {
    process.stdout.write(`Authenticated via ${provider}\n`);
  }

  if (tokens.expiresAt !== undefined && tokens.expiresAt < Date.now()) {
    process.stdout.write(`Warning: token expired at ${new Date(tokens.expiresAt).toLocaleString()}\n`);
  }
}
