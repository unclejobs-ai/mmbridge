import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface Cooldown {
  /** Epoch ms until which the provider should not be dispatched to. */
  until: number;
  reason: string;
}

export type ProviderHealth = Record<string, Cooldown>;

function healthFile(mmbridgeHome: string): string {
  return join(mmbridgeHome, 'provider-health.json');
}

function isCooldown(value: unknown): value is Cooldown {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Cooldown).until === 'number' &&
    typeof (value as Cooldown).reason === 'string'
  );
}

export async function readHealth(mmbridgeHome: string): Promise<ProviderHealth> {
  let raw: string;
  try {
    raw = await readFile(healthFile(mmbridgeHome), 'utf8');
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return {};
    throw err;
  }
  const parsed: unknown = JSON.parse(raw);
  const health: ProviderHealth = {};
  if (typeof parsed === 'object' && parsed !== null) {
    for (const [provider, entry] of Object.entries(parsed)) {
      if (isCooldown(entry)) health[provider] = entry;
    }
  }
  return health;
}

export async function recordCooldown(mmbridgeHome: string, provider: string, cooldown: Cooldown): Promise<void> {
  const health = await readHealth(mmbridgeHome);
  health[provider] = cooldown;
  await mkdir(mmbridgeHome, { recursive: true });
  const tmp = `${healthFile(mmbridgeHome)}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(health, null, 2)}\n`);
  await rename(tmp, healthFile(mmbridgeHome));
}
