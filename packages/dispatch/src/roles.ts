import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';

export const ROLES = ['worker', 'scout', 'reviewer', 'designer'] as const;
export type Role = (typeof ROLES)[number];

/** mmbridge role → omp `modelRoles` key used to seed the default model. */
const OMP_ROLE: Record<Role, string> = {
  worker: 'task',
  scout: 'smol',
  reviewer: 'advisor',
  designer: 'designer',
};

const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'auto']);

export const DEFAULT_OMP_CONFIG_PATH = join(homedir(), '.omp', 'agent', 'config.yml');

export interface ModelRef {
  provider: string;
  modelId: string;
  thinking?: string;
}

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/** Parses omp's `provider/model[:thinking]` selector. Model ids may themselves contain `/` or `:`. */
export function parseModelRef(selector: string): ModelRef {
  const slash = selector.indexOf('/');
  if (slash <= 0 || slash === selector.length - 1) {
    throw new Error(`Invalid model selector "${selector}" — expected provider/model[:thinking]`);
  }
  const provider = selector.slice(0, slash);
  let modelId = selector.slice(slash + 1);
  let thinking: string | undefined;
  const colon = modelId.lastIndexOf(':');
  if (colon > 0 && THINKING_LEVELS.has(modelId.slice(colon + 1))) {
    thinking = modelId.slice(colon + 1);
    modelId = modelId.slice(0, colon);
  }
  return thinking ? { provider, modelId, thinking } : { provider, modelId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const DEFAULT_MMBRIDGE_HOME = join(homedir(), '.mmbridge');

export interface RoleSources {
  /** omp config to seed defaults from (`modelRoles`, `retry.fallbackChains`). */
  ompConfigPath?: string;
  /** Directory holding mmbridge's own `roles.json`. */
  mmbridgeHome?: string;
}

interface RoleTable {
  roles: Partial<Record<Role, string[]>>;
  deny: string[];
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

/** `~/.mmbridge/roles.json`: `{ "roles": { "<role>": ["provider/model[:thinking]", ...] }, "deny": ["xai/"] }` */
async function readRoleTable(mmbridgeHome: string): Promise<RoleTable> {
  const file = join(mmbridgeHome, 'roles.json');
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') return { roles: {}, deny: [] };
    throw err;
  }
  const parsed: unknown = JSON.parse(raw);
  const roles: Partial<Record<Role, string[]>> = {};
  if (isRecord(parsed) && isRecord(parsed.roles)) {
    for (const role of ROLES) {
      const chain = parsed.roles[role];
      if (chain === undefined) continue;
      if (!isStringArray(chain)) throw new Error(`${file}: roles.${role} must be an array of model selectors`);
      roles[role] = chain;
    }
  }
  const deny = isRecord(parsed) ? parsed.deny : undefined;
  if (deny !== undefined && !isStringArray(deny))
    throw new Error(`${file}: deny must be an array of selector prefixes`);
  return { roles, deny: deny ?? [] };
}

/** omp seed: the role's model, omp's fallback chain for that model, then omp's default model. */
async function ompSeed(role: Role, ompConfigPath: string): Promise<string[]> {
  const config: unknown = parse(await readFile(ompConfigPath, 'utf8'));
  const modelRoles = isRecord(config) && isRecord(config.modelRoles) ? config.modelRoles : {};
  const primary = modelRoles[OMP_ROLE[role]];
  if (typeof primary !== 'string') {
    throw new Error(`No model configured for role "${role}" (omp modelRoles.${OMP_ROLE[role]} in ${ompConfigPath})`);
  }
  const { provider, modelId } = parseModelRef(primary);
  const retry = isRecord(config) && isRecord(config.retry) ? config.retry : {};
  const chains = isRecord(retry.fallbackChains) ? retry.fallbackChains : {};
  const chain = chains[`${provider}/${modelId}`];
  const fallback = modelRoles.default;
  return [primary, ...(isStringArray(chain) ? chain : []), ...(typeof fallback === 'string' ? [fallback] : [])];
}

/** Ordered candidate models for a role, deduplicated, with denied providers removed. */
export async function resolveRoleChain(role: Role, sources: RoleSources = {}): Promise<ModelRef[]> {
  const table = await readRoleTable(sources.mmbridgeHome ?? DEFAULT_MMBRIDGE_HOME);
  const selectors = table.roles[role] ?? (await ompSeed(role, sources.ompConfigPath ?? DEFAULT_OMP_CONFIG_PATH));
  const seen = new Set<string>();
  const chain: ModelRef[] = [];
  for (const selector of selectors) {
    const ref = parseModelRef(selector);
    const key = `${ref.provider}/${ref.modelId}`;
    if (seen.has(key) || table.deny.some((prefix) => key.startsWith(prefix))) continue;
    seen.add(key);
    chain.push(ref);
  }
  if (chain.length === 0) throw new Error(`Every model for role "${role}" is denied by roles.json`);
  return chain;
}
