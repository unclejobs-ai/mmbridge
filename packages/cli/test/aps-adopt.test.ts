import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { openApsDb, recordReport, startCard } from '@mmbridge/aps';

const bin = resolve(import.meta.dirname, '../dist/bin/mmbridge.js');
const card = 'TS-C-0001';
const acceptance = '[{"id":"AC1","text":"Works","command":"echo yes","expect":"yes"}]';
const NO_REPORT = 'adopted lane ended without report; record aps report';

const FAKE_HERDR = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const home = process.env.ADOPT_TEST_HOME;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(home, 'calls.jsonl'), JSON.stringify(args) + '\\n');
const stateFile = path.join(home, 'herdr-state.json');
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
if (args.slice(0, 2).join(' ') === 'pane get') {
  if (state.closed) {
    console.error(JSON.stringify({error:{code:'pane_not_found'}}));
    process.exit(1);
  }
  console.log(JSON.stringify({result:{pane:{
    pane_id: args[2], terminal_id: 'terminal-1', tab_id: 'tab-1', workspace_id: 'w1', agent_status: 'working'
  }}}));
  process.exit(0);
}
console.log(JSON.stringify({result:{ok:true}}));
`;

function fixture(t: TestContext, origin = true) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'aps-adopt-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const worktree = join(home, 'worker tree');
  const fakebin = join(home, 'bin');
  mkdirSync(worktree);
  mkdirSync(fakebin);
  const env = {
    ...process.env,
    HOME: home,
    APS_AGENT: 'mgr',
    NODE_NO_WARNINGS: '1',
    PATH: `${fakebin}:${process.env.PATH}`,
    APS_DB: join(home, 'aps.db'),
    MMBRIDGE_APS_DB: '',
    ADOPT_TEST_HOME: home,
  };
  function git(args: string[]) {
    const result = spawnSync('git', ['-C', worktree, ...args], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  git(['init', '-b', 'worker']);
  git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'initial']);
  git(['branch', 'main']);
  if (origin) git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  const db = openApsDb(env.APS_DB);
  db.exec(`INSERT INTO projects(id,prefix,name) VALUES('test','TS','Test');
    INSERT INTO agents(id,name,layer,model,vendor) VALUES
      ('mgr','manager','L1','test','test'),
      ('worker','lane','L3','agent-model','test'),
      ('other','other','L3','other-model','test');
    INSERT INTO cards(id,project,title,kind,size,scope,acceptance_json,forbidden,needs_owner,needs_vision,layer_owner)
    VALUES('${card}','test','Adopt test','mech','S','CLI','${acceptance}','paid calls',0,0,'mgr');`);
  t.after(() => db.close());
  writeFileSync(join(fakebin, 'herdr'), FAKE_HERDR, { mode: 0o755 });

  function adopt(extra: string[] = [], status = 0) {
    const result = spawnSync(
      process.execPath,
      [
        bin,
        'aps',
        'adopt',
        card,
        '--db',
        env.APS_DB,
        '--by',
        'mgr',
        '--agent',
        'worker',
        '--worktree',
        worktree,
        '--branch',
        'worker',
        ...extra,
        '--json',
      ],
      { env, cwd: home, encoding: 'utf8', timeout: 20_000 },
    );
    assert.equal(result.status, status, `${result.stdout}\n${result.stderr}`);
    return { ...result, value: status === 0 && result.stdout.trim() ? JSON.parse(result.stdout) : null };
  }

  function collect(args: string[] = [card], status = 0) {
    const result = spawnSync(
      process.execPath,
      [bin, 'aps', 'collect', ...args, '--db', env.APS_DB, '--by', 'mgr', '--json'],
      { env, cwd: home, encoding: 'utf8', timeout: 20_000 },
    );
    assert.equal(result.status, status, `${result.stdout}\n${result.stderr}`);
    return { ...result, value: result.stdout.trim() ? JSON.parse(result.stdout) : null };
  }

  function herdrState(state: Record<string, unknown>) {
    writeFileSync(join(home, 'herdr-state.json'), JSON.stringify(state));
  }

  const runCount = () => db.prepare('SELECT count(*) AS n FROM worker_runs').get()?.n;

  return { home, worktree, env, db, git, adopt, collect, herdrState, runCount };
}

function sleeper(t: TestContext) {
  const child = spawn('sleep', ['60']);
  t.after(() => {
    if (child.exitCode === null) child.kill();
  });
  return child;
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
  const pid = child.pid as number;
  await once(child, 'exit');
  return pid;
}

test('issued card starts working and records intent plus adopted launch', (t) => {
  const f = fixture(t);
  const child = sleeper(t);
  const pid = child.pid as number;
  const session = join(f.home, 'session.jsonl');
  const { value } = f.adopt(['--pid', String(pid), '--session-ref', session]);
  assert.match(value.run, /^TS-C-0001-a1-adopt-\d{14}$/);
  const cardRow = f.db.prepare('SELECT state, assignee, attempt FROM cards WHERE id=?').get(card);
  assert.equal(cardRow?.state, 'working');
  assert.equal(cardRow?.assignee, 'worker');
  assert.equal(cardRow?.attempt, 1);
  const run = f.db.prepare('SELECT * FROM worker_runs WHERE id=?').get(value.run);
  assert.equal(run?.harness, 'omp');
  assert.equal(run?.kind, null);
  assert.equal(run?.model, 'agent-model');
  assert.equal(run?.created_by, 'mgr');
  assert.equal(run?.branch, 'worker');
  assert.equal(run?.worktree, f.worktree);
  assert.equal(run?.base_sha, f.git(['merge-base', 'HEAD', 'origin/main']));
  assert.equal(run?.packet_dir, join(f.home, 'dispatch', value.run));
  assert.deepEqual(
    f.db
      .prepare('SELECT status FROM run_events WHERE run_id=? ORDER BY id')
      .all(value.run)
      .map((row) => row.status),
    ['intent', 'launched'],
  );
  const launched = JSON.parse(
    String(
      f.db.prepare("SELECT detail_json FROM run_events WHERE run_id=? AND status='launched'").get(value.run)
        ?.detail_json,
    ),
  );
  assert.deepEqual(launched, { adopted: true, pid, session_ref: session });
  const facts = JSON.parse(readFileSync(join(value.packet_dir, 'adopt.json'), 'utf8'));
  assert.equal(facts.run, value.run);
  assert.equal(facts.adopted, true);
  assert.equal(facts.pid, pid);
  assert.equal(facts.session_ref, session);
  assert.equal(facts.base_sha, run?.base_sha);
  assert.equal(facts.created_by, 'mgr');
});

test('card assigned to another agent is refused', (t) => {
  const f = fixture(t);
  startCard(f.db, card, 'other');
  const pid = sleeper(t).pid as number;
  const refused = f.adopt(['--pid', String(pid)], 2);
  assert.match(refused.stderr, /assigned to other, not worker/);
  assert.equal(f.db.prepare('SELECT assignee FROM cards WHERE id=?').get(card)?.assignee, 'other');
  assert.equal(f.runCount(), 0);
});

test('neither --pid nor --pane exits 2', (t) => {
  const f = fixture(t);
  const refused = f.adopt([], 2);
  assert.match(refused.stderr, /at least one of --pid or --pane is required/);
  assert.equal(f.runCount(), 0);
});

test('dead pid is refused', async (t) => {
  const f = fixture(t);
  const pid = await deadPid();
  const refused = f.adopt(['--pid', String(pid)], 2);
  assert.match(refused.stderr, new RegExp(`--pid ${pid} is not alive`));
  assert.equal(f.runCount(), 0);
});

test('second adopt on a live run is APS-N01', (t) => {
  const f = fixture(t);
  const pid = String(sleeper(t).pid);
  f.adopt(['--pid', pid]);
  const refused = f.adopt(['--pid', pid], 3);
  assert.match(refused.stderr, /APS-N01: card already has a live run/);
  assert.equal(f.runCount(), 1);
});

test('pane present defaults harness to herdr; absent pane exits 2', (t) => {
  const f = fixture(t);
  f.herdrState({ closed: true });
  const absent = f.adopt(['--pane', 'w1:p9'], 2);
  assert.match(absent.stderr, /--pane w1:p9 is not present/);
  assert.equal(f.runCount(), 0);
  f.herdrState({ closed: false });
  const { value } = f.adopt(['--pane', 'w1:p9']);
  const run = f.db.prepare('SELECT harness, kind FROM worker_runs WHERE id=?').get(value.run);
  assert.equal(run?.harness, 'herdr');
  assert.equal(run?.kind, 'omp');
  const launched = JSON.parse(
    String(
      f.db.prepare("SELECT detail_json FROM run_events WHERE run_id=? AND status='launched'").get(value.run)
        ?.detail_json,
    ),
  );
  assert.deepEqual(launched, { adopted: true, pane_id: 'w1:p9' });
});

test('base sha falls back to main and honors --base-sha', (t) => {
  const f = fixture(t, false);
  const pid = String(sleeper(t).pid);
  const fallback = f.adopt(['--pid', pid]);
  assert.equal(fallback.value.base_sha, f.git(['merge-base', 'HEAD', 'main']));
  const explicit = 'b'.repeat(40);
  const second = fixture(t);
  const again = second.adopt(['--pid', String(sleeper(t).pid), '--base-sha', explicit]);
  assert.equal(again.value.base_sha, explicit);
});

test('collect of an adopted run stays running while alive and blocks when the pid is gone without a report', async (t) => {
  const f = fixture(t);
  const child = sleeper(t);
  const pid = child.pid as number;
  const { value } = f.adopt(['--pid', String(pid), '--pane', 'w1:p9']);
  f.herdrState({ closed: true });
  const running = f.collect();
  assert.equal(running.value.outcome, 'running');
  assert.equal(running.value.message, 'running');
  assert.equal(f.db.prepare('SELECT status FROM v_run_current WHERE run_id=?').get(value.run)?.status, 'launched');
  assert.equal(
    f.db.prepare("SELECT count(*) AS n FROM run_events WHERE run_id=? AND status='failed'").get(value.run)?.n,
    0,
  );
  child.kill();
  await once(child, 'exit');
  const blocked = f.collect();
  assert.equal(blocked.value.outcome, 'blocked');
  assert.equal(blocked.value.message, NO_REPORT);
  assert.equal(f.db.prepare('SELECT status FROM v_run_current WHERE run_id=?').get(value.run)?.status, 'blocked');
  assert.equal(f.db.prepare('SELECT state FROM cards WHERE id=?').get(card)?.state, 'working');
  assert.equal(
    f.db.prepare("SELECT count(*) AS n FROM run_events WHERE run_id=? AND status='failed'").get(value.run)?.n,
    0,
  );
});

test('collect closes an adopted run that already has a report for the attempt', async (t) => {
  const f = fixture(t);
  const child = sleeper(t);
  const { value } = f.adopt(['--pid', String(child.pid)]);
  recordReport(f.db, card, {
    by_agent: 'worker',
    recorded_by: 'mgr',
    sha: f.git(['rev-parse', 'HEAD']),
    branch: 'worker',
    pr_url: null,
    files_json: JSON.stringify(['src/x.ts']),
    evidence_json: JSON.stringify([{ ac: 'AC1', command: 'echo yes', output: 'yes', ok: true }]),
    risks: '',
    status: 'DONE',
    body_md: '',
  });
  child.kill();
  await once(child, 'exit');
  const closed = f.collect();
  assert.equal(closed.value.outcome, 'reported');
  assert.equal(f.db.prepare('SELECT state FROM cards WHERE id=?').get(card)?.state, 'closed_session');
  assert.equal(f.db.prepare('SELECT status FROM v_run_current WHERE run_id=?').get(value.run)?.status, 'closed');
});
