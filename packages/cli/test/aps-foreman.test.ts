import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkAcceptance, outOfScope, reworkGate } from '../dist/commands/aps-foreman.js';
import { parseDuration } from '../dist/commands/aps-shared.js';

test('rework gate: reissue up to 1 rework, card fix at 2, L1 redesign from 3', () => {
  assert.deepEqual([0, 1, 2, 3, 4].map(reworkGate), [
    'dispatch',
    'dispatch',
    'NEEDS_CARD_FIX',
    'ESCALATE_L1',
    'ESCALATE_L1',
  ]);
});

test('--wait durations default to seconds and reject prose', () => {
  assert.deepEqual(
    ['90', '90s', '30m', '2h', '500ms'].map((value) => parseDuration(value, 'wait')),
    [90_000, 90_000, 1_800_000, 7_200_000, 500],
  );
  assert.equal(parseDuration(undefined, 'wait'), 0);
  assert.throws(() => parseDuration('half an hour', 'wait'), /--wait must look like/);
});

test('scope check flags files outside path tokens and ignores prose-only scopes', () => {
  const files = ['packages/aps/src/quota.ts', 'packages/aps/srcx/evil.ts', 'README.md', 'docs/aps/DESIGN.md'];
  assert.deepEqual(outOfScope(files, 'packages/aps/src/ and README.md only'), [
    'packages/aps/srcx/evil.ts',
    'docs/aps/DESIGN.md',
  ]);
  assert.deepEqual(outOfScope(files, 'packages/aps/src/**'), [
    'packages/aps/srcx/evil.ts',
    'README.md',
    'docs/aps/DESIGN.md',
  ]);
  assert.deepEqual(outOfScope(files, 'the quota module'), []);
});

test('acceptance needs exit 0 and the expected text unless expect is "exit 0"', (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'aps-foreman-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(join(cwd, 'out.txt'), '13 pass\n0 fail\n');
  assert.equal(checkAcceptance({ id: 'AC1', text: '', command: 'cat out.txt', expect: '0 fail' }, cwd, 5000).ok, true);
  assert.equal(checkAcceptance({ id: 'AC2', text: '', command: 'true', expect: 'exit 0' }, cwd, 5000).ok, true);
  const missing = checkAcceptance({ id: 'AC3', text: '', command: 'cat out.txt', expect: '14 pass' }, cwd, 5000);
  assert.deepEqual(missing, { ok: false, detail: 'AC3: exit 0, missing "14 pass"; last: 0 fail' });
  const failed = checkAcceptance({ id: 'AC4', text: '', command: 'echo 0 fail; exit 3', expect: '0 fail' }, cwd, 5000);
  assert.deepEqual(failed, { ok: false, detail: 'AC4: exit 3; last: 0 fail' });
  assert.equal(checkAcceptance({ id: 'AC5', text: 'reads well' }, cwd, 5000).ok, true);
});
