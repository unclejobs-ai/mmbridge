import assert from 'node:assert/strict';
import test from 'node:test';

test('tools module: exports registerToolHandlers', async () => {
  const mod = await import('../dist/tools.js');
  assert.equal(typeof mod.registerToolHandlers, 'function');
});
