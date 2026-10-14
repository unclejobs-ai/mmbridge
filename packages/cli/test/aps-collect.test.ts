import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { addRunEvent, createRun, newAgent, openApsDb, recordReport, startCard } from '@mmbridge/aps';
import { ledgerLanes } from '../dist/commands/aps-lanes.js';

const bin = resolve(import.meta.dirname, '../dist/bin/mmbridge.js');
const card = 'TS-C-0001';
const card2 = 'TS-C-0002';
const acceptance = '[{"id":"AC1","text":"Works","command":"echo yes","expect":"yes"}]';
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

function gitAt(env: NodeJS.ProcessEnv, repo: string, args: string[]) {
  const result = spawnSync('git', ['-C', repo, ...args], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function agentRow(db: DatabaseSync, agent: string) {
  return db.prepare('SELECT status,closed_at,closed_by,close_note FROM agents WHERE id=?').get(agent);
}

/** Closes the worker agent behind collect's back while its card is still working (the FINISHED_OPEN shape). */
function closeAgentFirst(db: DatabaseSync, agent: string) {
  db.prepare(
    "UPDATE agents SET status='closed',closed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),closed_by='mgr',close_note='closed before collect' WHERE id=?",
  ).run(agent);
  return agentRow(db, agent);
}

/** `aps report` by hand while the run stays launched: working→reported, one report row (the FINISHED_OPEN start). */
function reportByHand(db: DatabaseSync, cardId: string, worker: string, values: Record<string, unknown>) {
  recordReport(db, cardId, {
    by_agent: worker,
    recorded_by: 'mgr',
    sha: String(values.sha),
    branch: String(values.branch),
    files_json: JSON.stringify(values.files),
    evidence_json: JSON.stringify(values.evidence),
    status: 'DONE',
    risks: '',
  });
}

/** Raw transitions (no moveCard auto-close), as a ledger written before runs closed with their card. */
function moveRaw(db: DatabaseSync, cardId: string, path: string[], by = 'mgr', note = '') {
  for (let i = 1; i < path.length; i++)
    db.prepare('INSERT INTO transitions(card_id,from_state,to_state,by_agent,note) VALUES(?,?,?,?,?)').run(
      cardId,
      path[i - 1],
      path[i],
      by,
      note,
    );
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

test('H09 fallback: run worktree gone → verify in --project-dir (branch, then origin/main after merge)', (t) => {
  const f = fixture(t);
  const project = join(f.home, 'project');
  gitAt(f.env, f.home, ['clone', '-q', f.worktree, project]);
  const first = f.seedRun(card, { pane_id: 'w1:p9', terminal_id: 'terminal-1' });
  const second = f.seedRun(card2, { pane_id: 'w1:p8', terminal_id: 'terminal-1' });
  f.writeReport(first.packet, f.reportValues(first.run, card));
  f.writeReport(second.packet, f.reportValues(second.run, card2));
  rmSync(f.worktree, { recursive: true, force: true });

  f.herdrState({ agentStatus: 'done' });
  const local = f.collect([card, '--project-dir', project]);
  assert.equal(local.value.outcome, 'reported');
  assert.equal(local.value.message, `collect ${first.run}: closed_session`);
  assert.deepEqual(local.value.evidence.commit, { repo: project, ref: 'refs/heads/worker', fallback: true });
  assert.equal(f.cardState(card), 'closed_session');
  assert.equal(f.runStatus(first.run), 'closed');

  // The merged lane's branch is gone everywhere; origin/main carries the sha.
  gitAt(f.env, project, ['checkout', '-q', '-b', 'main']);
  gitAt(f.env, project, ['branch', '-q', '-D', 'worker']);
  gitAt(f.env, project, ['update-ref', '-d', 'refs/remotes/origin/worker']);
  gitAt(f.env, project, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  f.herdrState({ agentStatus: 'done' });
  const merged = f.collect([card2, '--project-dir', project]);
  assert.equal(merged.value.outcome, 'reported');
  assert.deepEqual(merged.value.evidence.commit, { repo: project, ref: 'refs/remotes/origin/main', fallback: true });
  assert.equal(f.cardState(card2), 'closed_session');
  const reported = JSON.parse(
    String(
      f.db.prepare("SELECT detail_json FROM run_events WHERE run_id=? AND status='reported'").get(second.run)
        ?.detail_json,
    ),
  );
  assert.equal(reported.commit.repo, project);
});

test('H09 fallback: worktree gone and sha unknown to the project repo → still APS-H09', (t) => {
  const f = fixture(t);
  const project = join(f.home, 'project');
  gitAt(f.env, f.home, ['clone', '-q', f.worktree, project]);
  const { run, packet } = f.seedRun(card, { pane_id: 'w1:p9', terminal_id: 'terminal-1' });
  f.herdrState({ agentStatus: 'done' });
  f.git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'lost']);
  const lost = f.git(['rev-parse', 'HEAD']);
  f.writeReport(packet, f.reportValues(run, card));
  rmSync(f.worktree, { recursive: true, force: true });
  const refused = f.collect([card, '--project-dir', project], 3);
  assert.ok(
    refused.stderr.includes(
      `APS-H09: reported sha ${lost} is not a commit on worker in ${project} (run worktree ${f.worktree} is missing)`,
    ),
    refused.stderr,
  );
  assert.equal(f.runStatus(run), 'launched');
  assert.equal(f.cardState(card), 'working');
});

test('--abandon with the worker agent already closed: no APS-A02, agent row untouched', (t) => {
  const f = fixture(t);
  const { run, worker } = f.seedRun(card, { pane_id: 'w1:p9', terminal_id: 'terminal-1' });
  const before = closeAgentFirst(f.db, worker);
  f.herdrState({ closed: true });
  const { value, stderr } = f.collect([card, '--abandon']);
  assert.doesNotMatch(stderr, /APS-A02/);
  assert.equal(value.outcome, 'abandoned');
  assert.equal(f.runStatus(run), 'abandoned');
  assert.deepEqual(f.runEvents(run), ['intent', 'launched', 'abandoned']);
  assert.equal(f.cardState(card), 'issued');
  assert.deepEqual(agentRow(f.db, worker), before);
});

test('BLOCKED report with the worker agent already closed: no APS-A02, agent row untouched', (t) => {
  const f = fixture(t);
  const { run, worker, packet } = f.seedRun(card, { pane_id: 'w1:p9', terminal_id: 'terminal-1' });
  const before = closeAgentFirst(f.db, worker);
  f.herdrState({ agentStatus: 'done' });
  f.writeReport(
    packet,
    f.reportValues(run, card, {
      status: 'BLOCKED',
      blocked: 'BLOCKED: missing API key; tried curl',
      evidence: [{ ac: 'AC1', command: 'echo yes', output: 'yes', ok: false }],
    }),
  );
  const { value, stderr } = f.collect([card]);
  assert.doesNotMatch(stderr, /APS-A02/);
  assert.equal(value.outcome, 'blocked');
  assert.equal(f.cardState(card), 'issued');
  assert.equal(f.runStatus(run), 'blocked');
  assert.deepEqual(agentRow(f.db, worker), before);
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

test('P08 pre-check names the packet report.json to fix (issue #15)', (t) => {
  const f = fixture(t);
  const { run, packet } = f.seedRun(card, { pane_id: 'w1:p9', terminal_id: 'terminal-1' });
  f.writeReport(packet, f.reportValues(run, card, { status: 'DONE_WITH_CONCERNS' }));
  const refused = f.collect([card], 3);
  assert.match(
    refused.stderr,
    new RegExp(`APS-P08: DONE_WITH_CONCERNS requires non-empty risks — add "risks" to .*${run}/report\\.json`),
  );
  assert.equal(f.runStatus(run), 'launched');
  assert.equal(f.cardState(card), 'working');
  f.herdrState({ agentStatus: 'done' });
  f.writeReport(packet, f.reportValues(run, card, { status: 'DONE_WITH_CONCERNS', risks: 'flaky on cold start' }));
  const fixed = f.collect([card]);
  assert.equal(fixed.value.outcome, 'reported');
  assert.equal(f.cardState(card), 'closed_session');
});

test('--abandon recovers a wedged lane whose report cannot be recorded (issue #15)', (t) => {
  const f = fixture(t);
  const { run, packet } = f.seedRun(card, { pane_id: 'w1:p9', terminal_id: 'terminal-1' });
  f.writeReport(
    packet,
    f.reportValues(run, card, { evidence: [{ ac: 'AC1', command: 'echo yes', output: 'yes', ok: false }] }),
  );
  assert.match(f.collect([card], 3).stderr, /APS-P07/);
  assert.equal(f.cardState(card), 'working');
  assert.equal(f.runStatus(run), 'launched');
  // --abandon needs a proven session end; a present pane still refuses with the original error.
  assert.match(f.collect([card, '--abandon'], 3).stderr, /APS-P07/);
  assert.equal(f.runStatus(run), 'launched');
  f.herdrState({ closed: true });
  const abandoned = f.collect([card, '--abandon']);
  assert.equal(abandoned.value.outcome, 'abandoned');
  assert.equal(abandoned.value.code, 0);
  assert.match(abandoned.value.message, /report rejected: APS-P07/);
  assert.equal(f.cardState(card), 'issued');
  assert.equal(f.runStatus(run), 'abandoned');
  assert.deepEqual(f.runEvents(run), ['intent', 'launched', 'abandoned']);
  assert.equal(f.agentStatus(run), 'closed');
  const detail = JSON.parse(
    String(
      f.db.prepare("SELECT detail_json FROM run_events WHERE run_id=? AND status='abandoned'").get(run)?.detail_json,
    ),
  );
  assert.match(String(detail.report_rejected), /APS-P07/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM reports').get()?.n, 0);
});

test('collect drops evidence for unknown ac ids with a warning instead of failing (issue #15)', (t) => {
  const f = fixture(t);
  const { run, packet } = f.seedRun(card, { pane_id: 'w1:p9', terminal_id: 'terminal-1' });
  f.herdrState({ agentStatus: 'done' });
  f.writeReport(
    packet,
    f.reportValues(run, card, {
      evidence: [
        { ac: 'AC1', command: 'echo yes', output: 'yes', ok: true },
        { ac: 'AC7', command: 'echo extra', output: 'extra', ok: true },
      ],
    }),
  );
  const collected = f.collect([card]);
  assert.equal(collected.value.outcome, 'reported');
  assert.match(collected.stderr, /warning: evidence references acceptance ids not on card TS-C-0001 \(AC7\)/);
  const stored = JSON.parse(
    String(f.db.prepare('SELECT evidence_json FROM reports WHERE card_id=?').get(card)?.evidence_json),
  ) as { ac: string }[];
  assert.deepEqual(
    stored.map((row) => row.ac),
    ['AC1'],
  );
  assert.equal(f.cardState(card), 'closed_session');
});

test('usage: one model under two providers records two rows, no conflict (issue #15)', (t) => {
  const f = fixture(t);
  const session = join(f.home, 'session.jsonl');
  const line = (provider?: string) => ({
    type: 'message',
    message: {
      ...(provider ? { provider } : {}),
      model: 'test/model',
      usage: { input: 10, output: 5, cacheRead: 1, cacheWrite: 2, totalTokens: 18, cost: { total: 0.0123 } },
    },
  });
  writeFileSync(session, `${JSON.stringify(line('test'))}\n${JSON.stringify(line())}\n`);
  const { run, packet } = f.seedRun(card, { pane_id: 'w1:p9', terminal_id: 'terminal-1', session_ref: session });
  f.herdrState({ agentStatus: 'done' });
  f.writeReport(packet, f.reportValues(run, card));
  const collected = f.collect([card]);
  assert.equal(collected.value.code, 0);
  assert.equal(f.runStatus(run), 'closed');
  assert.deepEqual(
    f.db
      .prepare('SELECT provider FROM run_usage WHERE run_id=? ORDER BY provider')
      .all(run)
      .map((row) => row.provider),
    ['test', 'unknown'],
  );
});

test('collect with no live run explains the card state and the next command (issue #15)', (t) => {
  const f = fixture(t);
  const worker = newAgent(f.db, { name: 'manual', layer: 'L3', model: 'test', vendor: 'test', project: 'test' });
  startCard(f.db, card, worker);
  reportByHand(f.db, card, worker, {
    sha: f.git(['rev-parse', 'HEAD']),
    branch: 'worker',
    files: ['src/x.ts'],
    evidence: [{ ac: 'AC1', command: 'echo yes', output: 'yes', ok: true }],
  });
  closeAgentFirst(f.db, worker);
  moveRaw(f.db, card, ['reported', 'closed_session']);
  const refused = f.collect([card], 2);
  assert.match(
    refused.value.message,
    new RegExp(
      `no live run; card ${card} is closed_session with its attempt-1 report already recorded; nothing to collect \\(next: mmbridge aps review ${card}\\)`,
    ),
  );

  const worker2 = newAgent(f.db, { name: 'manual2', layer: 'L3', model: 'test', vendor: 'test', project: 'test' });
  startCard(f.db, card2, worker2);
  const working = f.collect([card2], 2);
  assert.match(
    working.value.message,
    new RegExp(`no live run; card ${card2} is working without a live dispatched run`),
  );
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
  // dispatch records session_ref = its --session-dir; omp nests one directory per cwd under it.
  const sessionDir = join(f.home, 'omp-session');
  const transcript = join(sessionDir, '-worktree', '2026-10-11T00-00-00Z_run.jsonl');
  mkdirSync(join(sessionDir, '-worktree'), { recursive: true });
  f.usageJsonl(transcript, 'omp/headless');
  const { run, packet } = f.seedRun(card, { pid, session_ref: sessionDir }, 'omp');
  writeFileSync(join(packet, 'exit'), '0\n');
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
  assert.equal(usage?.source_ref, transcript);
  assert.equal(usage?.source, 'omp-jsonl');
  assert.equal(usage?.basis, 'actual');
  assert.equal(usage?.model, 'omp/headless');
});

test('foreman collects a finished child, passes its acceptance and hands it to inspecting', (t) => {
  const f = fixture(t);
  f.db.exec(`INSERT INTO cards(id,project,title,kind,size,scope,acceptance_json,forbidden,needs_owner,needs_vision,layer_owner)
    VALUES('TS-C-0003','test','Parent','design','M','CLI','${acceptance}','paid calls',0,0,'mgr');
    UPDATE cards SET parent_card='TS-C-0003' WHERE id='${card}';`);
  const pid = liveSleep(t);
  const { run, packet } = f.seedRun(card, { pid }, 'devin');
  writeFileSync(join(packet, 'exit'), '0\n');
  f.writeReport(packet, f.reportValues(run, card));
  const result = spawnSync(
    process.execPath,
    [bin, 'foreman', 'TS-C-0003', '--repo', f.worktree, '--db', f.env.APS_DB, '--by', 'mgr'],
    { env: f.env, cwd: f.home, encoding: 'utf8', timeout: 30_000 },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, new RegExp(`${card} worker inspecting \\S+ ac 1/1 rework 0`));
  assert.equal(f.runStatus(run), 'closed');
  assert.equal(f.cardState(card), 'inspecting');
});

test('--close-only: done card with a launched run and report.json → closed, no report row, agent untouched', async (t) => {
  const f = fixture(t);
  const { run, worker, packet } = f.seedRun(card, { pane_id: 'w1:p9', terminal_id: 'terminal-1' });
  const values = f.reportValues(run, card);
  f.writeReport(packet, values);
  reportByHand(f.db, card, worker, values);
  const before = closeAgentFirst(f.db, worker);
  moveRaw(f.db, card, ['reported', 'closed_session', 'inspecting']);
  f.db.exec(`INSERT INTO agents(id,name,layer,model,vendor) VALUES('rev','reviewer','L1','test','test');
    INSERT INTO reviews(card_id,attempt,reviewer,layer,sha,verdict,items_json)
    VALUES('${card}',1,'rev','L1','${values.sha}','accept','[]');`);
  moveRaw(f.db, card, ['inspecting', 'accepted', 'merge_wait']);
  f.db.exec(`INSERT INTO merges(card_id,sha,merged_sha,target,verified_by,verify_command)
    VALUES('${card}','${values.sha}','${'c'.repeat(40)}','origin/main','mgr','git merge-base --is-ancestor')`);
  moveRaw(f.db, card, ['merge_wait', 'done']);
  assert.equal(f.cardState(card), 'done');
  assert.equal(f.runStatus(run), 'launched');
  assert.deepEqual(
    (await ledgerLanes(f.db, [])).map((lane) => [lane.id, lane.finished]),
    [[run, true]],
  );
  assert.match(f.collect([card], 3).stderr, /APS-P01: reports can be recorded only while the card is working/);

  const { value } = f.collect([card, '--close-only']);
  assert.equal(value.outcome, 'closed');
  assert.equal(value.code, 0);
  assert.equal(f.runStatus(run), 'closed');
  assert.deepEqual(f.runEvents(run), ['intent', 'launched', 'reported', 'closed']);
  assert.deepEqual(await ledgerLanes(f.db, []), []);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM reports WHERE card_id=?').get(card)?.n, 1);
  assert.equal(f.cardState(card), 'done');
  assert.deepEqual(agentRow(f.db, worker), before);
  const closed = JSON.parse(
    String(f.db.prepare("SELECT detail_json FROM run_events WHERE run_id=? AND status='closed'").get(run)?.detail_json),
  );
  assert.equal(closed.evidence.report, join(packet, 'report.json'));
  assert.equal(closed.evidence.sha, values.sha);
  assert.equal(closed.evidence.card_state, 'done');
  assert.equal(closed.evidence.agent, 'already_closed');
  assert.equal(f.collect([card, '--close-only'], 2).value.message, 'no launched run');
});

test('--close-only refuses a working card (exit 2); past working it closes the run and the idle open agent', (t) => {
  const f = fixture(t);
  const { run, worker, packet } = f.seedRun(card, { pane_id: 'w1:p9', terminal_id: 'terminal-1' });
  f.writeReport(packet, f.reportValues(run, card));
  const refused = f.collect([card, '--close-only'], 2);
  assert.match(refused.value.message, /card TS-C-0001 is still working; collect it without --close-only/);
  assert.deepEqual(f.runEvents(run), ['intent', 'launched']);
  assert.equal(f.cardState(card), 'working');
  assert.equal(f.agentStatus(run), 'active');

  moveRaw(f.db, card, ['working', 'issued', 'rejected'], 'mgr', 'superseded');
  const { value } = f.collect([card, '--close-only']);
  assert.equal(value.outcome, 'closed');
  assert.equal(value.evidence.agent, 'closed');
  assert.equal(f.runStatus(run), 'closed');
  assert.equal(f.cardState(card), 'rejected');
  assert.equal(f.agentStatus(run), 'closed');
  assert.equal(agentRow(f.db, worker)?.close_note, `collect --close-only ${run}`);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM reports').get()?.n, 0);
});
