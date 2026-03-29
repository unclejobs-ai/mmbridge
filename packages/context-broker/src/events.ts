import type { BrokerEvent, BrokerEventHandler } from './types.js';

export class BrokerEventBus {
  private listeners: Map<BrokerEvent, Set<BrokerEventHandler>> = new Map();

  on(event: BrokerEvent, handler: BrokerEventHandler): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler);
  }

  off(event: BrokerEvent, handler: BrokerEventHandler): void {
    const set = this.listeners.get(event);
    if (set) {
      set.delete(handler);
    }
  }

  async emit(event: BrokerEvent, data: Record<string, unknown>): Promise<void> {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const handler of set) {
      try {
        await handler(event, data);
      } catch {
        // swallow individual handler errors so other handlers still run
      }
    }
  }

  removeAll(): void {
    this.listeners.clear();
  }
}
