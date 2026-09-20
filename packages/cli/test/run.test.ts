import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const binPath = path.join(__dirname, '..', 'dist', 'bin', 'mmbridge.js');

function makeFixture(): { root: string; fakeBinary: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mmbridge-run-'));
  const fakeBinary = path.join(root, 'fake-codex.mjs');
  fs.writeFileSync(
    fakeBinary,
    `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
const outputIndex = args.indexOf('-o');
let task = '';
for await (const chunk of process.stdin) task += chunk;
if (outputIndex >= 0) fs.writeFileSync(args[outputIndex + 1], 'mock worker result: ' + task.trim());
process.stdout.write(JSON.stringify({ type: 'item.completed', raw: 'sensitive tool output' }) + '\\n');
`,
    'utf8',
  );
  fs.chmodSync(fakeBinary, 0o755);
  fs.writeFileSync(
    path.join(root, '.mmbridge.config.json'),
    `${JSON.stringify(
      {
        adapters: {
          codex: { command: fakeBinary },
          pi: { command: fakeBinary },
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  return { root, fakeBinary };
}

test('run executes one verified read-only adapter and returns structured evidence', () => {
  const { root, fakeBinary } = makeFixture();
  try {
    const task = 'list package names';
    const result = spawnSync(
      process.execPath,
      [binPath, 'run', task, '--readonly', '--json', '--tool', 'codex', '--project', root],
      { encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } },
    );

    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.selected.name, 'codex');
    assert.equal(report.worker.status, 'done');
    assert.equal(report.worker.resumable, false);
    assert.equal(report.worker.text, `mock worker result: ${task}`);
    assert.equal(report.evidence.command, fakeBinary);
    assert.equal(report.evidence.exitCode, 0);
    assert.ok(report.evidence.durationMs >= 0);
    assert.ok(!report.evidence.args.includes(task), 'task must be sent over stdin, not command arguments');
    assert.ok(report.evidence.args.includes('--sandbox'));
    assert.ok(report.evidence.args.includes('read-only'));
    assert.match(report.evidence.stdoutTail, /content omitted/);
    assert.doesNotMatch(report.evidence.stdoutTail, /sensitive tool output/);
    assert.equal(report.runtimes.find((runtime) => runtime.name === 'codex').health, 'healthy');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('run refuses an installed adapter without verified read-only capability', () => {
  const { root } = makeFixture();
  try {
    const result = spawnSync(
      process.execPath,
      [binPath, 'run', 'inspect repository', '--readonly', '--json', '--tool', 'pi', '--project', root],
      { encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } },
    );

    assert.equal(result.status, 2);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.selected, null);
    assert.match(report.error, /does not support verified read-only task runs/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('run requires the explicit read-only boundary', () => {
  const { root } = makeFixture();
  try {
    const result = spawnSync(
      process.execPath,
      [binPath, 'run', 'inspect repository', '--json', '--tool', 'codex', '--project', root],
      { encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } },
    );

    assert.equal(result.status, 2);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    assert.match(report.error, /requires --readonly/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
