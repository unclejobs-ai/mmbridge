import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '..', 'dist', 'bin', 'mmbridge.js');
const fakeOmp = path.join(here, '..', '..', 'dispatch', 'test', 'fixtures', 'fake-omp.mjs');

/** A non-repo cwd, a HOME with a role table and a PATH whose `omp` is the fake, so the CLI never touches real providers. */
async function sandbox() {
  const root = await mkdtemp(path.join(tmpdir(), 'mmbridge-cli-'));
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  await mkdir(path.join(home, '.mmbridge'), { recursive: true });
  await mkdir(bin);
  await symlink(fakeOmp, path.join(bin, 'omp'));
  await writeFile(
    path.join(home, '.mmbridge', 'roles.json'),
    JSON.stringify({ roles: { worker: ['wprov/one'], reviewer: ['rprov/two'], scout: ['sprov/three'] } }),
  );
  const repo = path.join(root, 'target-repo');
  await mkdir(repo);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  await writeFile(path.join(repo, 'calc.js'), 'export const add = (a, b) => a - b;\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  const env = { ...process.env, HOME: home, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` };
  return { root, repo, env };
}

describe('dispatch / implement commands', () => {
  it('implement -p runs the worker in a worktree of the given project, not the cwd', async () => {
    const { root, repo, env } = await sandbox();
    const run = spawnSync(process.execPath, [cli, 'implement', '-p', repo, 'make add add'], {
      cwd: root, // not a git repo: if -p were ignored, implement fails instead of touching this checkout
      encoding: 'utf8',
      env: {
        ...env,
        FAKE_OMP_EDIT: 'calc.js=export const add = (a, b) => a + b;\n',
        FAKE_OMP_REVIEW: '{"verdict":"pass","findings":[]}',
      },
    });
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(run.stdout) as { gate: string; worktree: string; diff: string; cleanup: string };
    assert.equal(result.gate, 'pass');
    assert.match(path.basename(result.worktree), /^target-repo-/);
    assert.match(result.diff, /a \+ b/);
    execFileSync('sh', ['-c', result.cleanup]);
  });

  it('dispatch --model pins the model even though the root command also has --model', async () => {
    const { root, repo, env } = await sandbox();
    const run = spawnSync(process.execPath, [cli, 'dispatch', '-r', 'scout', '--model', 'pin/me', '-p', repo, 'hi'], {
      cwd: root,
      encoding: 'utf8',
      env,
    });
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(run.stdout) as { provider: string; modelId: string };
    assert.equal(`${result.provider}/${result.modelId}`, 'pin/me');
  });
});
