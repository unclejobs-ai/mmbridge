import assert from 'node:assert/strict';
import test from 'node:test';
import { detectParseState, parseFindings } from '../dist/finding-parser.js';

// ─── parseFindings ───────────────────────────────────────────────────────────

test('parseFindings: empty string returns empty', () => {
  assert.deepEqual(parseFindings(''), []);
});

test('parseFindings: whitespace-only returns empty', () => {
  assert.deepEqual(parseFindings('   \n  \n  '), []);
});

test('parseFindings: single tagged line', () => {
  const input = '[WARNING] src/api.ts:42 — Missing input validation';
  const findings = parseFindings(input);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'WARNING');
  assert.equal(findings[0].file, 'src/api.ts');
  assert.equal(findings[0].line, 42);
  assert.ok(findings[0].message.includes('Missing input validation'));
});

test('parseFindings: CRITICAL tag', () => {
  const input = '[CRITICAL] lib/auth.ts:10 — SQL injection vulnerability';
  const findings = parseFindings(input);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'CRITICAL');
  assert.equal(findings[0].confidence, 'high');
});

test('parseFindings: INFO tag', () => {
  const input = '[INFO] Consider using const';
  const findings = parseFindings(input);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'INFO');
});

test('parseFindings: REFACTOR tag', () => {
  const input = '[REFACTOR] utils/helper.ts — Extract to separate module';
  const findings = parseFindings(input);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'REFACTOR');
});

test('parseFindings: case-insensitive severity tags', () => {
  const input = '[warning] src/a.ts — msg';
  const findings = parseFindings(input);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'WARNING');
});

test('parseFindings: bullet list items with tags', () => {
  const input = '- [WARNING] src/a.ts — issue one\n* [CRITICAL] src/b.ts — issue two';
  const findings = parseFindings(input);
  assert.equal(findings.length, 2);
  assert.equal(findings[0].severity, 'WARNING');
  assert.equal(findings[1].severity, 'CRITICAL');
});

test('parseFindings: numbered list items', () => {
  const input = '1. [WARNING] src/a.ts — issue\n2. [INFO] src/b.ts — note';
  const findings = parseFindings(input);
  assert.equal(findings.length, 2);
});

test('parseFindings: markdown heading section groups findings', () => {
  const input = [
    '## Critical Issues',
    'src/api.ts:10 — Bad thing',
    'src/db.ts:20 — Another bad thing',
    '',
    '## Info',
    'src/util.ts — Minor note',
  ].join('\n');
  const findings = parseFindings(input);
  assert.ok(findings.length >= 3);
  const criticals = findings.filter((f) => f.severity === 'CRITICAL');
  assert.ok(criticals.length >= 2);
});

test('parseFindings: file reference without line number', () => {
  const input = '[WARNING] src/config.ts — Hardcoded value';
  const findings = parseFindings(input);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, 'src/config.ts');
  assert.equal(findings[0].line, null);
});

test('parseFindings: rejects version-like strings as file refs', () => {
  const input = '[INFO] Version 1.2.3 is outdated';
  const findings = parseFindings(input);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, '');
});

test('parseFindings: http URLs may partially match as file refs', () => {
  // The parser strips "http:" but may still match the remainder as a file-like pattern
  const input = '[INFO] http://example.com/path — Not a file';
  const findings = parseFindings(input);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'INFO');
});

test('parseFindings: multiple mixed findings', () => {
  const input = [
    '[CRITICAL] lib/auth.ts:5 — XSS vulnerability',
    '[WARNING] lib/db.ts:10 — Missing index',
    '[INFO] General note about code quality',
    '[REFACTOR] lib/utils.ts — Too complex',
  ].join('\n');
  const findings = parseFindings(input);
  assert.equal(findings.length, 4);
  assert.equal(findings.filter((f) => f.severity === 'CRITICAL').length, 1);
  assert.equal(findings.filter((f) => f.severity === 'WARNING').length, 1);
  assert.equal(findings.filter((f) => f.severity === 'INFO').length, 1);
  assert.equal(findings.filter((f) => f.severity === 'REFACTOR').length, 1);
});

test('parseFindings: fallback — plain text becomes INFO', () => {
  const input =
    'The code looks generally good but could use some cleanup in the authentication module. Consider refactoring the login flow.';
  const findings = parseFindings(input);
  assert.ok(findings.length > 0);
  assert.ok(findings.every((f) => f.severity === 'INFO'));
  assert.ok(findings.every((f) => f.confidence === 'medium'));
});

test('parseFindings: strips bold markdown from messages', () => {
  const input = '[WARNING] src/a.ts — **Bold message** here';
  const findings = parseFindings(input);
  assert.equal(findings.length, 1);
  assert.ok(!findings[0].message.includes('**'));
});

// ─── detectParseState ────────────────────────────────────────────────────────

test('detectParseState: structured when explicit tags present', () => {
  assert.equal(detectParseState('[WARNING] something'), 'structured');
  assert.equal(detectParseState('[CRITICAL] something'), 'structured');
});

test('detectParseState: semi-structured with heading severity', () => {
  assert.equal(detectParseState('## Critical Issues\nSome text'), 'semi-structured');
});

test('detectParseState: raw for plain text', () => {
  assert.equal(detectParseState('Just some plain text'), 'raw');
});

test('detectParseState: empty string is raw', () => {
  assert.equal(detectParseState(''), 'raw');
});
