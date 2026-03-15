import { claudeAdapter } from './claude-adapter.js';
import { codexAdapter } from './codex.js';
import { droidAdapter } from './droid.js';
import { geminiAdapter } from './gemini.js';
import { kimiAdapter } from './kimi.js';
import { qwenAdapter } from './qwen.js';
import { AdapterRegistry } from './registry.js';
import type { AdapterDefinition, AdapterResult, FollowupOptions, ReviewOptions } from './types.js';

export type { ReviewOptions, FollowupOptions, AdapterResult } from './types.js';
export type { AdapterDefinition } from './types.js';
export { AdapterRegistry } from './registry.js';

const defaultRegistry = new AdapterRegistry();
const builtinAdapters = [kimiAdapter, qwenAdapter, codexAdapter, geminiAdapter, droidAdapter, claudeAdapter];

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
