export type AuthProvider = 'anthropic' | 'openai' | 'api-key';

export interface ProviderTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  accountId?: string;
}

export interface ApiKeyEntry {
  key: string;
  provider: string; // kimi, qwen, gemini, etc.
}

export interface AuthState {
  version: number;
  activeProvider: AuthProvider;
  providers: Record<string, ProviderTokens>;
  apiKeys: Record<string, ApiKeyEntry>;
  updatedAt: string;
}
