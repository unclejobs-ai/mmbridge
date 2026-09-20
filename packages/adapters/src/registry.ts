import type { MmbridgeConfig } from '@mmbridge/core';
import type { AdapterCapabilities, AdapterDefinition, AdapterRuntimeStatus } from './types.js';

export function resolveAdapterCapabilities(adapter: AdapterDefinition): AdapterCapabilities {
  return {
    run: typeof adapter.run === 'function',
    readOnly: typeof adapter.run === 'function' && adapter.capabilities?.readOnly === true,
    followup: adapter.capabilities?.followup === true,
  };
}

export class AdapterRegistry {
  private readonly adapters = new Map<string, AdapterDefinition>();

  clear(): void {
    this.adapters.clear();
  }

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
    const statuses = await this.listRuntimeStatuses();
    return statuses.filter((runtime) => runtime.installed).map((runtime) => runtime.name);
  }

  async listRuntimeStatuses(): Promise<AdapterRuntimeStatus[]> {
    const { commandExists } = await import('@mmbridge/core');
    return Promise.all(
      this.values().map(async (adapter) => ({
        name: adapter.name,
        binary: adapter.binary,
        installed: await commandExists(adapter.binary).catch(() => false),
        authentication: 'unknown' as const,
        health: 'unknown' as const,
        capabilities: resolveAdapterCapabilities(adapter),
      })),
    );
  }

  async loadFromConfig(config: MmbridgeConfig): Promise<void> {
    const adapterConfigs = config.adapters ?? {};
    for (const [name, cfg] of Object.entries(adapterConfigs)) {
      const modulePath = (cfg as Record<string, unknown>).module;
      const commandOverride = (cfg as Record<string, unknown>).command;

      if (typeof modulePath === 'string' && !this.has(name)) {
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
            const capabilities =
              candidate.capabilities && typeof candidate.capabilities === 'object'
                ? (candidate.capabilities as AdapterDefinition['capabilities'])
                : undefined;
            const adapter: AdapterDefinition = {
              name,
              binary: candidate.binary,
              capabilities,
              run: typeof candidate.run === 'function' ? (candidate.run as AdapterDefinition['run']) : undefined,
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

      if (typeof commandOverride === 'string') {
        const existing = this.get(name);
        if (existing) {
          this.register({
            ...existing,
            binary: commandOverride,
          });
        }
      }
    }
  }
}
