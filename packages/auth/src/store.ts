import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ApiKeyEntry, AuthState, ProviderTokens } from './types.js';

const AUTH_STATE_VERSION = 1;
const FILE_MODE = 0o600;

function getAuthPath(): string {
  return join(homedir(), '.mmbridge', 'auth.json');
}

function defaultState(): AuthState {
  return {
    version: AUTH_STATE_VERSION,
    activeProvider: 'api-key',
    providers: {},
    apiKeys: {},
    updatedAt: new Date().toISOString(),
  };
}

export class AuthStore {
  private readonly authPath: string;

  constructor(authPath?: string) {
    this.authPath = authPath ?? getAuthPath();
  }

  async load(): Promise<AuthState> {
    try {
      const raw = await readFile(this.authPath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      if (!isAuthState(parsed)) {
        return defaultState();
      }
      return parsed;
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        return defaultState();
      }
      throw new Error(`Failed to read auth state: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async save(state: AuthState): Promise<void> {
    const dir = dirname(this.authPath);
    await mkdir(dir, { recursive: true });

    const tmpPath = `${this.authPath}.tmp`;
    const updated: AuthState = { ...state, updatedAt: new Date().toISOString() };
    const content = JSON.stringify(updated, null, 2);

    try {
      await writeFile(tmpPath, content, { encoding: 'utf-8', mode: FILE_MODE });
      await chmod(tmpPath, FILE_MODE);
      await rename(tmpPath, this.authPath);
      await chmod(this.authPath, FILE_MODE);
    } catch (err) {
      try {
        await unlink(tmpPath);
      } catch {
        // ignore cleanup errors
      }
      throw new Error(`Failed to save auth state: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async getToken(provider: string): Promise<ProviderTokens | null> {
    const state = await this.load();
    const tokens = state.providers[provider];
    if (!tokens) return null;

    if (tokens.expiresAt !== undefined && tokens.expiresAt < Date.now()) {
      return null;
    }

    return tokens;
  }

  async setToken(provider: string, tokens: ProviderTokens): Promise<void> {
    const state = await this.load();
    state.providers[provider] = tokens;
    await this.save(state);
  }

  async setApiKey(name: string, key: string): Promise<void> {
    const state = await this.load();
    state.apiKeys[name] = { key, provider: name };
    await this.save(state);
  }

  async getApiKey(name: string): Promise<ApiKeyEntry | null> {
    const state = await this.load();
    return state.apiKeys[name] ?? null;
  }

  async removeProvider(provider: string): Promise<void> {
    const state = await this.load();
    delete state.providers[provider];
    delete state.apiKeys[provider];
    await this.save(state);
  }

  async clear(): Promise<void> {
    try {
      await unlink(this.authPath);
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') return;
      throw new Error(`Failed to clear auth state: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function isAuthState(value: unknown): value is AuthState {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.version === 'number' &&
    typeof obj.activeProvider === 'string' &&
    typeof obj.providers === 'object' &&
    obj.providers !== null &&
    typeof obj.apiKeys === 'object' &&
    obj.apiKeys !== null &&
    typeof obj.updatedAt === 'string'
  );
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}
