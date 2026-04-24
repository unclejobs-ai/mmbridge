import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.resolve(here, '..', 'dist', 'index.js');

type TextContentItem = { type: string; text?: string };

async function withClient<T>(body: (client: Client) => Promise<T>): Promise<T> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
  });
  const client = new Client({ name: 'mmbridge-smoke', version: '0.0.0' }, { capabilities: {} });
  await client.connect(transport);
  try {
    return await body(client);
  } finally {
    await client.close();
  }
}

test('mmbridge MCP server: tools/list exposes host-facing surface over real stdio', async () => {
  await withClient(async (client) => {
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    for (const expected of [
      'mmbridge_doctor',
      'mmbridge_gate',
      'mmbridge_handoff',
      'mmbridge_context_packet',
      'mmbridge_review',
    ]) {
      assert.ok(names.includes(expected), `Missing host-facing tool ${expected}`);
    }
  });
});

test('mmbridge MCP server: tools/call mmbridge_doctor returns structured report', async () => {
  await withClient(async (client) => {
    const result = await client.callTool({
      name: 'mmbridge_doctor',
      arguments: { projectDir: process.cwd() },
    });
    const content = Array.isArray(result.content) ? (result.content as TextContentItem[]) : [];
    const texts = content.filter((c) => c.type === 'text' && typeof c.text === 'string').map((c) => c.text as string);
    assert.ok(texts.length > 0, 'mmbridge_doctor should return at least one text content block');

    const report = JSON.parse(texts.join('\n')) as {
      generatedAt?: unknown;
      projectDir?: unknown;
      checks?: unknown;
      mmbridgeHome?: unknown;
      sessionFileHints?: unknown;
    };
    assert.equal(typeof report.generatedAt, 'string', 'generatedAt missing or wrong type');
    assert.equal(typeof report.projectDir, 'string', 'projectDir missing or wrong type');
    assert.ok(Array.isArray(report.checks), 'checks must be an array');
    assert.equal(typeof report.mmbridgeHome, 'string', 'mmbridgeHome missing or wrong type');
    assert.equal(typeof report.sessionFileHints, 'object', 'sessionFileHints missing or wrong type');
  });
});
