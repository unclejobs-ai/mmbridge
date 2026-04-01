import { randomBytes, createHash } from 'node:crypto';
import { AuthStore } from './store.js';
import {
  waitForCallback,
  getEphemeralPort,
  openBrowser,
  isTokenResponse,
} from './oauth-helpers.js';
import type { AuthProvider, ProviderTokens } from './types.js';

const PROVIDER_AUTH_URLS: Record<string, string> = {
  anthropic: 'https://console.anthropic.com/oauth/authorize',
  openai: 'https://auth.openai.com/authorize',
};

const PROVIDER_TOKEN_URLS: Record<string, string> = {
  anthropic: 'https://console.anthropic.com/oauth/token',
  openai: 'https://auth.openai.com/oauth/token',
};

const DEFAULT_CLIENT_IDS: Record<string, string> = {
  anthropic: 'mmbridge-anthropic-placeholder',
  openai: 'mmbridge-openai-placeholder',
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
): Promise<ProviderTokens> {
  const tokenUrl = PROVIDER_TOKEN_URLS[provider];
  if (!tokenUrl) {
    throw new Error(`Unknown provider: ${provider}`);
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: getClientId(provider),
    code_verifier: codeVerifier,
  });

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
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
    expiresAt:
      data.expires_in !== undefined
        ? Date.now() + data.expires_in * 1000
        : undefined,
  };
}

export async function startOAuthFlow(
  provider: 'anthropic' | 'openai',
): Promise<{ success: boolean; message: string }> {
  const authUrl = PROVIDER_AUTH_URLS[provider];
  if (!authUrl) {
    return { success: false, message: `Unsupported provider: ${provider}` };
  }

  const state = randomBytes(16).toString('hex');
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');

  const port = await getEphemeralPort();
  const redirectUri = `http://localhost:${port}/callback`;

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: getClientId(provider),
    redirect_uri: redirectUri,
    scope: 'openid profile email',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  await openBrowser(`${authUrl}?${params.toString()}`);

  try {
    const { code } = await waitForCallback(port, state);
    const tokens = await exchangeCodeForTokens(provider, code, codeVerifier, redirectUri);
    await new AuthStore().setToken(provider, tokens);
    return { success: true, message: `Logged in to ${provider} successfully` };
  } catch (err) {
    return {
      success: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function refreshToken(
  provider: AuthProvider,
  storedRefreshToken: string,
): Promise<ProviderTokens> {
  const tokenUrl = PROVIDER_TOKEN_URLS[provider];
  if (!tokenUrl) {
    throw new Error(`Cannot refresh token for provider: ${provider}`);
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: storedRefreshToken,
    client_id: getClientId(provider),
  });

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
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
    expiresAt:
      data.expires_in !== undefined
        ? Date.now() + data.expires_in * 1000
        : undefined,
  };
}
