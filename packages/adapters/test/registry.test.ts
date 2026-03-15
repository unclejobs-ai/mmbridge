import assert from 'node:assert/strict';
import test from 'node:test';
import { AdapterRegistry } from '../dist/registry.js';

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

test('register overwrites existing adapter', () => {
  const registry = new AdapterRegistry();
  const first = createMockAdapter('tool');
  const second = createMockAdapter('tool');
  registry.register(first);
  registry.register(second);
  assert.equal(registry.get('tool'), second);
});
