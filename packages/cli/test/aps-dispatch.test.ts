import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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
    // Hermetic: workers spawn by bare name, so a broken fake must not fall through to a real CLI.
    PATH: `${fakebin}:${dirname(process.execPath)}:/usr/bin:/bin`,
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
  // Headless omp: zai models hit the real GLM usage-limit text; everything else keeps running.
  writeFileSync(
    join(fakebin, 'omp'),
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const model = args[args.indexOf('--model') + 1];
fs.appendFileSync(process.env.DISPATCH_TEST_HOME + '/omp.jsonl', JSON.stringify({args, cwd: process.cwd()}) + '\\n');
if (model.startsWith('zai/')) {
  console.error('Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"[1308][Usage limit reached for 5 hour]"}}');
  process.exit(1);
}
setTimeout(() => {}, 4000);
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
    assert.ok(invocation.args.includes(harness === 'devin' ? 'dangerous' : 'acceptEdits'));
    if (harness === 'devin') assert.ok(invocation.args.join(' ').includes('--respect-workspace-trust false'));
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

test('omp without --omp-id runs headless with omp fallback chains disabled', async (t) => {
  const f = fixture(t);
  const { value } = f.run([], 0, 'omp');
  assert.ok(Number.isInteger(value.pid) && value.pid > 0);
  assert.equal(value.session_ref, join(value.packet, 'session'));
  assert.match(
    readFileSync(join(value.packet, 'omp-config.yml'), 'utf8'),
    /usageAwareFallback: false[\s\S]*"test-model": \[\]/,
  );
  const calls = join(f.home, 'omp.jsonl');
  // Detached OS-process integration: await the fake worker's filesystem evidence, not a guessed sleep.
  const watcher = watch(f.home);
  try {
    const signal = AbortSignal.timeout(5000);
    while (!existsSync(calls)) await once(watcher, 'change', { signal });
  } finally {
    watcher.close();
  }
  const { args, cwd } = JSON.parse(readFileSync(calls, 'utf8').split('\n')[0]);
  assert.equal(cwd, f.worktree);
  assert.deepEqual(args.slice(0, 4), ['-p', '--no-title', '--auto-approve', '--mode']);
  assert.equal(args[args.indexOf('--config') + 1], join(value.packet, 'omp-config.yml'));
  assert.match(args.at(-1), /Read .*card\.md and follow it exactly/);
});

test('omp --omp-id keeps task-prompt mode', (t) => {
  const f = fixture(t);
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

const usageFixture = resolve(import.meta.dirname, '../../aps/test/fixtures/omp-usage.json');
function auto(f: { home: string; worktree: string; env: NodeJS.ProcessEnv }, extra: string[], status = 0) {
  const registry = join(f.home, 'workers.json');
  const spec = (id: string, vendor: string, provider: string, model: string) => ({
    id,
    tier: 'L3',
    vendor,
    provider,
    harness: 'omp',
    model,
    agent: null,
    roles: ['mech'],
  });
  writeFileSync(
    registry,
    JSON.stringify([
      spec('glm', 'zai', 'zai', 'zai/glm-5.3:high'),
      spec('gemini-flash', 'google', 'google-antigravity', 'google-antigravity/gemini-3.8-flash'),
    ]),
  );
  const args = [bin, 'aps', 'dispatch', card, '--db', String(f.env.APS_DB), '--worktree', f.worktree, '--auto'];
  args.push(
    '--workers',
    'glm,gemini-flash',
    '--workers-file',
    registry,
    '--quota-json',
    usageFixture,
    '--json',
    ...extra,
  );
  const result = spawnSync(process.execPath, args, { env: f.env, cwd: f.home, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, status, `${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

test('--auto skips a quota-blocked provider and writes nothing on --dry-run', (t) => {
  const f = fixture(t);
  const value = auto(f, ['--dry-run']);
  assert.deepEqual(value.skipped, [{ id: 'glm', reason: 'quota: ZAI 5 Hours Token Quota: 0% left' }]);
  assert.equal(value.worker, 'gemini-flash');
  assert.equal(value.launched.model, 'google-antigravity/gemini-3.8-flash');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM worker_runs').get()?.n, 0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM quota_samples').get()?.n, 0);
});

test('--auto falls back when a worker exits with a usage limit and records it in the ledger', (t) => {
  const f = fixture(t);
  const value = auto(f, ['--ignore-quota', '--probe', '2']);
  assert.deepEqual(
    value.attempts.map((attempt: { worker: string; result: string }) => [attempt.worker, attempt.result]),
    [
      ['glm', 'fallback'],
      ['gemini-flash', 'launched'],
    ],
  );
  assert.match(value.attempts[0].reason, /^usage-limit: .*Usage limit reached/);
  const events = f.db
    .prepare(
      'SELECT r.model, e.status, e.detail_json FROM run_events e JOIN worker_runs r ON r.id=e.run_id ORDER BY e.id',
    )
    .all()
    .map((row) => [
      row.model,
      row.status,
      row.status === 'failed' ? JSON.parse(String(row.detail_json)).fallback : null,
    ]);
  assert.deepEqual(events, [
    ['zai/glm-5.3:high', 'intent', null],
    ['zai/glm-5.3:high', 'launched', null],
    ['zai/glm-5.3:high', 'failed', 'usage-limit'],
    ['google-antigravity/gemini-3.8-flash', 'intent', null],
    ['google-antigravity/gemini-3.8-flash', 'launched', null],
  ]);
  const cardRow = f.db.prepare('SELECT state, attempt FROM cards').get();
  assert.deepEqual([cardRow?.state, cardRow?.attempt], ['working', 2]);
  assert.match(
    String(f.db.prepare("SELECT note FROM transitions WHERE from_state='working' AND to_state='issued'").get()?.note),
    /fallback usage-limit: glm/,
  );
  const zai = f.db.prepare("SELECT value FROM quota_samples WHERE vendor='zai' AND metric='ZAI 5 Hours Token Quota'");
  assert.equal(zai.get()?.value, 1);
});

test('audit flags premium mech lanes from the ledger, writes --out and exits 4', (t) => {
  const f = fixture(t);
  f.run(['--model', 'openai-codex/gpt-6.1-sol:high'], 0, 'omp');
  const out = join(f.home, 'reports', 'aps-audit-latest.md');
  const args = [bin, 'audit', '--db', String(f.env.APS_DB), '--no-herdr', '--quota-json', usageFixture, '--out', out];
  const result = spawnSync(process.execPath, [...args, '--json'], { env: f.env, cwd: f.home, encoding: 'utf8' });
  assert.equal(result.status, 4, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.violations.map((violation: { code: string }) => violation.code).sort(), [
    'L3_RATIO',
    'MECH_ON_PREMIUM',
  ]);
  assert.match(readFileSync(out, 'utf8'), /MECH_ON_PREMIUM[\s\S]*## Probes/);
  const before = f.db.prepare('SELECT count(*) AS n FROM run_events').get()?.n;
  spawnSync(process.execPath, args, { env: f.env, cwd: f.home, encoding: 'utf8' });
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM run_events').get()?.n, before);
});
