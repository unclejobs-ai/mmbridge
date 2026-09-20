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
    `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
const outputIndex = args.indexOf('-o');
let task = '';
for await (const chunk of process.stdin) task += chunk;
if (process.env.FAKE_DELAY_MS) await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_DELAY_MS)));
if (outputIndex >= 0 && process.env.FAKE_EMPTY_OUTPUT !== '1') {
  fs.writeFileSync(args[outputIndex + 1], process.env.FAKE_MESSAGE ?? ('mock worker result: ' + task.trim()));
}
if (process.env.FAKE_STDERR) process.stderr.write(process.env.FAKE_STDERR);
process.stdout.write(JSON.stringify({ type: 'item.completed', raw: 'sensitive tool output' }) + '\\n');
process.exitCode = Number(process.env.FAKE_EXIT_CODE ?? 0);
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

function isolatedEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: '/usr/bin:/bin',
    NODE_NO_WARNINGS: '1',
    ...extra,
  };
}

function invoke(root: string, args: string[], env: NodeJS.ProcessEnv = isolatedEnv()) {
  return spawnSync(process.execPath, [binPath, 'run', ...args, '--project', root], {
    encoding: 'utf8',
    env,
  });
}

test('run executes one declared read-only adapter and returns structured evidence', () => {
  const { root, fakeBinary } = makeFixture();
  try {
    const task = 'list package names';
    const result = invoke(root, [task, '--readonly', '--json', '--tool', 'codex']);

    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal('task' in report, false, 'the task prompt must not be echoed into the report');
    assert.equal(report.selected.name, 'codex');
    assert.equal(report.worker.status, 'done');
    assert.equal(report.worker.resumable, false);
    assert.equal(report.worker.text, `mock worker result: ${task}`);
    assert.equal(report.evidence.command, fakeBinary);
    assert.equal(report.evidence.exitCode, 0);
    assert.ok(!report.evidence.args.includes(task), 'task must be sent over stdin, not command arguments');
    assert.ok(report.evidence.args.includes('read-only'));
    assert.match(report.evidence.stdoutTail, /content omitted/);
    assert.doesNotMatch(report.evidence.stdoutTail, /sensitive tool output/);
    assert.equal(report.runtimes.find((runtime) => runtime.name === 'codex').health, 'healthy');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('run refuses an installed adapter without declared read-only capability', () => {
  const { root } = makeFixture();
  try {
    const result = invoke(root, ['inspect repository', '--readonly', '--json', '--tool', 'pi']);
    assert.equal(result.status, 2);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    assert.match(report.error, /does not support declared read-only task runs/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('run requires the explicit read-only boundary', () => {
  const { root } = makeFixture();
  try {
    const result = invoke(root, ['inspect repository', '--json', '--tool', 'codex']);
    assert.equal(result.status, 2);
    assert.match(JSON.parse(result.stdout).error, /requires --readonly/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('run fails closed on malformed project config', () => {
  const { root } = makeFixture();
  try {
    fs.writeFileSync(path.join(root, '.mmbridge.config.json'), '{invalid', 'utf8');
    const result = invoke(root, ['inspect repository', '--readonly', '--json']);
    assert.equal(result.status, 2);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    assert.deepEqual(report.runtimes, []);
    assert.ok(report.error.length > 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('run returns structured failure and redacts adapter stderr', () => {
  const { root } = makeFixture();
  try {
    const secret = 'abcdefghijklmnop1234';
    const result = invoke(
      root,
      ['inspect repository', '--readonly', '--json', '--tool', 'codex'],
      isolatedEnv({ FAKE_EXIT_CODE: '7', FAKE_STDERR: `token="${secret}"` }),
    );

    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.worker.status, 'failed');
    assert.equal(report.evidence.exitCode, 7);
    assert.doesNotMatch(JSON.stringify(report), new RegExp(secret));
    assert.match(report.error, /REDACTED_SECRET/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('run reports an unknown adapter without starting a provider', () => {
  const { root } = makeFixture();
  try {
    const result = invoke(root, ['inspect repository', '--readonly', '--json', '--tool', 'missing']);
    assert.equal(result.status, 2);
    assert.match(JSON.parse(result.stdout).error, /Unknown adapter/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
