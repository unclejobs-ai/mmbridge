import assert from 'node:assert/strict';
import test from 'node:test';
import { AdapterRegistry, resolveAdapterCapabilities } from '../dist/registry.js';

function createMockAdapter(name) {
  const mockResult = {
    tool: name,
    text: 'mock',
    ok: true,
    code: 0,
    stdout: '',
    stderr: '',
    combined: '',
    args: [],
    command: name,
    externalSessionId: null,
    followupSupported: false,
  };
  return {
    name,
    binary: name,
    review: async () => mockResult,
    followup: async () => mockResult,
  };
}

test('register and retrieve adapter', () => {
  const registry = new AdapterRegistry();
  const adapter = createMockAdapter('test-tool');
  registry.register(adapter);
  assert.equal(registry.has('test-tool'), true);
  assert.equal(registry.get('test-tool'), adapter);
});

test('list returns registered adapter names', () => {
  const registry = new AdapterRegistry();
  registry.register(createMockAdapter('a'));
  registry.register(createMockAdapter('b'));
  assert.deepEqual(registry.list().sort(), ['a', 'b']);
});

test('get returns undefined for unknown adapter', () => {
  const registry = new AdapterRegistry();
  assert.equal(registry.get('nonexistent'), undefined);
});

test('has returns false for unknown adapter', () => {
  const registry = new AdapterRegistry();
  assert.equal(registry.has('nonexistent'), false);
});

test('resolveAdapterCapabilities only advertises explicitly verified read-only runs', () => {
  const adapter = {
    ...createMockAdapter('runner'),
    capabilities: { readOnly: true, followup: true },
    run: async () => createMockAdapter('runner').review(),
  };

  assert.deepEqual(resolveAdapterCapabilities(adapter), {
    run: true,
    readOnly: true,
    followup: true,
  });
  assert.deepEqual(resolveAdapterCapabilities(createMockAdapter('review-only')), {
    run: false,
    readOnly: false,
    followup: false,
  });
});

test('register overwrites existing adapter', () => {
  const registry = new AdapterRegistry();
  const first = createMockAdapter('tool');
  const second = createMockAdapter('tool');
  registry.register(first);
  registry.register(second);
  assert.equal(registry.get('tool'), second);
});
