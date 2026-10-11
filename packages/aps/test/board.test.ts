import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  APS_SQL_DIR,
  type HerdrPane,
  type HygieneLedgerRow,
  addRunEvent,
  classifyHygiene,
  createRun,
  dataVersion,
  openApsDb,
  openApsDbReadOnly,
  readBoardSnapshot,
} from '../dist/index.js';
import { AC2, CARD, SHA, move, report, seed, toInspecting } from './fixture.ts';

const NOW = new Date('2030-01-02T12:00:00.000Z');
const seedSql = `INSERT INTO projects(id,prefix,name) VALUES('ss','SS','SceneSteller');
  INSERT INTO agents(id,name,layer,model,vendor,project) VALUES
  ('mgr','sol','L2','sol','openai','ss'),('w1','worker','L3','swe','cognition','ss'),
  ('rev','reviewer','L1','opus','anthropic','ss');
  INSERT INTO cards(id,project,title,kind,size,scope,acceptance_json,forbidden,needs_owner,needs_vision,layer_owner,assignee)
  VALUES('${CARD}','ss','card','mech','S','scope','${AC2}','none',0,0,'mgr','w1');`;

function diskLedger(t: { after: (fn: () => void) => void }, version1 = false) {
  const dir = mkdtempSync(join(tmpdir(), 'aps-board-'));
  const path = join(dir, 'aps.db');
  const db = version1 ? new DatabaseSync(path) : openApsDb(path);
  if (version1) db.exec(readFileSync(join(APS_SQL_DIR, '0001_aps.sql'), 'utf8'));
  db.exec(seedSql);
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { db, dir, path };
}

const ledger: HygieneLedgerRow = {
  agentId: 'w1',
  lane: 'worker',
  layer: 'L3',
  agentStatus: 'active',
  herdrPane: 'p1',
  startedAt: '2030-01-02T11:00:00.000Z',
  closedAt: null,
  cardId: CARD,
  cardState: 'working',
  runId: 'run1',
  harness: 'herdr',
  kind: 'omp',
  runStatus: 'launched',
  runSince: '2030-01-02T11:01:00.000Z',
  paneId: 'p1',
  terminalId: 't1',
  pid: null,
  packetDir: '/tmp/packet',
  sessionRef: null,
};
const pane: HerdrPane = { paneId: 'p1', terminalId: 't1', agent: 'worker', agentStatus: 'working' };

test('readOnly open does not create a missing file', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aps-missing-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'missing', 'aps.db');
  assert.throws(() => openApsDbReadOnly(path), { message: `ledger not found at ${path}` });
  assert.equal(existsSync(path), false);
  assert.equal(existsSync(join(dir, 'missing')), false);
});

test('readOnly connection refuses writes', (t) => {
  const { path } = diskLedger(t);
  const reader = openApsDbReadOnly(path);
  t.after(() => reader.close());
  assert.throws(() => reader.exec("INSERT INTO settings(key,value) VALUES('board-write','no')"), /readonly/);
});

test('snapshot reads while another connection holds BEGIN IMMEDIATE', (t) => {
  const { db, path } = diskLedger(t);
  db.exec('PRAGMA journal_mode=WAL');
  const reader = openApsDbReadOnly(path);
  t.after(() => reader.close());
  db.exec('BEGIN IMMEDIATE');
  try {
    move(db, 'issued', 'working', 'w1');
    const snapshot = readBoardSnapshot(reader, { now: NOW });
    assert.equal(snapshot.cards[0].state, 'issued');
    assert.equal(snapshot.header.wip, 0);
    assert.equal(snapshot.dbPath, realpathSync(path));
    assert.equal(reader.isTransaction, false);
  } finally {
    db.exec('ROLLBACK');
  }
});

