import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { implement } from '../dist/index.js';

const fakeOmp = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-omp.mjs');
const BUGGY = 'export const add = (a, b) => a - b;\n';
const FIXED = 'export const add = (a, b) => a + b;\n';
const PASS = '{"verdict":"pass","findings":[]}';

async function setup() {
  const repo = await mkdtemp(path.join(tmpdir(), 'mmbridge-repo-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  await writeFile(path.join(repo, 'package.json'), '{"type":"module"}\n');
  await writeFile(path.join(repo, 'calc.js'), BUGGY);
  await writeFile(
    path.join(repo, 'check.js'),
    "import { add } from './calc.js';\nprocess.exit(add(2, 3) === 5 ? 0 : 1);\n",
  );
  git('add', '-A');
  git('commit', '-qm', 'init');

  const mmbridgeHome = await mkdtemp(path.join(tmpdir(), 'mmbridge-home-'));
  await writeFile(
    path.join(mmbridgeHome, 'roles.json'),
    JSON.stringify({ roles: { worker: ['wprov/one'], reviewer: ['wprov/two', 'rprov/three'] } }),
  );
  return { repo, mmbridgeHome };
}

function run(env: { repo: string; mmbridgeHome: string }, validate?: string) {
  return implement({
    task: 'add() subtracts; make it add.',
    projectDir: env.repo,
    mmbridgeHome: env.mmbridgeHome,
    binary: fakeOmp,
    ...(validate ? { validate } : {}),
  });
}

afterEach(() => {
  for (const key of ['FAKE_OMP_EDIT', 'FAKE_OMP_REVIEW', 'FAKE_OMP_SPAWN_LOG'])
    Reflect.deleteProperty(process.env, key);
});

describe('implement', () => {
  it('passes the gate when the worker fixes it, a different-provider reviewer passes, and validation succeeds', async () => {
    const env = await setup();
    process.env.FAKE_OMP_EDIT = `calc.js=${FIXED}`;
    process.env.FAKE_OMP_REVIEW = PASS;
    const result = await run(env, 'node check.js');

    assert.equal(result.gate, 'pass', result.reasons.join('; '));
    assert.equal(`${result.worker?.provider}/${result.worker?.modelId}`, 'wprov/one');
    assert.equal(result.review?.model, 'rprov/three');
    assert.equal(result.review?.verdict, 'pass');
    assert.equal(result.validate?.exitCode, 0);
    assert.match(result.diff, /\+export const add = \(a, b\) => a \+ b;/);
    assert.equal(await readFile(path.join(result.worktree, 'calc.js'), 'utf8'), FIXED);
    assert.equal(await readFile(path.join(env.repo, 'calc.js'), 'utf8'), BUGGY, 'the main checkout is untouched');
    assert.match(result.branch, /^mmbridge\//);

    execFileSync('sh', ['-c', result.cleanup]);
    const worktrees = execFileSync('git', ['worktree', 'list'], { cwd: env.repo, encoding: 'utf8' });
    const branches = execFileSync('git', ['branch', '--list', 'mmbridge/*'], { cwd: env.repo, encoding: 'utf8' });
    assert.ok(!worktrees.includes(result.worktree), 'cleanup removes the worktree');
    assert.equal(branches.trim(), '', 'cleanup deletes the worker branch');
  });

  it('blocks when the reviewer blocks', async () => {
    const env = await setup();
    process.env.FAKE_OMP_EDIT = `calc.js=${FIXED}`;
    process.env.FAKE_OMP_REVIEW =
      'Here you go:\n{"verdict":"block","findings":[{"severity":"major","file":"calc.js","message":"no test added"}]}';
    const result = await run(env, 'node check.js');
    assert.equal(result.gate, 'block');
    assert.deepEqual(result.review?.findings, [{ severity: 'major', file: 'calc.js', message: 'no test added' }]);
    assert.ok(result.reasons.some((r) => r.includes('reviewer blocked')));
  });

  it('blocks when the reviewer output is not the required JSON', async () => {
    const env = await setup();
    process.env.FAKE_OMP_EDIT = `calc.js=${FIXED}`;
    process.env.FAKE_OMP_REVIEW = 'Looks fine to me!';
    const result = await run(env);
    assert.equal(result.gate, 'block');
    assert.ok(result.reasons.some((r) => r.includes('not valid review JSON')));
  });

  it('blocks when validation fails even if the reviewer passes', async () => {
    const env = await setup();
    process.env.FAKE_OMP_EDIT = 'calc.js=export const add = (a, b) => a * b;\n';
    process.env.FAKE_OMP_REVIEW = PASS;
    const result = await run(env, 'node check.js');
    assert.equal(result.gate, 'block');
    assert.equal(result.validate?.exitCode, 1);
    assert.ok(result.reasons.some((r) => r.includes('validate failed')));
  });

  it('blocks without a review when the worker changes nothing', async () => {
    const env = await setup();
    process.env.FAKE_OMP_REVIEW = PASS;
    const result = await run(env, 'node check.js');
    assert.equal(result.gate, 'block');
    assert.equal(result.review, undefined);
    assert.ok(result.reasons.some((r) => r.includes('no changes')));
  });

  it('gives the worker file tools only — no shell, code execution, browser, or sub-agents', async () => {
    const env = await setup();
    const spawnLog = path.join(env.mmbridgeHome, 'spawns.log');
    process.env.FAKE_OMP_SPAWN_LOG = spawnLog;
    process.env.FAKE_OMP_EDIT = `calc.js=${FIXED}`;
    process.env.FAKE_OMP_REVIEW = PASS;
    await run(env);
    const [workerSpawn, reviewerSpawn] = (await readFile(spawnLog, 'utf8')).trim().split('\n');
    assert.match(workerSpawn ?? '', /--tools read,edit,write,grep,glob(\s|$)/);
    assert.doesNotMatch(workerSpawn ?? '', /bash|python|browser|computer|task|web_search/);
    assert.match(reviewerSpawn ?? '', /--no-tools/);
  });
});
