import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const binPath = path.join(__dirname, '..', 'dist', 'bin', 'mmbridge.js');

function getHelpOutput(args: string[]): string {
  return execFileSync(process.execPath, [binPath, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_NO_WARNINGS: '1',
    },
  });
}

test('root help uses the control-plane taxonomy', () => {
  const output = getHelpOutput(['--help']);

  assert.match(output, /Multi-model thinking and review control plane for coding agents/);
  assert.match(output, /\n {2}tui \[options\]\s+Open the interactive TUI control plane/);
  assert.match(output, /\n {2}review \[options\]\s+Run a multi-model review for a change or/);
  assert.match(output, /\n {2}research \[options\] <topic>\s+Research a topic using multiple AI models/);
  assert.match(output, /\n {2}embrace \[options\] <task>\s+Orchestrate research, debate, checkpointing,/);

  for (const command of [
    'review',
    'followup',
    'resume',
    'doctor',
    'gate',
    'handoff',
    'memory',
    'sync-agents',
    'init',
    'tui',
    'diff',
    'research',
    'debate',
    'security',
    'embrace',
    'hook',
  ]) {
    assert.ok(output.includes(`\n  ${command}`), `expected ${command} in root help`);
  }

  assert.doesNotMatch(output, /mmbridge dashboard/);
});

test('tui help still exposes the tab switcher', () => {
  const output = getHelpOutput(['tui', '--help']);

  assert.match(output, /Open the interactive TUI control plane/);
  assert.match(output, /Open directly to a tab \(dashboard\|sessions\|config\)/);
});

test('doctor help matches the documented tooling wording', () => {
  const output = getHelpOutput(['doctor', '--help']);

  assert.match(output, /Inspect local tooling and binary installation/);
});

test('gate help exposes strict mode for blocking harnesses', () => {
  const output = getHelpOutput(['gate', '--help']);

  assert.match(output, /--strict/);
  assert.match(output, /Exit non-zero when gate status is warn/);
});

test('hook install can target project settings.local.json', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mmbridge-hook-local-'));
  try {
    const output = execFileSync(process.execPath, [binPath, 'hook', 'install', '--settings', 'local', '--json'], {
      cwd: tmp,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_NO_WARNINGS: '1',
      },
    });
    const result = JSON.parse(output) as { path: string };

    assert.equal(result.path, path.join(fs.realpathSync(tmp), '.claude', 'settings.local.json'));
    assert.ok(fs.existsSync(result.path));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('gate strict exits non-zero and honors command project option', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mmbridge-gate-project-'));
  try {
    const project = fs.realpathSync(tmp);
    const result = spawnSync(
      process.execPath,
      [binPath, 'gate', '--format', 'json', '--strict', '--project', project],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          NODE_NO_WARNINGS: '1',
        },
      },
    );

    assert.equal(result.status, 1);
    assert.match(result.stdout, new RegExp(project.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
