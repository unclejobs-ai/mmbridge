import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const CATALOG_MAX_AGE_MS = 60 * 60 * 1000;
/** `omp models` usually takes 3–6s but took 12 minutes once while refreshing its remote catalog. */
const CATALOG_TIMEOUT_MS = 60 * 1000;
const CATALOG_MAX_BUFFER = 64 * 1024 * 1024;

/** Authenticated providers as omp sees them, with how many models each exposes. */
export interface Catalog {
  fetchedAt: number;
  providers: Record<string, number>;
}

export interface LoadedCatalog extends Catalog {
  /** True when the refresh failed and an older cache was returned. */
  stale: boolean;
}

function catalogFile(mmbridgeHome: string): string {
  return join(mmbridgeHome, 'catalog.json');
}

function isCatalog(value: unknown): value is Catalog {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Catalog).fetchedAt === 'number' &&
    typeof (value as Catalog).providers === 'object'
  );
}

async function readCachedCatalog(mmbridgeHome: string): Promise<Catalog | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(catalogFile(mmbridgeHome), 'utf8'));
    return isCatalog(parsed) ? parsed : undefined;
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return undefined;
    throw err;
  }
}

async function fetchCatalog(binary: string): Promise<Catalog> {
  const { stdout } = await execFileAsync(binary, ['models', '--json'], {
    timeout: CATALOG_TIMEOUT_MS,
    maxBuffer: CATALOG_MAX_BUFFER,
  });
  const parsed: unknown = JSON.parse(stdout);
  const models = typeof parsed === 'object' && parsed !== null ? (parsed as { models?: unknown }).models : undefined;
  if (!Array.isArray(models)) throw new Error('omp models --json returned no models array');
  const providers: Record<string, number> = {};
  for (const model of models) {
    const provider =
      typeof model === 'object' && model !== null ? (model as { provider?: unknown }).provider : undefined;
    if (typeof provider === 'string') providers[provider] = (providers[provider] ?? 0) + 1;
  }
  return { fetchedAt: Date.now(), providers };
}

export async function loadCatalog(options: {
  mmbridgeHome: string;
  binary?: string;
  refresh?: boolean;
}): Promise<LoadedCatalog> {
  const cached = await readCachedCatalog(options.mmbridgeHome);
  if (cached && !options.refresh && Date.now() - cached.fetchedAt < CATALOG_MAX_AGE_MS)
    return { ...cached, stale: false };
  try {
    const fresh = await fetchCatalog(options.binary ?? 'omp');
    await mkdir(options.mmbridgeHome, { recursive: true });
    const tmp = `${catalogFile(options.mmbridgeHome)}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(fresh, null, 2)}\n`);
    await rename(tmp, catalogFile(options.mmbridgeHome));
    return { ...fresh, stale: false };
  } catch (err) {
    if (cached) return { ...cached, stale: true };
    throw err;
  }
}
