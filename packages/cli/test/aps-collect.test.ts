import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { addRunEvent, createRun, newAgent, openApsDb, startCard } from '@mmbridge/aps';

const bin = resolve(import.meta.dirname, '../dist/bin/mmbridge.js');
const card = 'TS-C-0001';
const card2 = 'TS-C-0002';
let runCounter = 0;

const FAKE_HERDR = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const home = process.env.COLLECT_TEST_HOME;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(home, 'calls.jsonl'), JSON.stringify(args) + '\\n');
const stateFile = path.join(home, 'herdr-state.json');
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
const step = args.slice(0, 2).join(' ');
if (step === 'pane get') {
  if (state.closed && !state.surviveClose) {
    console.error(JSON.stringify({error: {code: 'pane_not_found'}}));
    process.exit(1);
  }
  console.log(JSON.stringify({result: {pane: {
    pane_id: args[2], terminal_id: 'terminal-1', tab_id: 'tab-1', workspace_id: 'w1',
    agent_status: state.agentStatus ?? 'done',
  }}}));
  process.exit(0);
}
if (step === 'pane close') {
  if (!state.surviveClose) {
    state.closed = true;
    fs.writeFileSync(stateFile, JSON.stringify(state));
  }
  console.log(JSON.stringify({result: {closed: true}}));
  process.exit(0);
}
console.log(JSON.stringify({result: {ok: true}}));
`;

function fixture(t: TestContext) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'aps-collect-')));
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
    COLLECT_TEST_HOME: home,
  };
  function git(args: string[]) {
    const result = spawnSync('git', ['-C', worktree, ...args], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  git(['init', '-b', 'worker']);
  git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'initial']);
  const db = openApsDb(env.APS_DB);
  const acceptance = '[{"id":"AC1","text":"Works","command":"echo yes","expect":"yes"}]';
  db.exec(`INSERT INTO projects(id,prefix,name) VALUES('test','TS','Test');
    INSERT INTO agents(id,name,layer,model,vendor) VALUES('mgr','manager','L1','test','test');
    INSERT INTO cards(id,project,title,kind,size,scope,acceptance_json,forbidden,needs_owner,needs_vision,layer_owner)
    VALUES('${card}','test','Collect test','mech','S','CLI','${acceptance}','paid calls',0,0,'mgr'),
          ('${card2}','test','Collect test 2','mech','S','CLI','${acceptance}','paid calls',0,0,'mgr');`);
  t.after(() => db.close());
  writeFileSync(join(fakebin, 'herdr'), FAKE_HERDR, { mode: 0o755 });

  function seedRun(cardId: string, detail: Record<string, unknown>, harness = 'herdr') {
    const worker = newAgent(db, { name: 'worker', layer: 'L3', model: 'test', vendor: 'test', project: 'test' });
    startCard(db, cardId, worker);
    const run = `${cardId}-a1-202610110000${String(runCounter++).padStart(2, '0')}`;
    const packet = join(home, 'dispatch', run);
    mkdirSync(packet, { recursive: true });
    createRun(db, {
      id: run,
      card_id: cardId,
      attempt: 1,
      agent_id: worker,
      harness,
      kind: harness === 'herdr' ? 'omp' : null,
      model: 'test',
      worktree,
      branch: 'worker',
      base_sha: git(['rev-parse', 'HEAD']),
      packet_dir: packet,
      created_by: 'mgr',
    });
    addRunEvent(db, run, 'launched', 'mgr', detail);
    return { run, worker, packet };
  }

  function herdrState(state: Record<string, unknown>) {
    writeFileSync(join(home, 'herdr-state.json'), JSON.stringify(state));
  }

  function writeReport(packet: string, values: Record<string, unknown>) {
    writeFileSync(join(packet, 'report.md'), '## report\n');
    writeFileSync(join(packet, 'report.json'), `${JSON.stringify(values)}\n`);
  }

  function reportValues(run: string, cardId: string, extra: Record<string, unknown> = {}) {
    return {
      run,
      card: cardId,
      attempt: 1,
      status: 'DONE',
      sha: git(['rev-parse', 'HEAD']),
      branch: 'worker',
      pr: null,
      files: ['src/x.ts'],
      evidence: [{ ac: 'AC1', command: 'echo yes', output: 'yes', ok: true }],
      ...extra,
    };
  }

  function usageJsonl(path: string, model = 'test/model') {
    const line = {
      type: 'message',
      message: {
        provider: 'test',
        model,
        usage: { input: 10, output: 5, cacheRead: 1, cacheWrite: 2, totalTokens: 18, cost: { total: 0.0123 } },
      },
    };
    writeFileSync(path, `${JSON.stringify(line)}\n`);
  }

  function collect(args: string[], status = 0) {
    const result = spawnSync(
      process.execPath,
      [bin, 'aps', 'collect', ...args, '--db', env.APS_DB, '--by', 'mgr', '--json'],
      { env, cwd: home, encoding: 'utf8', timeout: 30_000 },
    );
    assert.equal(result.status, status, `${result.stdout}\n${result.stderr}`);
    return { ...result, value: result.stdout.trim() ? JSON.parse(result.stdout) : null };
  }

  const runStatus = (run: string) => db.prepare('SELECT status FROM v_run_current WHERE run_id=?').get(run)?.status;
  const cardState = (cardId: string) => db.prepare('SELECT state FROM cards WHERE id=?').get(cardId)?.state;
  const agentStatus = (run: string) =>
    db.prepare('SELECT status FROM agents WHERE id=(SELECT agent_id FROM worker_runs WHERE id=?)').get(run)?.status;
  const runEvents = (run: string) =>
    db
      .prepare('SELECT status FROM run_events WHERE run_id=? ORDER BY id')
      .all(run)
      .map((row) => row.status);

  return {
    home,
    worktree,
    env,
    db,
    git,
    seedRun,
    herdrState,
    writeReport,
    reportValues,
    usageJsonl,
    collect,
    runStatus,
    cardState,
    agentStatus,
    runEvents,
  };
}

function liveSleep(t: TestContext) {
  const sleeper = spawn('sleep', ['60']);
  t.after(() => {
    if (sleeper.exitCode === null) sleeper.kill();
  });
  return sleeper.pid as number;
}

test('collect DONE: reported→closed_session, pane closed by collect, evidence stored', (t) => {
  const f = fixture(t);
  const session = join(f.home, 'session.jsonl');
  f.usageJsonl(session);
  const { run, packet } = f.seedRun(card, {
    pane_id: 'w1:p9',
    terminal_id: 'terminal-1',
    session_ref: session,
  });
  f.herdrState({ agentStatus: 'done' });
  f.writeReport(packet, f.reportValues(run, card));
  const { value } = f.collect([card]);
  assert.equal(value.outcome, 'reported');
  assert.equal(value.code, 0);
  assert.equal(f.runStatus(run), 'closed');
  assert.equal(f.cardState(card), 'closed_session');
  assert.equal(f.agentStatus(run), 'closed');
  assert.equal(JSON.parse(readFileSync(join(f.home, 'herdr-state.json'), 'utf8')).closed, true);
  const closed = JSON.parse(
    String(f.db.prepare("SELECT detail_json FROM run_events WHERE run_id=? AND status='closed'").get(run)?.detail_json),
  );
  assert.equal(closed.evidence.probe, 'herdr pane get');
  assert.equal(closed.evidence.closed_by_collect, true);
  const usage = f.db.prepare('SELECT * FROM run_usage WHERE run_id=?').get(run);
  assert.equal(usage?.source, 'omp-jsonl');
  assert.equal(usage?.basis, 'actual');
  assert.equal(usage?.model, 'test/model');
  assert.equal(usage?.cost_usd, 0.0123);
  const links = f.db
    .prepare('SELECT kind FROM card_links WHERE card_id=? ORDER BY id')
    .all(card)
    .map((row) => row.kind);
  assert.deepEqual(links, ['handoff']);
});

test('collect refuses while agent working (H06), retry after idle succeeds', (t) => {
  const f = fixture(t);
  const { run, packet } = f.seedRun(card, { pane_id: 'w1:p9', terminal_id: 'terminal-1' });
  f.herdrState({ agentStatus: 'working' });
  f.writeReport(packet, f.reportValues(run, card));
  const refused = f.collect([card], 3);
  assert.match(refused.stderr, /APS-H06: agent in pane w1:p9 is still working; not closing/);
  assert.equal(f.runStatus(run), 'reported');
  assert.equal(f.cardState(card), 'reported');
  f.herdrState({ agentStatus: 'done' });
  f.collect([card]);
  assert.equal(f.runStatus(run), 'closed');
  assert.equal(f.cardState(card), 'closed_session');
});

test('collect H01 when pane survives close', (t) => {
  const f = fixture(t);
  const { run, packet } = f.seedRun(card, { pane_id: 'w1:p9', terminal_id: 'terminal-1' });
  f.herdrState({ agentStatus: 'done', surviveClose: true });
  f.writeReport(packet, f.reportValues(run, card));
  const result = f.collect([card], 3);
  assert.match(result.stderr, /APS-H01: herdr pane w1:p9 is still open/);
  assert.equal(f.runStatus(run), 'reported');
});

test('headless still running → H07', (t) => {
  const f = fixture(t);
  const pid = liveSleep(t);
  const { run, packet } = f.seedRun(card, { pid }, 'devin');
  f.writeReport(packet, f.reportValues(run, card));
  const refused = f.collect([card], 3);
  assert.match(refused.stderr, new RegExp(`APS-H07: process ${pid} for run ${run} is still running`));
  assert.equal(f.runStatus(run), 'reported');
  assert.equal(f.cardState(card), 'reported');
  writeFileSync(join(packet, 'exit'), '0\n');
  f.collect([card]);
  assert.equal(f.runStatus(run), 'closed');
  const closed = JSON.parse(
    String(f.db.prepare("SELECT detail_json FROM run_events WHERE run_id=? AND status='closed'").get(run)?.detail_json),
  );
  assert.equal(closed.evidence.probe, 'exit-file');
  assert.equal(closed.evidence.code, '0');
  const usage = f.db.prepare('SELECT * FROM run_usage WHERE run_id=?').get(run);
  assert.equal(usage?.source, 'none');
  assert.equal(usage?.basis, 'unknown');
});

test('omp task without yield .md → H08', (t) => {
  const f = fixture(t);
  const dir = join(f.home, '.omp', 'agent', 'sessions', 's1', '20261011');
  mkdirSync(dir, { recursive: true });
  f.usageJsonl(join(dir, 'TaskW.jsonl'));
  const { run, packet } = f.seedRun(
    card,
    { omp_id: 'TaskW', session_ref: join(f.home, '.omp', 'agent', 'sessions', '*', '*', 'TaskW.jsonl') },
    'omp',
  );
  f.writeReport(packet, f.reportValues(run, card));
  const expected = join(dir, 'TaskW.md').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const refused = f.collect([card], 3);
  assert.match(refused.stderr, new RegExp(`APS-H08: omp task TaskW has no yield output at ${expected}`));
  assert.equal(f.runStatus(run), 'reported');
  writeFileSync(join(dir, 'TaskW.md'), 'yielded\n');
  f.collect([card]);
  assert.equal(f.runStatus(run), 'closed');
  const usage = f.db.prepare('SELECT * FROM run_usage WHERE run_id=?').get(run);
  assert.equal(usage?.source, 'omp-jsonl');
  assert.equal(usage?.basis, 'actual');
});

test('bad sha → H09', (t) => {
  const f = fixture(t);
  const { run, packet } = f.seedRun(card, { pane_id: 'w1:p9', terminal_id: 'terminal-1' });
  f.herdrState({ agentStatus: 'done' });
  const badSha = 'a'.repeat(40);
  f.writeReport(packet, f.reportValues(run, card, { sha: badSha }));
  const refused = f.collect([card], 3);
  assert.match(refused.stderr, new RegExp(`APS-H09: reported sha ${badSha} is not a commit on worker in `));
  assert.equal(f.runStatus(run), 'launched');
  assert.equal(f.cardState(card), 'working');
  f.writeReport(packet, f.reportValues(run, card));
  f.collect([card]);
  assert.equal(f.runStatus(run), 'closed');
});

test('session gone without report → H10; --abandon returns card to issued', (t) => {
  const f = fixture(t);
  const { run } = f.seedRun(card, { pane_id: 'w1:p9', terminal_id: 'terminal-1' });
  f.herdrState({ closed: true });
  const refused = f.collect([card], 3);
  assert.match(refused.stderr, /APS-H10: session ended without report\.json/);
  assert.equal(f.runStatus(run), 'launched');
  assert.equal(f.cardState(card), 'working');
  const { value } = f.collect([card, '--abandon']);
  assert.equal(value.outcome, 'abandoned');
  assert.equal(f.runStatus(run), 'abandoned');
  assert.equal(f.cardState(card), 'issued');
  assert.equal(f.agentStatus(run), 'closed');
  assert.deepEqual(f.runEvents(run), ['intent', 'launched', 'abandoned']);
});

test('BLOCKED report → card issued, run blocked→closed', (t) => {
  const f = fixture(t);
  const { run, packet } = f.seedRun(card, { pane_id: 'w1:p9', terminal_id: 'terminal-1' });
  f.herdrState({ agentStatus: 'done' });
  f.writeReport(
    packet,
    f.reportValues(run, card, {
      status: 'BLOCKED',
      blocked: 'BLOCKED: missing API key; tried curl',
      evidence: [{ ac: 'AC1', command: 'echo yes', output: 'yes', ok: false }],
    }),
  );
  const { value } = f.collect([card]);
  assert.equal(value.outcome, 'blocked');
  assert.equal(f.cardState(card), 'issued');
  assert.equal(f.runStatus(run), 'blocked');
  assert.equal(f.agentStatus(run), 'closed');
  assert.deepEqual(f.runEvents(run), ['intent', 'launched', 'blocked']);
  assert.equal(f.db.prepare('SELECT status FROM reports WHERE card_id=?').get(card)?.status, 'BLOCKED');
});

test('P07 evidence not ok → exit 3, run stays launched', (t) => {
  const f = fixture(t);
  const { run, packet } = f.seedRun(card, { pane_id: 'w1:p9', terminal_id: 'terminal-1' });
  f.herdrState({ agentStatus: 'done' });
  f.writeReport(
    packet,
    f.reportValues(run, card, { evidence: [{ ac: 'AC1', command: 'echo yes', output: 'yes', ok: false }] }),
  );
  const refused = f.collect([card], 3);
  assert.match(refused.stderr, /APS-P07/);
  assert.equal(f.runStatus(run), 'launched');
  assert.equal(f.cardState(card), 'working');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM reports').get()?.n, 0);
});

test('re-run after partial failure is idempotent (no duplicate report/usage rows)', (t) => {
  const f = fixture(t);
  const { run, packet } = f.seedRun(card, { pane_id: 'w1:p9', terminal_id: 'terminal-1' });
  f.herdrState({ agentStatus: 'working' });
  f.writeReport(packet, f.reportValues(run, card));
  f.collect([card], 3);
  assert.equal(f.runStatus(run), 'reported');
  f.herdrState({ agentStatus: 'done' });
  f.collect([card]);
  assert.equal(f.runStatus(run), 'closed');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM reports').get()?.n, 1);
  assert.equal(
    f.db.prepare("SELECT count(*) AS n FROM run_events WHERE run_id=? AND status='reported'").get(run)?.n,
    1,
  );
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM run_usage WHERE run_id=?').get(run)?.n, 1);
  const again = f.collect([card], 2);
  assert.match(again.stderr, /no live run/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM reports').get()?.n, 1);
});

test('--all continues after one failure', (t) => {
  const f = fixture(t);
  const first = f.seedRun(card, { pane_id: 'w1:p9', terminal_id: 'terminal-1' });
  f.writeReport(first.packet, f.reportValues(first.run, card));
  const pid = liveSleep(t);
  const second = f.seedRun(card2, { pid }, 'devin');
  f.writeReport(second.packet, f.reportValues(second.run, card2));
  f.herdrState({ agentStatus: 'done' });
  const result = f.collect(['--all'], 3);
  assert.equal(result.value.length, 2);
  assert.equal(result.value[0].card, card);
  assert.equal(result.value[0].outcome, 'reported');
  assert.equal(result.value[0].code, 0);
  assert.equal(result.value[1].card, card2);
  assert.equal(result.value[1].code, 3);
  assert.match(result.value[1].message, /APS-H07/);
  assert.equal(f.runStatus(first.run), 'closed');
  assert.equal(f.cardState(card), 'closed_session');
  assert.equal(f.runStatus(second.run), 'reported');
  assert.equal(f.cardState(card2), 'reported');
});

test('pid probe for an omp headless run', (t) => {
  const f = fixture(t);
  const pid = liveSleep(t);
  const { run, packet } = f.seedRun(card, { pid }, 'omp');
  writeFileSync(join(packet, 'exit'), '0\n');
  f.usageJsonl(join(packet, 'session.jsonl'), 'omp/headless');
  f.writeReport(packet, f.reportValues(run, card));
  const { value } = f.collect([card]);
  assert.equal(value.code, 0);
  assert.equal(f.runStatus(run), 'closed');
  assert.equal(f.cardState(card), 'closed_session');
  const closed = JSON.parse(
    String(f.db.prepare("SELECT detail_json FROM run_events WHERE run_id=? AND status='closed'").get(run)?.detail_json),
  );
  assert.equal(closed.evidence.probe, 'exit-file');
  assert.equal(closed.evidence.code, '0');
  const usage = f.db.prepare('SELECT * FROM run_usage WHERE run_id=?').get(run);
  assert.equal(usage?.source, 'omp-jsonl');
  assert.equal(usage?.basis, 'actual');
  assert.equal(usage?.model, 'omp/headless');
});
