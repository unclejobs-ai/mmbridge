import type { MmbridgeConfig } from '@mmbridge/core';
import type { AdapterDefinition } from './types.js';

export class AdapterRegistry {
  private readonly adapters = new Map<string, AdapterDefinition>();

  register(adapter: AdapterDefinition): void {
    this.adapters.set(adapter.name, adapter);
  }

  get(name: string): AdapterDefinition | undefined {
    return this.adapters.get(name);
  }

  has(name: string): boolean {
    return this.adapters.has(name);
  }

  list(): string[] {
    return [...this.adapters.keys()];
  }

  values(): AdapterDefinition[] {
    return [...this.adapters.values()];
  }

  async listInstalled(): Promise<string[]> {
    const { commandExists } = await import('@mmbridge/core');
    const results = await Promise.all(
      this.values().map(async (a) => ({
        name: a.name,
        installed: await commandExists(a.binary).catch(() => false),
      })),
    );
    return results.filter((r) => r.installed).map((r) => r.name);
  }

  async loadFromConfig(config: MmbridgeConfig): Promise<void> {
    const adapterConfigs = config.adapters ?? {};
    for (const [name, cfg] of Object.entries(adapterConfigs)) {
      if (this.has(name)) continue;
      const modulePath = (cfg as Record<string, unknown>).module;
      if (typeof modulePath !== 'string') continue;
      try {
        const mod: Record<string, unknown> = await import(modulePath);
        const candidate = (mod.default ?? mod.adapter) as Record<string, unknown> | undefined;
        if (
          candidate &&
          typeof candidate.name === 'string' &&
          typeof candidate.binary === 'string' &&
          typeof candidate.review === 'function' &&
          typeof candidate.followup === 'function'
        ) {
          const adapter: AdapterDefinition = {
            name: candidate.name,
            binary: candidate.binary,
            review: candidate.review as AdapterDefinition['review'],
            followup: candidate.followup as AdapterDefinition['followup'],
          };
          this.register(adapter);
        }
      } catch (err) {
        process.stderr.write(
          `[mmbridge] Failed to load adapter "${name}" from ${modulePath}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
  }
}
