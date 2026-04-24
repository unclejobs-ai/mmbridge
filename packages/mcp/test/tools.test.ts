import assert from 'node:assert/strict';
import test from 'node:test';

test('tools module: exports registerToolHandlers', async () => {
  const mod = await import('../dist/tools.js');
  assert.equal(typeof mod.registerToolHandlers, 'function');
});

test('tools module: exposes unclecode integration MCP tools', async () => {
  const mod = await import('../dist/tools.js');
  const definitions = mod.TOOL_DEFINITIONS as Array<{
    name: string;
    inputSchema?: { properties?: Record<string, unknown> };
  }>;
  const names = definitions.map((entry) => entry.name);
  assert.ok(names.includes('mmbridge_gate'));
  assert.ok(names.includes('mmbridge_handoff'));
  assert.ok(names.includes('mmbridge_doctor'));
});

test('tools module: operational MCP tools accept projectDir', async () => {
  const mod = await import('../dist/tools.js');
  const definitions = mod.TOOL_DEFINITIONS as Array<{
    name: string;
    inputSchema?: { properties?: Record<string, unknown> };
  }>;
  for (const toolName of [
    'mmbridge_review',
    'mmbridge_research',
    'mmbridge_debate',
    'mmbridge_security',
    'mmbridge_embrace',
    'mmbridge_gate',
    'mmbridge_handoff',
    'mmbridge_doctor',
  ]) {
    const definition = definitions.find((entry) => entry.name === toolName);
    assert.ok(definition, `Missing tool definition for ${toolName}`);
    assert.ok(definition?.inputSchema?.properties?.projectDir, `Expected projectDir in ${toolName}`);
  }
});
