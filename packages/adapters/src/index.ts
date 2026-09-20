import { claudeAdapter } from './claude-adapter.js';
import { codexAdapter } from './codex.js';
import { droidAdapter } from './droid.js';
import { geminiAdapter } from './gemini.js';
import { kimiAdapter } from './kimi.js';
import { piAdapter } from './pi.js';
import { qwenAdapter } from './qwen.js';
import { AdapterRegistry, resolveAdapterCapabilities } from './registry.js';
import type { AdapterDefinition, AdapterResult, FollowupOptions, ReviewOptions, RunOptions } from './types.js';

export type {
  ReviewOptions,
  FollowupOptions,
  RunOptions,
  AdapterResult,
  AdapterCapabilities,
  AdapterRuntimeStatus,
  AdapterDefinition,
} from './types.js';
export { AdapterRegistry, resolveAdapterCapabilities } from './registry.js';

const defaultRegistry = new AdapterRegistry();
const builtinAdapters = [kimiAdapter, piAdapter, qwenAdapter, codexAdapter, geminiAdapter, droidAdapter, claudeAdapter];

function seedBuiltinAdapters(): void {
  defaultRegistry.clear();
  for (const adapter of builtinAdapters) {
    defaultRegistry.register(adapter);
  }
}

seedBuiltinAdapters();

export { defaultRegistry };

let initializedProjectDir: string | null = null;
let initializationPromise: Promise<AdapterRegistry> | null = null;

export async function initRegistry(projectDir = process.cwd(), force = false): Promise<AdapterRegistry> {
  if (!force && initializedProjectDir === projectDir && initializationPromise) {
    return initializationPromise;
  }

  initializedProjectDir = projectDir;
  initializationPromise = (async () => {
    seedBuiltinAdapters();
    try {
      const { loadConfig } = await import('@mmbridge/core');
      const config = await loadConfig(projectDir);
      await defaultRegistry.loadFromConfig(config);
    } catch {
      // Config load failure is non-critical — built-in adapters still work
    }
    return defaultRegistry;
  })();

  return initializationPromise;
}

function getAdapterOrThrow(tool: string): AdapterDefinition {
  const adapter = defaultRegistry.get(tool);
  if (!adapter) {
    throw new Error(`Unsupported tool: ${tool}. Available: ${defaultRegistry.list().join(', ')}`);
  }
  return adapter;
}

export async function runReviewAdapter(tool: string, options: ReviewOptions): Promise<AdapterResult> {
  return getAdapterOrThrow(tool).review(options);
}

export async function runFollowupAdapter(tool: string, options: FollowupOptions): Promise<AdapterResult> {
  return getAdapterOrThrow(tool).followup(options);
}

export async function runTaskAdapter(tool: string, options: RunOptions): Promise<AdapterResult> {
  const adapter = getAdapterOrThrow(tool);
  const capabilities = resolveAdapterCapabilities(adapter);
  if (!options.readonly || !adapter.run || !capabilities.readOnly) {
    throw new Error(`Adapter "${tool}" does not support declared read-only task runs`);
  }
  return adapter.run({ ...options, binary: adapter.binary });
}