test('v1 ledger → runsAvailable false, lanes/review populated', (t) => {
  const { db, path } = diskLedger(t, true);
  move(db, 'issued', 'working', 'w1');
  report(db);
  move(db, 'working', 'reported', 'w1');
  const reader = openApsDbReadOnly(path);
  t.after(() => reader.close());
  const before = db.prepare('SELECT count(*) n FROM feedback WHERE escalated=1').get()?.n;
  const snapshot = readBoardSnapshot(reader, { now: NOW, panes: [pane] });
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.runsAvailable, false);
  assert.equal(snapshot.cost, null);
  assert.equal(snapshot.lanes[0].n, 1);
  assert.equal(snapshot.reviewQueue[0].cardId, CARD);
  assert.equal(snapshot.reviewQueue[0].state, 'reported');
  assert.equal(snapshot.cards[0].reports[0].sha, SHA);
  assert.equal(snapshot.cards[0].timeline.length, 3);
  assert.match(snapshot.cards[0].nextBlockers[0], /S01/);
  assert.equal(snapshot.header.wip, 1);
  assert.equal(snapshot.header.reviewQueue, 1);
  assert.equal(db.prepare('SELECT count(*) n FROM feedback WHERE escalated=1').get()?.n, before);
});

test('data_version changes only after foreign commit', (t) => {
  const { db, path } = diskLedger(t);
  db.exec('PRAGMA journal_mode=WAL');
  const reader = openApsDbReadOnly(path);
  t.after(() => reader.close());
  const initial = dataVersion(reader);
  assert.equal(dataVersion(reader), initial);
  db.exec('BEGIN IMMEDIATE');
  db.exec("INSERT INTO settings(key,value) VALUES('foreign','commit')");
  assert.equal(dataVersion(reader), initial);
  db.exec('COMMIT');
  assert.notEqual(dataVersion(reader), initial);
  const after = dataVersion(reader);
  readBoardSnapshot(reader, { now: NOW });
  assert.equal(dataVersion(reader), after);
});

test('newer schema is refused without migration and failed snapshot rolls back', (t) => {
  const { db, path } = diskLedger(t);
  const reader = openApsDbReadOnly(path);
  t.after(() => reader.close());
  db.exec('PRAGMA user_version=999');
  assert.throws(() => openApsDbReadOnly(path), /APS-U01: ledger schema v999 is newer than this build/);
  assert.throws(() => readBoardSnapshot(reader), /APS-U01/);
  assert.equal(reader.isTransaction, false);
  assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 999);
});

test('ISO cutoff excludes feedback one second past threshold and never escalates', (t) => {
  const { db } = diskLedger(t);
  db.exec("UPDATE settings SET value='30' WHERE key='feedback_escalate_minutes'");
  db.exec(`INSERT INTO feedback(from_agent,to_agent,kind,card_id,body,created_at) VALUES
    ('w1','mgr','proposal','${CARD}','overdue','2030-01-02T11:29:59.000Z'),
    ('w1','mgr','proposal','${CARD}','not overdue','2030-01-02T11:30:01.000Z')`);
  const snapshot = readBoardSnapshot(db, { now: NOW });
  assert.equal(snapshot.header.feedbackOpen, 2);
  assert.equal(snapshot.header.feedbackOverdue, 1);
  assert.equal(snapshot.header.feedbackEscalated, 0);
  assert.equal(db.prepare('SELECT sum(escalated) n FROM feedback').get()?.n, 0);
});

test('feedback cutoff defaults to 30 minutes for missing or non-finite settings', (t) => {
  const { db } = diskLedger(t);
  db.exec(`INSERT INTO feedback(from_agent,to_agent,kind,card_id,body,created_at) VALUES
    ('w1','mgr','proposal','${CARD}','overdue','2030-01-02T11:29:59.000Z'),
    ('w1','mgr','proposal','${CARD}','not overdue','2030-01-02T11:30:01.000Z');`);
  for (const value of [null, 'not-a-number', 'NaN', 'Infinity', '-Infinity']) {
    db.exec("DELETE FROM settings WHERE key='feedback_escalate_minutes'");
    if (value !== null)
      db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('feedback_escalate_minutes', value);
    const snapshot = readBoardSnapshot(db, { now: NOW });
    assert.equal(snapshot.header.feedbackOpen, 2, String(value));
    assert.equal(snapshot.header.feedbackOverdue, 1, String(value));
    assert.equal(snapshot.header.feedbackEscalated, 0, String(value));
    assert.equal(db.isTransaction, false);
  }
  assert.equal(db.prepare('SELECT sum(escalated) n FROM feedback').get()?.n, 0);
});

