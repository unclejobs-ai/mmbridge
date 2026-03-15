import test from 'node:test';
import assert from 'node:assert/strict';

test('tools module: exports registerToolHandlers', async () => {
  const mod = await import('../dist/tools.js');
  assert.equal(typeof mod.registerToolHandlers, 'function');
});
