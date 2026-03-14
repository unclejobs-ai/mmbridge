import type { AdapterDefinition } from './types.js';
import type { MmbridgeConfig } from '@mmbridge/core';

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

  async loadFromConfig(config: MmbridgeConfig): Promise<void> {
    const adapterConfigs = config.adapters ?? {};
    for (const [name, cfg] of Object.entries(adapterConfigs)) {
      if (this.has(name)) continue;
      const modulePath = (cfg as Record<string, unknown>).module;
      if (typeof modulePath !== 'string') continue;
      try {
        const mod: Record<string, unknown> = await import(modulePath);
        const adapter = (mod.default ?? mod.adapter) as AdapterDefinition | undefined;
        if (
          adapter?.name &&
          typeof adapter.review === 'function' &&
          typeof adapter.followup === 'function'
        ) {
          this.register(adapter);
        }
      } catch {
        // skip adapters that fail to load — non-fatal
      }
    }
  }
}
