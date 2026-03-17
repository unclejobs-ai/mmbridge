import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI_BIN = path.resolve(HERE, '../dist/bin/mmbridge.js');
const FAKE_ADAPTER_MODULE = path.resolve(HERE, 'fixtures/fake-adapter.mjs');
const STREAM_ADAPTER_MODULE = path.resolve(HERE, 'fixtures/stream-adapter.mjs');

type ExecResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

function exec(command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }): ExecResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function execOk(command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }): ExecResult {
  const result = exec(command, args, options);
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed:\n${result.stderr}`);
  return result;
}

function runCli(args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }): ExecResult {
  return exec('node', [CLI_BIN, ...args], options);
}

async function makeFixtureProject(options?: { adapterModule?: string; adapterName?: string }): Promise<{
  cwd: string;
  homeDir: string;
  cleanup: () => Promise<void>;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mmbridge-cli-it-'));
  const homeDir = path.join(root, 'home');
  const projectDir = path.join(root, 'project');
  await fs.mkdir(homeDir, { recursive: true });
  await fs.mkdir(projectDir, { recursive: true });
  await fs.mkdir(path.join(projectDir, 'src'), { recursive: true });

  await fs.writeFile(path.join(projectDir, 'src', 'app.ts'), 'export const value = 1;\n', 'utf8');

  execOk('git', ['init'], { cwd: projectDir });
  execOk('git', ['config', 'user.email', 'test@example.com'], { cwd: projectDir });
  execOk('git', ['config', 'user.name', 'MMBridge Test'], { cwd: projectDir });
  execOk('git', ['add', '.'], { cwd: projectDir });
  execOk('git', ['commit', '-m', 'initial'], { cwd: projectDir });

  await fs.writeFile(path.join(projectDir, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');
  execOk('git', ['add', '.'], { cwd: projectDir });
  execOk('git', ['commit', '-m', 'change'], { cwd: projectDir });

  const adapterName = options?.adapterName ?? 'fixture';
  const modulePath = options?.adapterModule ?? FAKE_ADAPTER_MODULE;
  const config = {
    adapters: {
      [adapterName]: {
        module: modulePath,
      },
    },
  };
  await fs.writeFile(path.join(projectDir, '.mmbridge.config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');

  return {
    cwd: projectDir,
    homeDir,
    cleanup: async () => {
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

async function createToolOnlyPath(rootDir: string): Promise<string> {
  const binDir = path.join(rootDir, 'bin');
  await fs.mkdir(binDir, { recursive: true });

  const gitPath = execOk('which', ['git'], { cwd: rootDir }).stdout.trim();
  const whichPath = execOk('which', ['which'], { cwd: rootDir }).stdout.trim();
  await fs.symlink(process.execPath, path.join(binDir, 'node'));
  await fs.symlink(gitPath, path.join(binDir, 'git'));
  await fs.symlink(whichPath, path.join(binDir, 'which'));

  return binDir;
}

async function waitForLiveState(
  homeDir: string,
  predicate: (state: Record<string, unknown>) => boolean,
  timeoutMs = 3000,
): Promise<Record<string, unknown>> {
  const livePath = path.join(homeDir, '.mmbridge', '.live.json');
  await setTimeout(100);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw = await fs.readFile(livePath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (predicate(parsed)) {
        return parsed;
      }
    } catch {
      await setTimeout(100);
      continue;
    }
    await setTimeout(100);
  }
  throw new Error('Timeout waiting for live state');
}

function parseJsonStdout<T>(result: ExecResult): T {
  assert.equal(result.status, 0, `Command failed:\n${result.stderr}`);
  return JSON.parse(result.stdout) as T;
}

describe('@mmbridge/cli integration', () => {
  it('review command runs end-to-end with a fixture adapter', async () => {
    const fixture = await makeFixtureProject();
    try {
      const env = { ...process.env, HOME: fixture.homeDir, USERPROFILE: fixture.homeDir };
      const result = runCli(
        ['review', '--tool', 'fixture', '--mode', 'review', '--project', fixture.cwd, '--base-ref', 'HEAD~1', '--json'],
        { cwd: fixture.cwd, env },
      );
      const report = parseJsonStdout<{
        tool: string;
        mode: string;
        status: string;
        findings: Array<{ file: string; line: number | null; severity: string; message: string }>;
        externalSessionId?: string;
      }>(result);

      assert.equal(report.tool, 'fixture');
      assert.equal(report.mode, 'review');
      assert.equal(report.status, 'complete');
      assert.ok(report.findings.length > 0);
      assert.equal(report.findings[0]?.file, 'src/app.ts');
      assert.equal(report.externalSessionId, 'fixture-session-001');
    } finally {
      await fixture.cleanup();
    }
  });

  it('followup command uses the latest session and returns JSON', async () => {
    const fixture = await makeFixtureProject();
    try {
      const env = { ...process.env, HOME: fixture.homeDir, USERPROFILE: fixture.homeDir };

      const reviewResult = runCli(
        ['review', '--tool', 'fixture', '--project', fixture.cwd, '--base-ref', 'HEAD~1', '--json'],
        { cwd: fixture.cwd, env },
      );
      assert.equal(reviewResult.status, 0, `review failed:\n${reviewResult.stderr}`);

      const followupResult = runCli(
        [
          'followup',
          '--tool',
          'fixture',
          '--latest',
          '--prompt',
          'Please confirm whether this still needs a change.',
          '--project',
          fixture.cwd,
          '--json',
        ],
        { cwd: fixture.cwd, env },
      );
      const report = parseJsonStdout<{
        tool: string;
        mode: string;
        status: string;
        externalSessionId?: string;
      }>(followupResult);

      assert.equal(report.tool, 'fixture');
      assert.equal(report.mode, 'followup');
      assert.equal(report.status, 'complete');
      assert.equal(report.externalSessionId, 'fixture-session-001');
    } finally {
      await fixture.cleanup();
    }
  });

  it('doctor command reports checks in JSON format', async () => {
    const fixture = await makeFixtureProject();
    try {
      const env = { ...process.env, HOME: fixture.homeDir, USERPROFILE: fixture.homeDir };
      const result = runCli(['doctor', '--json'], { cwd: fixture.cwd, env });
      const report = parseJsonStdout<{
        checks: Array<{ binary: string; installed: boolean }>;
        sessionFileHints: Record<string, string>;
      }>(result);

      assert.ok(Array.isArray(report.checks));
      assert.ok(report.checks.length > 0);
      assert.ok('fixture' in report.sessionFileHints);
    } finally {
      await fixture.cleanup();
    }
  });

  it('review --stream emits chunks and live state telemetry', async () => {
    const fixture = await makeFixtureProject({ adapterModule: STREAM_ADAPTER_MODULE, adapterName: 'streamfixture' });
    try {
      const env = { ...process.env, HOME: fixture.homeDir, USERPROFILE: fixture.homeDir };
      const child = spawn(
        'node',
        [CLI_BIN, 'review', '--stream', '--tool', 'streamfixture', '--project', fixture.cwd, '--base-ref', 'HEAD~1'],
        { cwd: fixture.cwd, env },
      );
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr?.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      const liveDuringReview = await waitForLiveState(
        fixture.homeDir,
        (state) => Array.isArray(state.streamLines) && (state.streamLines as string[]).length > 0,
        5000,
      );
      const telemetry = liveDuringReview.telemetry as Record<string, number> | undefined;
      assert.ok(telemetry?.spawnedAgents >= 1);

      const exitCode = await new Promise<number>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => resolve(code ?? -1));
      });
      assert.equal(exitCode, 0, `stream review failed:\n${stderr}`);

      assert.match(stdout, /first streamed chunk/);
      assert.match(stdout, /second streamed chunk/);
    } finally {
      await fixture.cleanup();
    }
  });

  it('review --all runs installed custom adapters and returns bridge output', async () => {
    const fixture = await makeFixtureProject();
    try {
      const binDir = await createToolOnlyPath(fixture.homeDir);
      const config = {
        adapters: {
          alpha: { module: FAKE_ADAPTER_MODULE },
          beta: { module: FAKE_ADAPTER_MODULE },
        },
      };
      await fs.writeFile(
        path.join(fixture.cwd, '.mmbridge.config.json'),
        `${JSON.stringify(config, null, 2)}\n`,
        'utf8',
      );

      const env = { ...process.env, HOME: fixture.homeDir, USERPROFILE: fixture.homeDir, PATH: binDir };
      const result = runCli(['review', '--all', '--project', fixture.cwd, '--base-ref', 'HEAD~1', '--json'], {
        cwd: fixture.cwd,
        env,
      });
      const report = parseJsonStdout<{
        tool: string;
        findings: Array<{ file: string }>;
        toolResults?: Array<{ tool: string }>;
      }>(result);

      assert.equal(report.tool, 'bridge');
      assert.ok(report.findings.length > 0);
      assert.equal(report.toolResults?.length, 2);
      assert.deepEqual(report.toolResults?.map((entry) => entry.tool).sort(), ['alpha', 'beta']);
    } finally {
      await fixture.cleanup();
    }
  });

  it('review --manager runs supervisor-managed consensus review', async () => {
    const fixture = await makeFixtureProject();
    try {
      const binDir = await createToolOnlyPath(fixture.homeDir);
      const config = {
        adapters: {
          alpha: { module: FAKE_ADAPTER_MODULE },
          beta: { module: FAKE_ADAPTER_MODULE },
        },
      };
      await fs.writeFile(
        path.join(fixture.cwd, '.mmbridge.config.json'),
        `${JSON.stringify(config, null, 2)}\n`,
        'utf8',
      );

      const env = { ...process.env, HOME: fixture.homeDir, USERPROFILE: fixture.homeDir, PATH: binDir };
      const result = runCli(['review', '--manager', '--project', fixture.cwd, '--base-ref', 'HEAD~1', '--json'], {
        cwd: fixture.cwd,
        env,
      });
      const report = parseJsonStdout<{
        tool: string;
        summary: string;
        manager?: { managerTool: string; validated: Array<unknown> };
        toolResults?: Array<{ tool: string }>;
      }>(result);

      assert.equal(report.tool, 'bridge');
      assert.equal(report.toolResults?.length, 2);
      assert.equal(report.manager?.managerTool, 'none');
      assert.ok((report.manager?.validated.length ?? 0) > 0);
      assert.match(report.summary, /Manager fallback kept/);
    } finally {
      await fixture.cleanup();
    }
  });

  it('review --bridge interpreted preserves legacy interpretation mode', async () => {
    const fixture = await makeFixtureProject();
    try {
      const binDir = await createToolOnlyPath(fixture.homeDir);
      const config = {
        adapters: {
          alpha: { module: FAKE_ADAPTER_MODULE },
          beta: { module: FAKE_ADAPTER_MODULE },
        },
      };
      await fs.writeFile(
        path.join(fixture.cwd, '.mmbridge.config.json'),
        `${JSON.stringify(config, null, 2)}\n`,
        'utf8',
      );

      const env = { ...process.env, HOME: fixture.homeDir, USERPROFILE: fixture.homeDir, PATH: binDir };
      const result = runCli(
        ['review', '--all', '--bridge', 'interpreted', '--project', fixture.cwd, '--base-ref', 'HEAD~1', '--json'],
        {
          cwd: fixture.cwd,
          env,
        },
      );
      const report = parseJsonStdout<{
        tool: string;
        findings: Array<{ file: string; severity: string }>;
        interpretation?: { interpreterTool: string };
        manager?: unknown;
      }>(result);

      assert.equal(report.tool, 'bridge');
      assert.equal(report.findings.length, 1);
      assert.equal(report.findings[0]?.file, 'src/app.ts');
      assert.ok(report.interpretation);
      assert.equal(report.manager ?? null, null);
    } finally {
      await fixture.cleanup();
    }
  });

  it('review rejects conflicting --manager and --tool values', async () => {
    const fixture = await makeFixtureProject();
    try {
      const result = runCli(
        ['review', '--manager', '--tool', 'fixture', '--project', fixture.cwd, '--base-ref', 'HEAD~1'],
        { cwd: fixture.cwd, env: { ...process.env, HOME: fixture.homeDir, USERPROFILE: fixture.homeDir } },
      );

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /--manager cannot be combined with --tool/);
    } finally {
      await fixture.cleanup();
    }
  });
});
