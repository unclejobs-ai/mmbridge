import type { WorkerEventListener } from './events.js';
import { readHealth, recordCooldown } from './health.js';
import { type OmpPromptResult, OmpTimeoutError, runOmpPrompt } from './omp-worker.js';
import {
  DEFAULT_MMBRIDGE_HOME,
  DEFAULT_OMP_CONFIG_PATH,
  type ModelRef,
  type Role,
  parseModelRef,
  resolveRoleChain,
} from './roles.js';

const ROLE_BRIEF: Record<Role, string> = {
  worker: 'You are the worker: implement the task precisely and report what you changed.',
  scout: 'You are the scout: investigate quickly and report findings. Do not propose large changes.',
  reviewer:
    'You are the reviewer, a different model cross-checking another model’s work. Be specific and adversarial: list concrete defects with evidence, or say plainly that you found none.',
  designer: 'You are the designer: critique and propose UI/UX and visual design with concrete, actionable changes.',
};

const QUOTA_ERROR = /usage.?limit|rate.?limit|quota|\b429\b|too many requests/i;
/** Cooldown when a provider reports a quota error without saying how long to wait. */
const DEFAULT_QUOTA_COOLDOWN_MS = 5 * 60 * 1000;
/** Auth/plan errors don't clear on their own; retry the provider hourly rather than on every dispatch. */
const ACCESS_ERROR = /\b40[13]\b|permission_error|unauthori[sz]ed|does not have access/i;
const ACCESS_COOLDOWN_MS = 60 * 60 * 1000;

function cooldownMs(result: OmpPromptResult): number | undefined {
  if (!result.errorMessage) return undefined;
  if (QUOTA_ERROR.test(result.errorMessage)) return result.waitMs ?? DEFAULT_QUOTA_COOLDOWN_MS;
  if (ACCESS_ERROR.test(result.errorMessage)) return ACCESS_COOLDOWN_MS;
  return undefined;
}

export interface DispatchInput {
  role: Role;
  task: string;
  cwd: string;
  /** Pin one model as `provider/model[:thinking]`: no fallback, cooldowns ignored. */
  model?: string;
  timeoutMs?: number;
  /** omp config to seed role defaults from. */
  ompConfigPath?: string;
  /** mmbridge state directory (`roles.json`, `provider-health.json`). */
  mmbridgeHome?: string;
  /** omp executable; overridable for tests. */
  binary?: string;
  /** Skip these providers (e.g. the worker's, so a reviewer comes from a different model family). */
  excludeProviders?: string[];
  /** Give the worker omp's file tools with auto-approval. Only for an isolated cwd (a dedicated git worktree). */
  tools?: boolean;
  /** Live view of the run, including which model in the chain is running and how earlier ones ended. */
  onEvent?: WorkerEventListener;
}

export interface Attempt {
  provider: string;
  modelId: string;
  outcome: 'ok' | 'error' | 'skipped';
  errorMessage?: string;
  totalMs?: number;
}

export interface DispatchResult extends OmpPromptResult {
  role: Role;
  attempts: Attempt[];
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Runs the task on the first model in the role's chain that answers, cooling down providers that hit quota. */
export async function dispatch(input: DispatchInput): Promise<DispatchResult> {
  const home = input.mmbridgeHome ?? DEFAULT_MMBRIDGE_HOME;
  const pinned = input.model !== undefined;
  const excluded = new Set(input.excludeProviders ?? []);
  const chain: ModelRef[] = input.model
    ? [parseModelRef(input.model)]
    : (
        await resolveRoleChain(input.role, {
          ompConfigPath: input.ompConfigPath ?? DEFAULT_OMP_CONFIG_PATH,
          mmbridgeHome: home,
        })
      ).filter((ref) => !excluded.has(ref.provider));
  if (chain.length === 0) {
    throw new Error(`Every model for role "${input.role}" is from an excluded provider (${[...excluded].join(', ')})`);
  }
  const health = await readHealth(home);
  const attempts: Attempt[] = [];
  const record = (attempt: Attempt) => {
    attempts.push(attempt);
    input.onEvent?.({ type: 'attempt', attempt });
  };
  let lastFailure: OmpPromptResult | undefined;

  for (const model of chain) {
    const target = { provider: model.provider, modelId: model.modelId };
    const cooldown = health[model.provider];
    if (!pinned && cooldown && cooldown.until > Date.now()) {
      const until = new Date(cooldown.until).toISOString();
      record({ ...target, outcome: 'skipped', errorMessage: `cooling down until ${until}: ${cooldown.reason}` });
      continue;
    }

    input.onEvent?.({ type: 'model', ...target });
    let result: OmpPromptResult;
    try {
      result = await runOmpPrompt({
        model,
        prompt: `${ROLE_BRIEF[input.role]}\n\n${input.task}`,
        cwd: input.cwd,
        ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
        ...(input.binary ? { binary: input.binary } : {}),
        ...(input.tools ? { tools: true } : {}),
        ...(input.onEvent ? { onEvent: input.onEvent } : {}),
      });
    } catch (err) {
      // A timeout means the model was working, just slowly — retrying elsewhere would double the wait.
      if (err instanceof OmpTimeoutError) throw err;
      record({ ...target, outcome: 'error', errorMessage: errorText(err) });
      continue;
    }

    if (result.stopReason !== 'error') {
      record({ ...target, outcome: 'ok', totalMs: result.totalMs });
      return { role: input.role, ...result, attempts };
    }
    record({
      ...target,
      outcome: 'error',
      totalMs: result.totalMs,
      ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
    });
    lastFailure = result;
    const coolFor = cooldownMs(result);
    if (coolFor !== undefined && result.errorMessage) {
      await recordCooldown(home, model.provider, { until: Date.now() + coolFor, reason: result.errorMessage });
    }
  }

  if (lastFailure) return { role: input.role, ...lastFailure, attempts };
  const summary = attempts.map((a) => `${a.provider}/${a.modelId}: ${a.errorMessage ?? a.outcome}`).join('; ');
  throw new Error(`No model could run role "${input.role}" — ${summary}`);
}
