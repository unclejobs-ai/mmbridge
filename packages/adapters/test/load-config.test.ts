import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AdapterRegistry } from '../dist/registry.js';

test('loadFromConfig skips adapters without module field', async () => {
  const registry = new AdapterRegistry();
  const config = { adapters: { custom: { command: 'custom-bin' } } };
  await registry.loadFromConfig(config);
  assert.equal(registry.has('custom'), false);
});

test('loadFromConfig skips already-registered adapters', async () => {
  const registry = new AdapterRegistry();
  const existing = {
    name: 'existing',
    binary: 'existing',
    review: async () => ({}),
    followup: async () => ({}),
  };
  registry.register(existing);
  const config = { adapters: { existing: { module: 'nonexistent-package' } } };
  await registry.loadFromConfig(config);
  assert.equal(registry.get('existing'), existing);
});

test('loadFromConfig loads adapter from file path', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mmbridge-test-'));
  const adapterPath = path.join(tmpDir, 'test-adapter.mjs');
  await fs.writeFile(
    adapterPath,
    `export default {
      name: 'test-file',
      binary: 'test',
      review: async () => ({ tool: 'test-file', text: 'ok', ok: true, code: 0, stdout: '', stderr: '', combined: '', args: [], command: 'test', externalSessionId: null, followupSupported: false }),
      followup: async () => ({ tool: 'test-file', text: 'ok', ok: true, code: 0, stdout: '', stderr: '', combined: '', args: [], command: 'test', externalSessionId: null, followupSupported: false }),
    };`,
  );

  const registry = new AdapterRegistry();
  const config = { adapters: { 'test-file': { module: adapterPath } } };
  await registry.loadFromConfig(config);
  assert.equal(registry.has('test-file'), true);

  const adapter = registry.get('test-file');
  assert.equal(adapter?.name, 'test-file');
  assert.equal(adapter?.binary, 'test');

  await fs.rm(tmpDir, { recursive: true });
});

test('loadFromConfig silently skips invalid module paths', async () => {
  const registry = new AdapterRegistry();
  const config = { adapters: { broken: { module: '/nonexistent/path/adapter.mjs' } } };
  await registry.loadFromConfig(config);
  assert.equal(registry.has('broken'), false);
});
