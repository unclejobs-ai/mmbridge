import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { openApsDb } from '@mmbridge/aps';

const bin = resolve(import.meta.dirname, '../dist/bin/mmbridge.js');
const card = 'TS-C-0001';
function fixture(t: TestContext) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'aps-dispatch-')));
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
    DISPATCH_TEST_HOME: home,
    FAIL_STEP: '',
  };
  function git(args: string[]) {
    const result = spawnSync('git', ['-C', worktree, ...args], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  git(['init', '-b', 'worker']);
  git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'initial']);
  const db = openApsDb(env.APS_DB);
  db.exec(`INSERT INTO projects(id,prefix,name) VALUES('test','TS','Test');
    INSERT INTO agents(id,name,layer,model,vendor) VALUES('mgr','manager','L1','test','test');
    INSERT INTO cards(id,project,title,kind,size,scope,acceptance_json,forbidden,needs_owner,needs_vision,layer_owner)
    VALUES('${card}','test','Dispatch test','mech','S','CLI','[{"id":"AC1","text":"Works","command":"echo yes","expect":"yes"}]','paid calls',0,0,'mgr');`);
  t.after(() => db.close());
  writeFileSync(
    join(fakebin, 'herdr'),
    `#!${process.execPath}
const fs = require('node:fs');
const {DatabaseSync} = require('node:sqlite');
const path = require('node:path');
const home = process.env.DISPATCH_TEST_HOME;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(home, 'calls.jsonl'), JSON.stringify(args) + '\\n');
const stateFile = path.join(home, 'herdr.json');
let state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile)) : {};
const step = args.slice(0,2).join(' ');
const reply = result => console.log(JSON.stringify({result}));
if (step === 'workspace list') { reply({workspaces:[{workspace_id:'w1',label:'test'}]}); process.exit(0); }
// Launch must happen after intent commits and without the ledger write lock.
const db = new DatabaseSync(process.env.APS_DB);
db.exec('PRAGMA busy_timeout=100; BEGIN IMMEDIATE');
const run = db.prepare('SELECT * FROM v_run_current').get();
if (!run || run.status !== 'intent') throw Error('missing committed intent');
db.exec('ROLLBACK'); db.close();
if (step === process.env.FAIL_STEP) {
  const error = JSON.stringify({error:{code:'fake_failure'}});
  console.error(error);
  process.exit(1);
}
if (step === 'agent start' || step === 'agent prompt') {
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(args[2])) {
    console.error(JSON.stringify({error:{code:'invalid_agent_name'}})); process.exit(1);
  }
}
const pane = {pane_id:'w1:p1',terminal_id:'terminal-1',tab_id:'tab-1',workspace_id:'w1',agent_status:'working',agent_session:{value:'/synthetic/task.jsonl'}};
if (step === 'tab create') { state.label = args[args.indexOf('--label')+1]; fs.writeFileSync(stateFile, JSON.stringify(state)); reply({type:'unverified_create_shape'}); }
else if (step === 'tab list') reply({tabs:[{tab_id:'tab-1',workspace_id:'w1',label:state.label}]});
else if (step === 'pane list') reply({panes:[pane]});
else if (step === 'pane get') reply({pane});
else if (step === 'pane close') { state.closed = true; fs.writeFileSync(stateFile, JSON.stringify(state)); reply({closed:true}); }
else reply({ok:true});
`,
    { mode: 0o755 },
  );
  for (const name of ['devin', 'grok'])
    writeFileSync(
      join(fakebin, name),
      `#!${process.execPath}
const fs = require('node:fs');
const {DatabaseSync} = require('node:sqlite');
const db = new DatabaseSync(process.env.APS_DB); db.exec('PRAGMA busy_timeout=100; BEGIN IMMEDIATE');
if (!db.prepare("SELECT 1 FROM run_events WHERE status='intent'").get()) throw Error('missing intent');
db.exec('ROLLBACK'); db.close();
fs.writeFileSync(process.env.DISPATCH_TEST_HOME + '/${name}.json', JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}));
console.log('fake output'); process.exit(${name === 'devin' ? 0 : 7});
`,
      { mode: 0o755 },
    );
  function run(extra: string[] = [], status = 0, harness = 'herdr', json = true) {
    const args = [
      bin,
      'aps',
      'dispatch',
      card,
      '--db',
      env.APS_DB,
      '--harness',
      harness,
      '--lane',
      'worker',
      '--layer',
      'L2',
      '--model',
      'test-model',
      '--worktree',
      worktree,
      ...(harness === 'herdr' ? ['--kind', 'omp'] : []),
      ...extra,
      ...(json ? ['--json'] : []),
    ];
    const result = spawnSync(process.execPath, args, { env, cwd: home, encoding: 'utf8', timeout: 20_000 });
    assert.equal(result.status, status, `${result.stdout}\n${result.stderr}`);
    return { ...result, value: json && result.stdout.trim() ? JSON.parse(result.stdout) : null };
  }
  return { home, worktree, env, db, git, run };
}

