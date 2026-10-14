import assert from 'node:assert/strict';
import test from 'node:test';
import { BUILTIN_TOOLS } from '../dist/builtin-tools.js';
import { ToolRegistry } from '../dist/tool-registry.js';
import type { AgentTool } from '../dist/types.js';

function fakeTool(name: string): AgentTool {
  return { name, description: `${name} description`, inputSchema: { type: 'object' }, execute: async () => 'ok' };
}

test('ToolRegistry registers, gets, and lists tools', () => {
  const registry = new ToolRegistry();
  const review = fakeTool('mmbridge_review');
  const gate = fakeTool('mmbridge_gate');

  registry.register(review);
  registry.register(gate);

  assert.equal(registry.get('mmbridge_review'), review);
  assert.equal(registry.get('mmbridge_gate'), gate);
  assert.equal(registry.get('mmbridge_missing'), undefined);
  assert.deepEqual(
    registry.list().map((t) => t.name),
    ['mmbridge_review', 'mmbridge_gate'],
  );
});

test('ToolRegistry overwrites tools registered under the same name', () => {
  const registry = new ToolRegistry();
  const original = fakeTool('dup');
  const replacement = fakeTool('dup');

  registry.register(original);
  registry.register(replacement);

  assert.equal(registry.get('dup'), replacement);
  assert.equal(registry.list().length, 1);
});

test('ToolRegistry unregister removes a tool and ignores unknown names', () => {
  const registry = new ToolRegistry();
  registry.register(fakeTool('mmbridge_review'));
  registry.unregister('mmbridge_review');
  registry.unregister('mmbridge_missing');

  assert.equal(registry.get('mmbridge_review'), undefined);
  assert.deepEqual(registry.list(), []);
});

test('ToolRegistry maps tools to Anthropic tool schema', () => {
  const registry = new ToolRegistry();
  registry.register(fakeTool('mmbridge_review'));

  assert.deepEqual(registry.toAnthropicTools(), [
    {
      name: 'mmbridge_review',
      description: 'mmbridge_review description',
      input_schema: { type: 'object' },
    },
  ]);
  assert.deepEqual(new ToolRegistry().toAnthropicTools(), []);
});

test('BUILTIN_TOOLS exposes the expected built-in tool set', () => {
  assert.deepEqual(
    BUILTIN_TOOLS.map((t) => t.name),
    [
      'mmbridge_review',
      'mmbridge_security',
      'mmbridge_research',
      'mmbridge_memory_search',
      'mmbridge_gate',
      'mmbridge_status',
    ],
  );
});

test('built-in tools carry a description and an object input schema', () => {
  for (const tool of BUILTIN_TOOLS) {
    assert.ok(tool.description.length > 0, `${tool.name} must have a description`);
    assert.equal(tool.inputSchema.type, 'object', `${tool.name} must declare an object schema`);
  }
});
