import { claudeAdapter } from './claude-adapter.js';
import { codexAdapter } from './codex.js';
import { droidAdapter } from './droid.js';
import { geminiAdapter } from './gemini.js';
import { kimiAdapter } from './kimi.js';
import { qwenAdapter } from './qwen.js';
import { AdapterRegistry } from './registry.js';
import type { AdapterResult, FollowupOptions, ReviewOptions } from './types.js';

export type { ReviewOptions, FollowupOptions, AdapterResult } from './types.js';
export type { AdapterDefinition } from './types.js';
export { AdapterRegistry } from './registry.js';

const defaultRegistry = new AdapterRegistry();
defaultRegistry.register(kimiAdapter);
defaultRegistry.register(qwenAdapter);
defaultRegistry.register(codexAdapter);
defaultRegistry.register(geminiAdapter);
defaultRegistry.register(droidAdapter);
defaultRegistry.register(claudeAdapter);

export { defaultRegistry };

let initializedProjectDir: string | null = null;
let initializationPromise: Promise<AdapterRegistry> | null = null;

export async function initRegistry(projectDir = process.cwd()): Promise<AdapterRegistry> {
  if (initializedProjectDir === projectDir && initializationPromise) {
    return initializationPromise;
  }

  initializedProjectDir = projectDir;
  initializationPromise = (async () => {
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

export async function runReviewAdapter(tool: string, options: ReviewOptions): Promise<AdapterResult> {
  const adapter = defaultRegistry.get(tool);
  if (!adapter) {
    throw new Error(`Unsupported tool: ${tool}. Available: ${defaultRegistry.list().join(', ')}`);
  }
  return adapter.review(options);
}

export async function runFollowupAdapter(tool: string, options: FollowupOptions): Promise<AdapterResult> {
  const adapter = defaultRegistry.get(tool);
  if (!adapter) {
    throw new Error(`Unsupported tool: ${tool}. Available: ${defaultRegistry.list().join(', ')}`);
  }
  return adapter.followup(options);
}