test('dispatch herdr records intent then launched with pane+terminal and collect packet', (t) => {
  const f = fixture(t);
  const { value } = f.run();
  assert.equal(value.pane, 'w1:p1');
  assert.equal(value.terminal_id, 'terminal-1');
  assert.equal(value.session_ref, '/synthetic/task.jsonl');
  assert.deepEqual(
    f.db
      .prepare('SELECT status FROM run_events ORDER BY id')
      .all()
      .map((row) => row.status),
    ['intent', 'launched'],
  );
  assert.equal(f.db.prepare('SELECT herdr_pane FROM agents WHERE id=?').get(value.agent)?.herdr_pane, value.pane);
  const prompt = readFileSync(join(value.packet, 'card.md'), 'utf8');
  for (const text of [
    'Collect contract',
    value.run,
    'report.json.tmp',
    'COMPLETION-REPORT',
    'Do not run aps report',
    'Attempt: 1',
  ])
    assert.ok(prompt.includes(text), text);
  const schema = JSON.parse(readFileSync(join(value.packet, 'report.schema.json'), 'utf8'));
  assert.equal(schema.properties.run.const, value.run);
  assert.equal(schema.properties.attempt.const, 1);
  assert.equal(schema.oneOf[1].required[0], 'risks');
  const metadata = JSON.parse(readFileSync(join(value.packet, 'dispatch.json'), 'utf8'));
  assert.equal(metadata.base_sha, f.git(['rev-parse', 'HEAD']));
  assert.equal(metadata.branch, 'worker');
  assert.match(value.herdr_name, /^[a-z][a-z0-9_-]{0,31}$/);
  assert.notEqual(value.herdr_name, value.run);
  assert.equal(metadata.herdr_name, value.herdr_name);
  assert.match(readFileSync(join(value.packet, 'dispatch.log'), 'utf8'), /agent.*prompt/);
  const calls = readFileSync(join(f.home, 'calls.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    calls.map((args) => args.slice(0, 2).join(' ')),
    ['workspace list', 'tab create', 'tab list', 'pane list', 'agent start', 'agent prompt', 'pane get'],
  );
  assert.equal(calls.find((args) => args[0] === 'agent' && args[1] === 'start')[2], value.herdr_name);
  assert.equal(calls.find((args) => args[0] === 'agent' && args[1] === 'prompt')[2], value.herdr_name);
});

test('dispatch failure returns card to issued and records failed with pane cleanup', (t) => {
  const f = fixture(t);
  f.env.FAIL_STEP = 'agent prompt';
  assert.match(f.run([], 1).stderr, /dispatch failed: agent prompt/);
  assert.equal(f.db.prepare('SELECT state FROM cards').get()?.state, 'issued');
  const events = f.db.prepare('SELECT status,detail_json FROM run_events ORDER BY id').all();
  assert.deepEqual(
    events.map((row) => row.status),
    ['intent', 'failed'],
  );
  assert.equal(JSON.parse(String(events[1].detail_json)).cleanup[0].pane, 'w1:p1');
  assert.equal(f.db.prepare("SELECT status FROM agents WHERE name='worker'").get()?.status, 'closed');
  assert.equal(JSON.parse(readFileSync(join(f.home, 'herdr.json'), 'utf8')).closed, true);
});

test('dispatch preserves herdr stderr error code and compensates the failed launch', (t) => {
  const f = fixture(t);
  f.env.FAIL_STEP = 'agent start';
  const result = f.run([], 1);
  assert.match(result.stderr, /herdr agent start failed: fake_failure/);
  assert.doesNotMatch(result.stderr, /Unexpected end of JSON/);
  assert.equal(f.db.prepare('SELECT state FROM cards').get()?.state, 'issued');
  const failed = f.db.prepare("SELECT detail_json FROM run_events WHERE status='failed'").get();
  assert.match(JSON.parse(String(failed?.detail_json)).error, /fake_failure/);
  assert.equal(JSON.parse(readFileSync(join(f.home, 'herdr.json'), 'utf8')).closed, true);
});

test('dispatch packet failure returns card to issued before spawning', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.home, 'dispatch'), 'not a directory');
  f.run([], 1);
  assert.equal(f.db.prepare('SELECT state FROM cards').get()?.state, 'issued');
  assert.equal(f.db.prepare('SELECT status FROM v_run_current').get()?.status, 'failed');
  assert.equal(readFileSync(join(f.home, 'calls.jsonl'), 'utf8').trim().split('\n').length, 1);
});

test('dispatch refuses dirty worktree (exit 2)', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.worktree, 'dirty'), 'change');
  assert.match(f.run([], 2).stderr, /worktree must be clean/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM worker_runs').get()?.n, 0);
});