test('snapshot project filter, review semantics and independent lane identity', () => {
  const db = seed();
  try {
    toInspecting(db);
    const snapshot = readBoardSnapshot(db, { now: NOW });
    assert.equal(snapshot.header.wip, 1);
    assert.equal(snapshot.header.reviewQueue, 0);
    assert.equal(snapshot.header.inReview, 1);
    assert.equal(snapshot.reviewQueue[0].lane, 'devin');
    assert.equal(snapshot.reviewQueue[0].state, 'inspecting');
    assert.equal(snapshot.cards[0].nextBlockers[0], 'review needed (independent of devin)');
    const filtered = readBoardSnapshot(db, { project: 'none', now: NOW });
    assert.equal(filtered.cards.length, 0);
    assert.equal(filtered.header.wip, 0);
  } finally {
    db.close();
  }
});

test('migrated snapshot joins run costs, latest quota and complete run evidence', (t) => {
  const { db, dir } = diskLedger(t);
  move(db, 'issued', 'working', 'w1');
  const packet = join(dir, 'packet');
  db.exec(`INSERT INTO worker_runs(id,card_id,attempt,agent_id,harness,kind,model,worktree,branch,base_sha,packet_dir,created_by,at)
    VALUES('run1','${CARD}',1,'w1','herdr','omp','opus','/tmp/worktree','fac/test','${SHA}','${packet}','mgr','2030-01-01T12:00:00.000Z');
    INSERT INTO run_events(run_id,status,by_agent) VALUES('run1','intent','mgr');
    INSERT INTO run_events(run_id,status,by_agent,detail_json) VALUES('run1','launched','mgr','{"pane_id":"p1","terminal_id":"t1"}');
    INSERT INTO run_usage(run_id,source,source_ref,basis,model,input_tokens,output_tokens,cache_read_tokens,cost_usd)
      VALUES('run1','omp-jsonl','session','actual','opus',10,20,7,1.5);
    INSERT INTO run_usage(run_id,source,source_ref,basis) VALUES('run1','none','run1','unknown');
    INSERT INTO quota_samples(vendor,account,metric,value,at) VALUES
      ('anthropic','a','remaining',20,'2030-01-01T00:00:00.000Z'),
      ('anthropic','a','remaining',10,'2030-01-02T00:00:00.000Z');`);
  const snapshot = readBoardSnapshot(db, { now: NOW, panes: [pane] });
  assert.equal(snapshot.runsAvailable, true);
  assert.equal(snapshot.cards[0].runs[0].events.length, 2);
  assert.equal(snapshot.cards[0].runs[0].reportPresent, false);
  assert.equal(snapshot.hygiene.find((row) => row.agentId === 'w1')?.classification, 'OK');
  assert.equal(snapshot.cost?.byLane[0].runs, 1);
  assert.equal(snapshot.cost?.byLane[0].usdActual, 1.5);
  assert.equal(snapshot.cost?.byLane[0].ioTokens, 30);
  assert.equal(snapshot.cost?.byLane[0].cacheRead, 7);
  assert.equal(snapshot.cost?.byCard[0].runsUnknown, 1);
  assert.equal(snapshot.cost?.byCard[0].runsUncollected, 0);
  assert.equal(snapshot.cost?.quota[0].value, 10);
  assert.equal(readBoardSnapshot(db, { now: NOW, since: '2030-01-01T12:00:01.000Z' }).cost?.byLane.length, 0);
  mkdirSync(packet);
  writeFileSync(join(packet, 'report.json'), '{}');
  assert.equal(readBoardSnapshot(db, { now: NOW }).cards[0].runs[0].reportPresent, true);
});

