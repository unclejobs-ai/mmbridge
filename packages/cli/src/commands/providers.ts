import os from 'node:os';
import path from 'node:path';
import { jsonOutput } from './helpers.js';

export interface ProvidersCommandOptions {
  json?: boolean;
  refresh?: boolean;
}

type Status = 'ready' | 'cooling-down' | 'not-authenticated';

export async function runProvidersCommand(options: ProvidersCommandOptions): Promise<void> {
  const { ROLES, loadCatalog, readHealth, resolveRoleChain } = await import('@mmbridge/dispatch');
  const mmbridgeHome = path.join(os.homedir(), '.mmbridge');
  const [catalog, health] = await Promise.all([
    loadCatalog({ mmbridgeHome, ...(options.refresh ? { refresh: true } : {}) }),
    readHealth(mmbridgeHome),
  ]);
  const now = Date.now();
  const statusOf = (provider: string): Status => {
    if (!(provider in catalog.providers)) return 'not-authenticated';
    const cooldown = health[provider];
    return cooldown && cooldown.until > now ? 'cooling-down' : 'ready';
  };

  const providers = Object.entries(catalog.providers)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([provider, models]) => {
      const cooldown = health[provider];
      return {
        provider,
        models,
        status: statusOf(provider),
        ...(cooldown && cooldown.until > now ? { coolingDownUntil: new Date(cooldown.until).toISOString() } : {}),
      };
    });
  const roles = await Promise.all(
    ROLES.map(async (role) => ({
      role,
      chain: (await resolveRoleChain(role, { mmbridgeHome })).map((ref) => ({
        model: `${ref.provider}/${ref.modelId}${ref.thinking ? `:${ref.thinking}` : ''}`,
        status: statusOf(ref.provider),
      })),
    })),
  );

  if (options.json) {
    jsonOutput({ catalogFetchedAt: new Date(catalog.fetchedAt).toISOString(), stale: catalog.stale, providers, roles });
    return;
  }

  const age = Math.round((now - catalog.fetchedAt) / 60_000);
  const lines = [`Providers (via omp, fetched ${age}m ago${catalog.stale ? ', STALE — omp refresh failed' : ''})`];
  const width = Math.max(...providers.map((p) => p.provider.length));
  for (const p of providers) {
    const note = p.coolingDownUntil ? `  cooling down until ${p.coolingDownUntil}` : '';
    lines.push(`  ${p.provider.padEnd(width)}  ${String(p.models).padStart(4)} models${note}`);
  }
  const mark: Record<Status, string> = {
    ready: '',
    'cooling-down': ' (cooling down)',
    'not-authenticated': ' (not authenticated)',
  };
  lines.push('', 'Roles (first ready model wins)');
  for (const { role, chain } of roles) {
    lines.push(`  ${role.padEnd(8)}  ${chain.map((c) => `${c.model}${mark[c.status]}`).join(' → ')}`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}
