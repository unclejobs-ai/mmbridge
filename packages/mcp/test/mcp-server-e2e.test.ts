import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { TextContent } from '@modelcontextprotocol/sdk/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.resolve(here, '..', 'dist', 'index.js');

async function withClient<T>(body: (client: Client) => Promise<T>): Promise<T> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    stderr: 'pipe',
  });
  const client = new Client({ name: 'mmbridge-smoke', version: '0.0.0' }, { capabilities: {} });
  let stderrBuf = '';
  transport.stderr?.on('data', (chunk) => {
    stderrBuf += chunk.toString();
  });
  try {
    await client.connect(transport);
    return await body(client);
  } catch (err) {
    const hint = stderrBuf.trim().length > 0 ? `\nserver stderr:\n${stderrBuf}` : '';
    throw new Error(`mmbridge MCP smoke failed: ${err instanceof Error ? err.message : String(err)}${hint}`);
  } finally {
    await client.close().catch(() => {});
  }
}

test('mmbridge MCP server: tools/list exposes host-facing surface over real stdio', { timeout: 20_000 }, async () => {
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

test('mmbridge MCP server: tools/call mmbridge_doctor returns structured report', { timeout: 20_000 }, async () => {
  await withClient(async (client) => {
    const result = await client.callTool({
      name: 'mmbridge_doctor',
      arguments: { projectDir: process.cwd() },
    });
    const content = Array.isArray(result.content) ? result.content : [];
    const texts: string[] = [];
    for (const item of content) {
      if (item && typeof item === 'object' && 'type' in item && item.type === 'text') {
        const { text } = item as TextContent;
        if (typeof text === 'string') texts.push(text);
      }
    }
    assert.equal(texts.length, 1, 'mmbridge_doctor should return exactly one text content block');
    assert.ok(result.isError !== true, `mmbridge_doctor returned error: ${texts[0]}`);

    const report = JSON.parse(texts[0]) as {
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
    assert.ok(
      report.sessionFileHints !== null && typeof report.sessionFileHints === 'object',
      'sessionFileHints should be a non-null object',
    );
  });
});
