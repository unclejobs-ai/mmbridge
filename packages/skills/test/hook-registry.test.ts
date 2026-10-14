import assert from 'node:assert/strict';
import test from 'node:test';
import { HookRegistry } from '../dist/hook-registry.js';

test('emit runs registered handlers in registration order', async () => {
  const registry = new HookRegistry();
  const calls: string[] = [];
  registry.register('PreToolUse', async () => {
    calls.push('first');
  });
  registry.register('PreToolUse', async () => {
    calls.push('second');
  });

  await registry.emit('PreToolUse', { tool: 'gate' });

  assert.deepEqual(calls, ['first', 'second']);
});

test('emit isolates handler failures from other hooks', async (t) => {
  const errorSpy = t.mock.method(console, 'error', () => {});
  const registry = new HookRegistry();
  const calls: string[] = [];
  registry.register('PostReview', async () => {
    throw new Error('hook boom');
  });
  registry.register('PostReview', async () => {
    calls.push('after failure');
  });

  await assert.doesNotReject(registry.emit('PostReview', {}));

  assert.deepEqual(calls, ['after failure']);
  assert.equal(errorSpy.mock.callCount(), 1);
});

test('clear removes a single event or the whole registry', async () => {
  const registry = new HookRegistry();
  const calls: string[] = [];
  registry.register('SessionStart', async () => {
    calls.push('start');
  });
  registry.register('SessionEnd', async () => {
    calls.push('end');
  });

  registry.clear('SessionStart');
  await registry.emit('SessionStart', {});
  await registry.emit('SessionEnd', {});
  assert.deepEqual(calls, ['end']);

  registry.clear();
  await registry.emit('SessionEnd', {});
  assert.deepEqual(calls, ['end']);
});
