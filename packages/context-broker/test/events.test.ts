import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { BrokerEventBus } from '../dist/events.js';

describe('BrokerEventBus', () => {
  it('on() + emit() delivers events to handlers', async () => {
    const bus = new BrokerEventBus();
    const received: unknown[] = [];

    bus.on('before_context', (_event, data) => {
      received.push(data);
    });

    await bus.emit('before_context', { task: 'review' });

    assert.equal(received.length, 1);
    assert.deepEqual(received[0], { task: 'review' });
  });

  it('off() removes a handler', async () => {
    const bus = new BrokerEventBus();
    const received: unknown[] = [];

    const handler = (_event: string, data: Record<string, unknown>) => {
      received.push(data);
    };

    bus.on('after_context', handler);
    await bus.emit('after_context', { step: 1 });
    assert.equal(received.length, 1);

    bus.off('after_context', handler);
    await bus.emit('after_context', { step: 2 });
    assert.equal(received.length, 1, 'Handler should not fire after off()');
  });

  it('emit() calls multiple handlers for same event', async () => {
    const bus = new BrokerEventBus();
    let count = 0;

    bus.on('on_recall', () => { count++; });
    bus.on('on_recall', () => { count++; });
    bus.on('on_recall', () => { count++; });

    await bus.emit('on_recall', {});

    assert.equal(count, 3);
  });

  it('emit() swallows handler errors without breaking other handlers', async () => {
    const bus = new BrokerEventBus();
    const results: string[] = [];

    bus.on('before_context', () => { results.push('first'); });
    bus.on('before_context', () => { throw new Error('handler crash'); });
    bus.on('before_context', () => { results.push('third'); });

    await bus.emit('before_context', {});

    assert.ok(results.includes('first'), 'First handler should run');
    assert.ok(results.includes('third'), 'Third handler should run despite second crashing');
  });

  it('removeAll() clears all handlers', async () => {
    const bus = new BrokerEventBus();
    let count = 0;

    bus.on('before_context', () => { count++; });
    bus.on('after_context', () => { count++; });

    bus.removeAll();

    await bus.emit('before_context', {});
    await bus.emit('after_context', {});

    assert.equal(count, 0, 'No handlers should fire after removeAll()');
  });

  it('emit() for unregistered event does not throw', async () => {
    const bus = new BrokerEventBus();
    // Should not throw
    await bus.emit('on_recall', { anything: true });
  });
});
