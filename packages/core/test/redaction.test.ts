import assert from 'node:assert/strict';
import test from 'node:test';
import { redactContent } from '../dist/redaction.js';

// OpenAI API key
test('redactContent: redacts OpenAI API key (sk-...)', () => {
  const content = 'const key = "sk-abcdefghij1234567890abcd";';
  const { redacted, stats } = redactContent(content);
  assert.ok(!redacted.includes('sk-abcdefghij'));
  assert.ok(redacted.includes('[REDACTED_API_KEY]'));
  assert.ok(stats.includes('OpenAI API key'));
});

test('redactContent: redacts sk- key with underscores and dashes', () => {
  const content = 'API_KEY=sk-proj_abc-def_123456789012345';
  const { redacted } = redactContent(content);
  assert.ok(!redacted.includes('sk-proj_abc'));
  assert.ok(redacted.includes('[REDACTED_API_KEY]'));
});

// GCP API key
test('redactContent: redacts GCP API key (AIza...)', () => {
  const content = 'GOOGLE_KEY="AIzaSyAbcdefghijklmnopqrstuvwxyz1234567"';
  const { redacted, stats } = redactContent(content);
  assert.ok(!redacted.includes('AIzaSy'));
  assert.ok(redacted.includes('[REDACTED_GCP_KEY]'));
  assert.ok(stats.includes('GCP API key'));
});

// GitHub PAT
test('redactContent: redacts GitHub PAT (ghp_...)', () => {
  const content = 'token: ghp_abcdefghijklmnopqrstuvwxyz12345678901';
  const { redacted, stats } = redactContent(content);
  assert.ok(!redacted.includes('ghp_'));
  assert.ok(redacted.includes('[REDACTED_GH_TOKEN]'));
  assert.ok(stats.includes('GitHub PAT'));
});

// GitHub app token
test('redactContent: redacts GitHub app token (ghs_...)', () => {
  const content = 'GH_APP_TOKEN=ghs_abcdefghijklmnopqrstuvwxyz12345678901';
  const { redacted, stats } = redactContent(content);
  assert.ok(!redacted.includes('ghs_'));
  assert.ok(redacted.includes('[REDACTED_GH_TOKEN]'));
  assert.ok(stats.includes('GitHub app token'));
});

// Polar access token
test('redactContent: redacts Polar access token (polar_at_...)', () => {
  const content = 'POLAR_TOKEN=polar_at_abcdefghijklmnopqrstuv12345';
  const { redacted, stats } = redactContent(content);
  assert.ok(!redacted.includes('polar_at_'));
  assert.ok(redacted.includes('[REDACTED_POLAR_TOKEN]'));
  assert.ok(stats.includes('Polar access token'));
});

// Password
test('redactContent: redacts password= assignment', () => {
  const content = 'password = supersecretpassword123';
  const { redacted, stats } = redactContent(content);
  assert.ok(!redacted.includes('supersecretpassword123'));
  assert.ok(redacted.includes('[REDACTED_PASSWORD]'));
  assert.ok(stats.includes('Password value'));
});

test('redactContent: redacts passwd= assignment', () => {
  const content = 'passwd:myP@ssw0rd123';
  const { redacted, stats } = redactContent(content);
  assert.ok(!redacted.includes('myP@ssw0rd123'));
  assert.ok(stats.includes('Password value'));
});

test('redactContent: redacts pwd= with quoted value', () => {
  const content = 'pwd="longpassword123"';
  const { redacted, stats } = redactContent(content);
  assert.ok(!redacted.includes('longpassword123'));
  assert.ok(stats.includes('Password value'));
});

// Bearer token
test('redactContent: redacts Bearer token in Authorization header', () => {
  const content = 'Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload';
  const { redacted, stats } = redactContent(content);
  assert.ok(!redacted.includes('eyJhbGci'));
  assert.ok(redacted.includes('Bearer [REDACTED_TOKEN]'));
  assert.ok(stats.includes('Bearer token'));
});

// Generic secret/token
test('redactContent: redacts generic secret= with quoted value', () => {
  const content = 'secret="abcdefghijklmnopqrstuvwxyz123"';
  const { redacted, stats } = redactContent(content);
  assert.ok(!redacted.includes('abcdefghijklmnopqrstuvwxyz123'));
  assert.ok(redacted.includes('[REDACTED_SECRET]'));
  assert.ok(stats.includes('Generic secret/token'));
});

test('redactContent: redacts generic token= with quoted value', () => {
  const content = 'token="ABCDEFGHIJKLMNOP123456789"';
  const { redacted, stats } = redactContent(content);
  assert.ok(!redacted.includes('ABCDEFGHIJKLMNOP123456789'));
  assert.ok(stats.includes('Generic secret/token'));
});

// No secrets
test('redactContent: content without secrets remains unchanged', () => {
  const content = 'const x = 1;\nfunction hello() { return "world"; }';
  const { redacted, stats } = redactContent(content);
  assert.equal(redacted, content);
  assert.deepEqual(stats, []);
});

test('redactContent: empty string returns empty unchanged', () => {
  const { redacted, stats } = redactContent('');
  assert.equal(redacted, '');
  assert.deepEqual(stats, []);
});

test('redactContent: normal config without secrets is unchanged', () => {
  const content = 'PORT=3000\nNODE_ENV=production\nDB_HOST=localhost';
  const { redacted, stats } = redactContent(content);
  assert.equal(redacted, content);
  assert.deepEqual(stats, []);
});

// Multiple secrets in same content
test('redactContent: redacts multiple different secrets in same content', () => {
  const content = [
    'const apiKey = "sk-abcdefghij1234567890abcdefgh";',
    'const ghToken = "ghp_abcdefghijklmnopqrstuvwxyz12345678901";',
  ].join('\n');
  const { redacted, stats } = redactContent(content);
  assert.ok(!redacted.includes('sk-abcdefghij'));
  assert.ok(!redacted.includes('ghp_abcdef'));
  assert.equal(stats.length, 2);
});

test('redactContent: stats lists each triggered rule label once', () => {
  const content = 'sk-abcdefghij1234567890abcdefgh';
  const { stats } = redactContent(content);
  // Stats should not contain duplicates for the same rule type
  const unique = new Set(stats);
  assert.equal(stats.length, unique.size);
});

test('redactContent: applies valid custom extra rules', () => {
  const content = 'SESSION_ID=abc123';
  const { redacted, stats } = redactContent(content, [
    {
      pattern: 'abc123',
      replacement: '[REDACTED_SESSION]',
      label: 'Session ID',
    },
  ]);

  assert.ok(redacted.includes('[REDACTED_SESSION]'));
  assert.ok(stats.includes('Session ID'));
});

test('redactContent: ignores invalid custom regex patterns', () => {
  const content = 'keep-me';
  const { redacted, stats } = redactContent(content, [
    {
      pattern: '[',
      replacement: '[BROKEN]',
      label: 'Broken Rule',
    },
  ]);

  assert.equal(redacted, content);
  assert.deepEqual(stats, []);
});
