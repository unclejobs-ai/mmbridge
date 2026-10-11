// Every guard in the DDL must have an executed rejection test and an exact catalogue row in docs/aps/DESIGN.md.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { guardMessages } from './fixture.ts';

const testDir = fileURLToPath(new URL('./', import.meta.url));
const designDoc = readFileSync(fileURLToPath(new URL('../../../docs/aps/DESIGN.md', import.meta.url)), 'utf8');
const messages = guardMessages();

test('the DDL defines the 88 guard codes the catalogue documents', () => {
  assert.equal(messages.size, 88);
});

test('every guard code has an executed rejection test', () => {
  const sources = readdirSync(testDir)
    .filter((file) => file.endsWith('.test.ts'))
    .map((file) => readFileSync(`${testDir}${file}`, 'utf8'))
    .join('\n');
  const exercised = new Set([...sources.matchAll(/rejects\(\s*\w+,\s*'([A-Z]\d{2})'/g)].map((m) => m[1]));
  const missing = [...messages.keys()].filter((code) => !exercised.has(code));
  assert.deepEqual(missing, []);
});

test('every guard message appears verbatim in docs/aps/DESIGN.md', () => {
  const missing = [...messages.values()].filter((message) => !designDoc.includes(`\`${message}\``));
  assert.deepEqual(missing, []);
});
