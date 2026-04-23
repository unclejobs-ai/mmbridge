import { createHash, randomBytes } from 'node:crypto';
import { getEphemeralPort, isTokenResponse, openBrowser, waitForCallback } from './oauth-helpers.js';
import { AuthStore } from './store.js';
import type { AuthProvider, ProviderTokens } from './types.js';

// Claude AI subscriber OAuth (grants user:inference scope)
const PROVIDER_AUTH_URLS: Record<string, string> = {
  anthropic: 'https://claude.com/cai/oauth/authorize',
  openai: 'https://auth.openai.com/authorize',
};

const PROVIDER_TOKEN_URLS: Record<string, string> = {
  anthropic: 'https://platform.claude.com/v1/oauth/token',
  openai: 'https://auth.openai.com/oauth/token',
};

// Claude Code's registered OAuth client ID
const DEFAULT_CLIENT_IDS: Record<string, string> = {
  anthropic: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  openai: 'app_EMoamEEZ73f0CkXaXp7hrann',
};

function getClientId(provider: string): string {
  const envKey = `MMBRIDGE_${provider.toUpperCase()}_CLIENT_ID`;
  return process.env[envKey] ?? DEFAULT_CLIENT_IDS[provider] ?? '';
}

async function exchangeCodeForTokens(
  provider: string,
  code: string,
  codeVerifier: string,
  redirectUri: string,
  state: string,
): Promise<ProviderTokens> {
  const tokenUrl = PROVIDER_TOKEN_URLS[provider];
  if (!tokenUrl) {
    throw new Error(`Unknown provider: ${provider}`);
  }

  const body = {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: getClientId(provider),
    code_verifier: codeVerifier,
    state,
  };

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token exchange failed (${response.status}): ${text}`);
  }

  const data: unknown = await response.json();
  if (!isTokenResponse(data)) {
    throw new Error('Unexpected token response shape');
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: data.expires_in !== undefined ? Date.now() + data.expires_in * 1000 : undefined,
  };
}

export async function startOAuthFlow(provider: 'anthropic' | 'openai'): Promise<{ success: boolean; message: string }> {
  const authUrl = PROVIDER_AUTH_URLS[provider];
  if (!authUrl) {
    return { success: false, message: `Unsupported provider: ${provider}` };
  }

  const state = randomBytes(16).toString('hex');
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

  const port = await getEphemeralPort();
  const redirectUri = `http://localhost:${port}/callback`;

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: getClientId(provider),
    redirect_uri: redirectUri,
    scope:
      provider === 'anthropic'
        ? 'user:inference user:profile org:create_api_key user:sessions:claude_code user:mcp_servers user:file_upload'
        : 'openid profile email offline_access',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  await openBrowser(`${authUrl}?${params.toString()}`);

  try {
    const { code } = await waitForCallback(port, state);
    const tokens = await exchangeCodeForTokens(provider, code, codeVerifier, redirectUri, state);
    const store = new AuthStore();
    await store.setToken(provider, tokens);

    // For Anthropic: exchange OAuth token for an API key (Messages API requires x-api-key)
    if (provider === 'anthropic') {
      const apiKey = await createApiKeyFromOAuth(tokens.accessToken);
      if (apiKey) {
        await store.setApiKey('anthropic', apiKey);
      }
    }

    return { success: true, message: `Logged in to ${provider} successfully` };
  } catch (err) {
    return {
      success: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

async function createApiKeyFromOAuth(accessToken: string): Promise<string | null> {
  try {
    const response = await fetch('https://api.anthropic.com/api/oauth/claude_cli/create_api_key', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { raw_key?: string };
    return data.raw_key ?? null;
  } catch {
    return null;
  }
}

export async function refreshToken(provider: AuthProvider, storedRefreshToken: string): Promise<ProviderTokens> {
  const tokenUrl = PROVIDER_TOKEN_URLS[provider];
  if (!tokenUrl) {
    throw new Error(`Cannot refresh token for provider: ${provider}`);
  }

  const body = {
    grant_type: 'refresh_token',
    refresh_token: storedRefreshToken,
    client_id: getClientId(provider),
  };

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token refresh failed (${response.status}): ${text}`);
  }

  const data: unknown = await response.json();
  if (!isTokenResponse(data)) {
    throw new Error('Unexpected token response shape during refresh');
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? storedRefreshToken,
    expiresAt: data.expires_in !== undefined ? Date.now() + data.expires_in * 1000 : undefined,
  };
}
