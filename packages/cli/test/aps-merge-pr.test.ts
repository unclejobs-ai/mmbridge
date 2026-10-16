import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { openApsDb } from '@mmbridge/aps';
import { parsePrView } from '../dist/commands/aps-merge-pr.js';

const bin = resolve(import.meta.dirname, '../dist/bin/mmbridge.js');
const identity = ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid'];

/** Real git: origin (bare) ← project with a reviewed feature commit squash-merged onto main; fake `gh` on PATH. */
function fixture(t: TestContext) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'aps-merge-pr-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const fakeBin = join(home, 'bin');
  mkdirSync(fakeBin);
  const ghFixture = join(home, 'gh.json');
  const ghLog = join(home, 'gh.log');
  writeFileSync(
    join(fakeBin, 'gh'),
    `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(ghLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');
process.stdout.write(fs.readFileSync(${JSON.stringify(ghFixture)}, 'utf8'));
`,
  );
  chmodSync(join(fakeBin, 'gh'), 0o755);
  const env = {
    ...process.env,
    HOME: home,
    PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
    APS_DB: join(home, 'aps.db'),
    MMBRIDGE_APS_DB: '',
    APS_AGENT: 'bootstrap',
    NODE_NO_WARNINGS: '1',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const project = join(home, 'project');
  const origin = join(home, 'origin.git');
  const git = (args: string[], cwd = project) => {
    const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    assert.equal(result.status, 0, `git ${args.join(' ')}\n${result.stderr}`);
    return result.stdout.trim();
  };
  git(['init', '-q', '--bare', '-b', 'main', origin], home);
  git(['init', '-q', '-b', 'main', project], home);
  git(['remote', 'add', 'origin', origin]);
  git([...identity, 'commit', '--allow-empty', '-qm', 'base']);
  git(['push', '-q', 'origin', 'main']);
  git(['switch', '-qc', 'aps/TS-C-0001']);
  writeFileSync(join(project, 'feature.txt'), 'feature\n');
  git(['add', 'feature.txt']);
  git([...identity, 'commit', '-qm', 'feature']);
  const head = git(['rev-parse', 'HEAD']);
  git(['switch', '-q', 'main']);
  git(['merge', '-q', '--squash', 'aps/TS-C-0001']);
  git([...identity, 'commit', '-qm', 'feature (#7)']);
  const squash = git(['rev-parse', 'HEAD']);
  git(['push', '-q', 'origin', 'main']);
  // origin/main is refreshed by the command's own fetch; start from a stale tracking ref to prove it fetches.
  git(['update-ref', 'refs/remotes/origin/main', `${squash}~1`]);

  function run(args: string[], status = 0) {
    const result = spawnSync(process.execPath, [bin, 'aps', ...args, '--json'], { cwd: home, env, encoding: 'utf8' });
    assert.equal(result.status, status, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return { ...result, value: result.stdout.trim() ? JSON.parse(result.stdout) : null };
  }
  run(['init']);
  run(['project', 'add', 'test', '--prefix', 'TS', '--name', 'Test']);
  const agent = (name: string, layer: string) =>
    run(['agent', 'new', '--name', name, '--layer', layer, '--model', 'sol', '--vendor', 'test']).value.id;
  const manager = agent('manager', 'L1');
  const worker = agent('worker', 'L2');
  env.APS_AGENT = manager;
  const acceptance = join(home, 'acceptance.json');
  writeFileSync(acceptance, JSON.stringify([{ id: 'AC1', text: 'Works', command: 'echo yes', expect: 'yes' }]));
  const evidence = join(home, 'evidence.json');
  writeFileSync(evidence, JSON.stringify([{ ac: 'AC1', command: 'echo yes', output: 'yes', ok: true }]));

  /** A card reviewed (accept) at `head`, so recordReview leaves it in merge_wait. */
  function mergeWait(extra: string[] = []) {
    const id = run([
      'card',
      'new',
      '--project',
      'test',
      '--title',
      'Example',
      '--kind',
      'mech',
      '--size',
      'S',
      '--scope',
      'CLI',
      '--acceptance',
      acceptance,
      '--forbidden',
      'paid calls',
      '--owner',
      manager,
      '--assignee',
      worker,
      ...extra,
    ]).value[0].card;
    run(['start', id, '--assignee', worker]);
    run([
      'report',
      id,
      '--by',
      worker,
      '--sha',
      head,
      '--branch',
      `aps/${id}`,
      '--files',
      '[]',
      '--evidence',
      evidence,
      '--status',
      'DONE',
    ]);
    run(['close-session', worker, '--note', 'ended']);
    run(['review', id, '--verdict', 'accept']);
    return id;
  }
  function gh(view: Record<string, unknown>) {
    writeFileSync(
      ghFixture,
      JSON.stringify({
        state: 'MERGED',
        mergedAt: '2026-10-17T00:00:00Z',
        headRefOid: head,
        mergeCommit: { oid: squash },
        baseRefName: 'main',
        url: 'https://github.com/test/repo/pull/7',
        ...view,
      }),
    );
  }
  const merge = (id: string, extra: string[] = [], status = 0) =>
    run(
      ['merge', id, '--pr', '7', '--repo', 'test/repo', '--project', 'test', '--project-dir', project, ...extra],
      status,
    );
  function ledger(id: string) {
    const db = openApsDb(env.APS_DB);
    try {
      return {
        state: String(db.prepare('SELECT state FROM cards WHERE id=?').get(id)?.state),
        merges: db.prepare('SELECT * FROM merges WHERE card_id=? ORDER BY id').all(id),
      };
    } finally {
      db.close();
    }
  }
  return { home, ghLog, head, squash, git, run, mergeWait, gh, merge, ledger };
}

test('aps merge --pr records a squash merge of the reviewed head, then reruns idempotently into done', (t) => {
  const f = fixture(t);
  const id = f.mergeWait();
  f.gh({});
  const first = f.merge(id);
  assert.equal(first.value.recorded, true);
  assert.equal(first.value.state, 'merge_wait');
  assert.equal(first.value.done_blocked, null);
  assert.deepEqual(JSON.parse(readFileSync(f.ghLog, 'utf8').trim()), [
    'pr',
    'view',
    '7',
    '-R',
    'test/repo',
    '--json',
    'state,mergedAt,headRefOid,mergeCommit,baseRefName,url',
  ]);
  let rows = f.ledger(id).merges;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sha, f.head);
  assert.equal(rows[0].merged_sha, f.squash);
  assert.equal(rows[0].applied_ref, `merge:7@${f.head}`);
  assert.equal(rows[0].target, 'main');
  assert.match(String(rows[0].verify_command), new RegExp(`^merge:7@${f.head} gh pr view 7 -R test/repo`));

  const second = f.merge(id, ['--done']);
  assert.equal(second.value.recorded, false);
  assert.equal(second.value.merge_id, first.value.merge_id);
  assert.equal(second.value.state, 'done');
  const third = f.merge(id, ['--done']);
  assert.equal(third.value.recorded, false);
  assert.equal(third.value.state, 'done');
  rows = f.ledger(id).merges;
  assert.equal(rows.length, 1);
  assert.equal(f.ledger(id).state, 'done');
});