test('today lane totals exclude terminal card one second before UTC cutoff', (t) => {
  const { db } = diskLedger(t);
  db.exec(`INSERT INTO cards(id,project,title,kind,size,scope,acceptance_json,forbidden,needs_owner,needs_vision,layer_owner)
    VALUES('SS-C-0002','ss','old','mech','S','scope','${AC2}','none',0,0,'mgr');
    INSERT INTO transitions(card_id,from_state,to_state,by_agent,note,at) VALUES
      ('SS-C-0002','issued','rejected','mgr','cancelled','2030-01-01T23:59:59.000Z'),
      ('${CARD}','issued','rejected','mgr','cancelled','2030-01-02T00:00:00.000Z');`);
  const snapshot = readBoardSnapshot(db, { now: NOW });
  assert.equal(
    snapshot.lanes.reduce((n, row) => n + row.n, 0),
    1,
  );
  assert.equal(snapshot.cards.length, 2);
  assert.equal(snapshot.header.wip, 0);
});

test('migrated ledger preserves hygiene for sessions with no tracked run', (t) => {
  const { db } = diskLedger(t);
  move(db, 'issued', 'working', 'w1');
  db.exec("UPDATE agents SET herdr_pane='p1' WHERE id='w1'");
  const snapshot = readBoardSnapshot(db, { now: NOW, panes: [] });
  const ghost = snapshot.hygiene.find((row) => row.agentId === 'w1');
  assert.equal(ghost?.classification, 'GHOST');
  assert.equal(ghost?.cardId, CARD);
});

test('assigned lane cells aggregate owners while unassigned cells stay owner-scoped', (t) => {
  const { db } = diskLedger(t);
  db.exec(`INSERT INTO agents(id,name,layer,model,vendor,project)
    VALUES('mgr2','other manager','L2','opus','anthropic','ss');
    INSERT INTO cards(id,project,title,kind,size,scope,acceptance_json,forbidden,needs_owner,needs_vision,layer_owner,assignee) VALUES
    ('SS-C-0002','ss','assigned','mech','S','scope','${AC2}','none',0,0,'mgr2','w1'),
    ('SS-C-0003','ss','unassigned','mech','S','scope','${AC2}','none',0,0,'mgr',NULL),
    ('SS-C-0004','ss','unassigned','mech','S','scope','${AC2}','none',0,0,'mgr2',NULL);`);
  const snapshot = readBoardSnapshot(db, { now: NOW });
  const assigned = snapshot.lanes.filter((row) => row.lane === 'worker');
  assert.equal(assigned.length, 1);
  assert.equal(assigned[0].n, 2);
  const unassigned = snapshot.lanes.filter((row) => row.lane === '(unassigned)');
  assert.equal(unassigned.length, 2);
  assert.deepEqual(
    unassigned.map((row) => [row.layerOwner, row.n]),
    [
      ['mgr', 1],
      ['mgr2', 1],
    ],
  );
});

test('failed historical run does not produce a ghost beside the live retry', (t) => {
  const { db, dir } = diskLedger(t);
  move(db, 'issued', 'working', 'w1');
  const input = {
    card_id: CARD,
    attempt: 1,
    agent_id: 'w1',
    harness: 'herdr' as const,
    kind: 'omp' as const,
    model: 'opus',
    worktree: '/tmp/worktree',
    branch: 'fac/test',
    base_sha: SHA,
    packet_dir: dir,
    created_by: 'mgr',
  };
  createRun(db, { ...input, id: 'old' });
  addRunEvent(db, 'old', 'launched', 'mgr', { pane_id: 'old-pane', terminal_id: 'old-terminal' });
  addRunEvent(db, 'old', 'failed', 'mgr');
  createRun(db, { ...input, id: 'retry' });
  addRunEvent(db, 'retry', 'launched', 'mgr', { pane_id: 'p1', terminal_id: 't1' });
  const snapshot = readBoardSnapshot(db, { now: NOW, panes: [pane] });
  const workerRows = snapshot.hygiene.filter((row) => row.agentId === 'w1');
  assert.equal(workerRows.length, 1);
  assert.equal(workerRows[0].classification, 'OK');
  assert.equal(workerRows[0].runId, 'retry');
  assert.equal(snapshot.cards[0].runs.length, 2);
});