test('dispatch refuses unknown workspace (exit 2)', (t) => {
  const f = fixture(t);
  assert.match(f.run(['--workspace', 'missing'], 2).stderr, /unknown or ambiguous herdr workspace/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM worker_runs').get()?.n, 0);
});

test('second dispatch of a working card returns APS-N01 (exit 3)', (t) => {
  const f = fixture(t);
  f.run();
  assert.match(f.run([], 3).stderr, /APS-N01: card already has a live run/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM worker_runs').get()?.n, 1);
});

for (const harness of ['devin', 'grok'])
  test(`${harness} spawn writes exit file and pid without a shell`, async (t) => {
    const f = fixture(t);
    const { value } = f.run([], 0, harness);
    assert.ok(Number.isInteger(value.pid) && value.pid > 0);
    const exit = join(value.packet, 'exit');
    // This is a detached OS-process integration: await filesystem evidence, not a guessed sleep.
    const watcher = watch(value.packet);
    try {
      const signal = AbortSignal.timeout(5000);
      while (!existsSync(exit)) await once(watcher, 'change', { signal });
    } finally {
      watcher.close();
    }
    assert.equal(readFileSync(exit, 'utf8').trim(), harness === 'devin' ? '0' : '7');
    const launched = JSON.parse(
      String(f.db.prepare("SELECT detail_json FROM run_events WHERE status='launched'").get()?.detail_json),
    );
    assert.equal(launched.pid, value.pid);
    const invocation = JSON.parse(readFileSync(join(f.home, `${harness}.json`), 'utf8'));
    assert.equal(invocation.cwd, f.worktree);
    assert.ok(invocation.args.includes(join(value.packet, 'card.md')));
    assert.ok(invocation.args.includes(harness === 'devin' ? 'accept-edits' : 'acceptEdits'));
    assert.match(readFileSync(join(value.packet, harness === 'devin' ? 'out.log' : 'out.json'), 'utf8'), /fake output/);
  });

test('headless executable spawn failure records failed and returns card to issued', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.home, 'bin', 'devin'), '#!/missing-dispatch-interpreter\n');
  assert.match(f.run([], 1, 'devin').stderr, /dispatch failed: devin spawn/);
  assert.equal(f.db.prepare('SELECT state FROM cards').get()?.state, 'issued');
  assert.equal(f.db.prepare('SELECT status FROM v_run_current').get()?.status, 'failed');
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM run_events WHERE status='launched'").get()?.n, 0);
});

test('detached supervisor keeps exit evidence when dispatch IPC disconnects before handshake', async (t) => {
  const f = fixture(t);
  const preview = f.run(['--dry-run'], 0, 'devin').value;
  const packet = join(f.home, 'ipc-lost');
  mkdirSync(packet);
  const supervisor = spawn(
    process.execPath,
    [
      '-e',
      preview.spawnArgv[0][2],
      process.execPath,
      JSON.stringify(['-e', 'process.stdout.write("harmless worker finished\\n")']),
      packet,
      'out.log',
    ],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
  );
  t.after(() => {
    if (supervisor.exitCode === null) supervisor.kill();
  });
  let stderr = '';
  supervisor.stderr?.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  supervisor.once('spawn', () => supervisor.disconnect());
  const [code, signal] = await once(supervisor, 'exit');
  assert.equal(code, 0, stderr);
  assert.equal(signal, null);
  assert.equal(readFileSync(join(packet, 'exit'), 'utf8').trim(), '0');
  assert.match(readFileSync(join(packet, 'out.log'), 'utf8'), /harmless worker finished/);
});

test('omp harness prints task prompt and requires --omp-id', (t) => {
  const f = fixture(t);
  assert.match(f.run([], 2, 'omp').stderr, /--omp-id is required/);
  const { value } = f.run(['--omp-id', 'TaskWorker'], 0, 'omp');
  assert.match(value.ompPrompt, /Yield when report.json is written/);
  assert.match(value.session_ref, /sessions\/\*\/\*\/TaskWorker.jsonl$/);
  assert.equal(value.omp_id, 'TaskWorker');
  assert.equal(f.db.prepare('SELECT status FROM v_run_current').get()?.status, 'launched');
  assert.equal(existsSync(join(f.home, 'calls.jsonl')), false);
});

test('--dry-run writes nothing and prints packet plus exact spawn argv', (t) => {
  const f = fixture(t);
  const before = f.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => [row.name, f.db.prepare(`SELECT count(*) AS n FROM ${row.name}`).get()?.n]);
  const { value } = f.run(['--dry-run']);
  assert.equal(value.dryRun, true);
  assert.equal(existsSync(join(f.home, 'dispatch')), false);
  assert.equal(value.spawnArgv[0][1], 'tab');
  assert.ok(value.cardMd.includes('Collect contract'));
  const after = before.map(([name]) => [name, f.db.prepare(`SELECT count(*) AS n FROM ${name}`).get()?.n]);
  assert.deepEqual(after, before);
  assert.equal(readFileSync(join(f.home, 'calls.jsonl'), 'utf8').trim().split('\n').length, 1);
});

test('dispatch refuses mismatched branch and invalid harness flags before intent', (t) => {
  const f = fixture(t);
  assert.match(f.run(['--branch', 'other'], 2).stderr, /checked-out worktree branch/);
  assert.match(f.run(['--permission-mode', 'auto'], 2).stderr, /not supported for omp/);
  assert.match(f.run(['--omp-id', '../escape'], 2, 'omp').stderr, /task agent ID/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM worker_runs').get()?.n, 0);
});