test('aps merge --pr refuses a PR head that is not the reviewed sha (H11)', (t) => {
  const f = fixture(t);
  const id = f.mergeWait();
  const other = 'b'.repeat(40);
  f.gh({ headRefOid: other });
  const refused = f.merge(id, ['--done'], 3);
  assert.equal(refused.stderr.trim(), `[mmbridge] APS-H11: PR head ${other} is not the reviewed sha ${f.head}`);
  assert.deepEqual(f.ledger(id), { state: 'merge_wait', merges: [] });
});

test('aps merge --pr refuses a PR that is not MERGED (H12)', (t) => {
  const f = fixture(t);
  const id = f.mergeWait();
  f.gh({ state: 'OPEN', mergedAt: null, mergeCommit: null });
  assert.equal(f.merge(id, [], 3).stderr.trim(), '[mmbridge] APS-H12: PR #7 is OPEN, not MERGED');
  assert.deepEqual(f.ledger(id), { state: 'merge_wait', merges: [] });
});

test('aps merge --pr refuses a merge commit that is not on origin/<base> (H13)', (t) => {
  const f = fixture(t);
  const id = f.mergeWait();
  f.gh({ mergeCommit: { oid: f.head } });
  assert.equal(f.merge(id, [], 3).stderr.trim(), `[mmbridge] APS-H13: merge commit ${f.head} is not on origin/main`);
  assert.deepEqual(f.ledger(id), { state: 'merge_wait', merges: [] });
});

test('aps merge --pr refuses when git fetch fails even if the cached origin/<base> has the merge commit (H13)', (t) => {
  const f = fixture(t);
  const id = f.mergeWait();
  f.gh({});
  f.git(['update-ref', 'refs/remotes/origin/main', f.squash]);
  f.git(['remote', 'set-url', 'origin', join(f.home, 'missing-origin.git')]);
  const refused = f.merge(id, ['--done'], 3);
  assert.match(
    refused.stderr,
    new RegExp(
      `\\[mmbridge\\] APS-H13: cannot verify merge commit ${f.squash} on origin/main: git fetch origin main failed`,
    ),
  );
  assert.deepEqual(f.ledger(id), { state: 'merge_wait', merges: [] });
});

test('aps merge --pr --done blocked by needs_owner keeps the merge row and merge_wait', (t) => {
  const f = fixture(t);
  const id = f.mergeWait(['--needs-owner', '1']);
  f.gh({});
  const result = f.merge(id, ['--done']);
  assert.equal(result.value.recorded, true);
  assert.equal(result.value.state, 'merge_wait');
  assert.match(result.value.done_blocked, /^APS-D05: /);
  assert.match(result.stderr, /\[mmbridge\] done blocked: APS-D05: done requires an owner OK/);
  const after = f.ledger(id);
  assert.equal(after.state, 'merge_wait');
  assert.equal(after.merges.length, 1);
});

test('aps merge --pr input validation', (t) => {
  const f = fixture(t);
  const id = f.mergeWait();
  f.gh({});
  f.merge(id, ['--merged-sha', f.squash], 2);
  for (const pr of ['0', '7x', '12345678901'])
    assert.match(f.run(['merge', id, '--pr', pr], 2).stderr, /--pr must be a positive pull request number/);
  assert.match(f.merge(id, ['--repo', 'bad repo'], 2).stderr, /--repo must look like owner\/name/);
  assert.match(f.merge(id, ['--project', 'other'], 2).stderr, /card TS-C-0001 belongs to project test, not other/);
  assert.deepEqual(f.ledger(id), { state: 'merge_wait', merges: [] });
  assert.throws(() => parsePrView('{"headRefOid":"zz","baseRefName":"main"}'), /headRefOid is not a sha/);
  assert.throws(
    () => parsePrView(JSON.stringify({ headRefOid: f.head, baseRefName: '--upload-pack=x' })),
    /baseRefName is not a branch/,
  );
});