test('terminal run rows are excluded from pure hygiene classification', () => {
  for (const runStatus of ['closed', 'blocked', 'failed', 'abandoned'] as const) {
    assert.deepEqual(classifyHygiene([{ ...ledger, runStatus }], [], NOW), []);
  }
  assert.equal(classifyHygiene([{ ...ledger, runStatus: null, runId: null }], [pane], NOW)[0].classification, 'OK');
});

test('working card with an unknown or blocked pane status is surfaced as unknown', () => {
  for (const agentStatus of ['unknown', 'blocked', null, undefined]) {
    const row = classifyHygiene([ledger], [{ ...pane, agentStatus }], NOW)[0];
    assert.equal(row.classification, '?');
    assert.equal(row.action, null);
    assert.equal(row.runId, 'run1');
  }
});

test('OK', () => {
  assert.equal(classifyHygiene([ledger], [pane], NOW)[0].classification, 'OK');
});
test('CLOSE-NOW', () => {
  for (const cardState of ['reported', 'closed_session', 'inspecting', 'accepted', 'merge_wait'] as const) {
    assert.equal(classifyHygiene([{ ...ledger, cardState }], [pane], NOW)[0].classification, 'CLOSE-NOW');
  }
  assert.equal(classifyHygiene([ledger], [{ ...pane, agentStatus: 'done' }], NOW)[0].classification, 'CLOSE-NOW');
});
test('LEAK', () => {
  const row = classifyHygiene([{ ...ledger, agentStatus: 'closed' }], [pane], NOW)[0];
  assert.equal(row.classification, 'LEAK');
  assert.equal(row.action, 'herdr pane close p1');
});
test('GHOST', () => {
  assert.equal(classifyHygiene([ledger], [], NOW)[0].classification, 'GHOST');
  const headless = { ...ledger, harness: 'devin' as const, kind: null, paneId: null, herdrPane: null };
  assert.equal(classifyHygiene([{ ...headless, pidAlive: false }], null, NOW)[0].classification, 'GHOST');
  assert.equal(
    classifyHygiene([{ ...headless, harness: 'omp', yieldPresent: true }], null, NOW)[0].classification,
    'GHOST',
  );
  assert.equal(classifyHygiene([headless], null, NOW).length, 0);
});
test('STUCK-INTENT', () => {
  const row = { ...ledger, runStatus: 'intent' as const, runSince: '2030-01-02T11:57:59.000Z' };
  assert.equal(classifyHygiene([row], null, NOW)[0].classification, 'STUCK-INTENT');
  assert.match(classifyHygiene([row], null, NOW)[0].action ?? '', /dispatch.log.*--abandon/);
  assert.equal(
    classifyHygiene([{ ...row, runSince: '2030-01-02T11:58:00.000Z' }], [pane], NOW)[0].classification,
    'OK',
  );
});
test('UNTRACKED', () => {
  assert.equal(classifyHygiene([], [pane], NOW)[0].classification, 'UNTRACKED');
  assert.equal(classifyHygiene([], [{ ...pane, agent: null }], NOW).length, 0);
});
test('terminal-id reuse → GHOST', () => {
  const rows = classifyHygiene([ledger], [{ ...pane, terminalId: 'new-terminal' }], NOW);
  assert.equal(rows[0].classification, 'GHOST');
  assert.equal(rows[1].classification, 'UNTRACKED');
  assert.equal(classifyHygiene([{ ...ledger, terminalId: null }], [pane], NOW)[0].classification, 'OK');
});
test('stale herdr never infers LEAK or GHOST and shells are counted only', (t) => {
  assert.equal(classifyHygiene([{ ...ledger, agentStatus: 'closed' }], null, NOW)[0].classification, '?');
  assert.equal(classifyHygiene([ledger], null, NOW)[0].classification, '?');
  const { db } = diskLedger(t);
  const snapshot = readBoardSnapshot(db, { now: NOW, panes: [{ ...pane, agent: null }] });
  assert.equal(snapshot.herdr.shells, 1);
  const stale = readBoardSnapshot(db, { now: NOW, herdrError: 'herdr unavailable' });
  assert.equal(stale.herdr.ok, false);
  assert.equal(stale.stale.herdr, 'herdr unavailable');
});
