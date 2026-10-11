import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  APS_SQL_DIR,
  type CreateRunInput,
  type RunStatus,
  addRunEvent,
  addUsage,
  commandTransaction,
  createRun,
  doctor,
  getLiveRun,
  openApsDb,
} from '../dist/index.js';
import { CARD, SHA, move, rejects, seed } from './fixture.ts';

const RUN = 'run-1';
const values: CreateRunInput = {
  id: RUN,
  card_id: CARD,
  attempt: 1,
  agent_id: 'w1',
  harness: 'herdr',
  kind: 'omp',
  model: 'test-model',
  worktree: '/sandbox/worktree',
  branch: 'fac/test',
  base_sha: SHA,
  packet_dir: '/sandbox/dispatch/run-1',
  created_by: 'mgr',
};
function runSql(id = RUN, attempt = 1, agent = 'w1'): string {
  return `INSERT INTO worker_runs(id,card_id,attempt,agent_id,harness,kind,model,worktree,branch,base_sha,packet_dir,created_by)
          VALUES('${id}','${CARD}',${attempt},'${agent}','herdr','omp','test-model','/sandbox','fac/test','${SHA}','/packet','mgr')`;
}
function eventSql(status: RunStatus, detail = '{}'): string {
  return `INSERT INTO run_events(run_id,status,by_agent,detail_json) VALUES('${RUN}','${status}','mgr','${detail}')`;
}
async function workingRun(): Promise<DatabaseSync> {
  const db = seed();
  move(db, 'issued', 'working', 'w1');
  await commandTransaction(db, async () => createRun(db, values));
  return db;
}

test('N01 refuses a second live run', async (t) => {
  const db = await workingRun();
  t.after(() => db.close());
  for (const status of ['intent', 'launched', 'reported'] as const) {
    if (status !== 'intent') db.exec(eventSql(status));
    rejects(db, 'N01', runSql('run-2'));
  }
  db.exec(eventSql('closed', '{"evidence":"pane_not_found"}'));
  await commandTransaction(db, async () => createRun(db, { ...values, id: 'run-2' }));
  assert.equal(getLiveRun(db, CARD)?.run_id, 'run-2');
});

test('N02 refuses run for non-working card', (t) => {
  const db = seed();
  t.after(() => db.close());
  rejects(db, 'N02', runSql());
  move(db, 'issued', 'working', 'w1');
  rejects(db, 'N02', runSql(RUN, 2));
  rejects(db, 'N02', runSql(RUN, 1, 'w2'));
});

test('N03 refuses backward event', async (t) => {
  const db = await workingRun();
  t.after(() => db.close());
  rejects(db, 'N03', eventSql('intent'));
  rejects(db, 'N03', eventSql('reported'));
  db.exec(eventSql('launched'));
  rejects(db, 'N03', eventSql('intent'));
  rejects(db, 'N03', eventSql('closed', '{"evidence":"ended"}'));
  db.exec(eventSql('reported'));
  rejects(db, 'N03', eventSql('launched'));
  db.exec(eventSql('closed', '{"evidence":"ended"}'));
  rejects(db, 'N03', eventSql('launched'));
  await commandTransaction(db, async () => createRun(db, { ...values, id: 'run-2' }));
  db.exec("INSERT INTO run_events(id,run_id,status,by_agent) VALUES(100,'run-2','launched','mgr')");
  rejects(db, 'N03', "INSERT INTO run_events(id,run_id,status,by_agent) VALUES(50,'run-2','reported','mgr')");
  rejects(db, 'N03', "INSERT INTO run_events(id,run_id,status,by_agent) VALUES(-1,'run-2','reported','mgr')");
});

test('N03 first event must be intent and every terminal path stays terminal', (t) => {
  const db = seed();
  t.after(() => db.close());
  move(db, 'issued', 'working', 'w1');
  db.exec(runSql());
  rejects(db, 'N03', eventSql('launched'));
  db.exec(eventSql('intent'));
  db.exec(eventSql('failed'));
  assert.equal(getLiveRun(db, CARD), undefined);
  for (const status of ['blocked', 'failed', 'abandoned'] as const) {
    rejects(db, 'N03', eventSql('launched'));
    db.exec(runSql(`run-${status}`));
    addRunEvent(db, `run-${status}`, 'intent', 'mgr');
    addRunEvent(db, `run-${status}`, 'launched', 'mgr');
    addRunEvent(db, `run-${status}`, status, 'mgr');
    assert.equal(getLiveRun(db, CARD), undefined);
    assert.throws(() => addRunEvent(db, `run-${status}`, 'reported', 'mgr'), /APS-N03:/);
  }
});

test('N04 closed needs evidence', async (t) => {
  const db = await workingRun();
  t.after(() => db.close());
  db.exec(eventSql('launched'));
  db.exec(eventSql('reported'));
  rejects(db, 'N04', eventSql('closed'));
  rejects(db, 'N04', eventSql('closed', '{"evidence":null}'));
  db.exec(eventSql('closed', '{"evidence":{"probe":"pane_not_found"}}'));
  assert.equal(getLiveRun(db, CARD), undefined);
});

test('run tables are append-only', async (t) => {
  const db = await workingRun();
  t.after(() => db.close());
  addUsage(db, { run_id: RUN, source: 'none', source_ref: RUN, basis: 'unknown' });
  for (const table of ['worker_runs', 'run_events', 'run_usage']) {
    rejects(db, 'L01', `UPDATE ${table} SET at=at`);
    rejects(db, 'L01', `DELETE FROM ${table}`);
    rejects(db, 'L02', `INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`);
  }
  rejects(
    db,
    'L02',
    `INSERT OR REPLACE INTO run_usage(run_id,source,source_ref,basis) VALUES('${RUN}','none','${RUN}','unknown')`,
  );
});

test('launch metadata survives lifecycle events and cost evidence is idempotent', async (t) => {
  const db = await workingRun();
  t.after(() => db.close());
  const launch = {
    workspace_id: 'w1',
    tab_id: 'w1:t1',
    pane_id: 'w1:p1',
    terminal_id: 'terminal-1',
    pid: 123,
    session_ref: '/sandbox/session.jsonl',
  };
  await commandTransaction(db, async () => {
    addRunEvent(db, RUN, 'launched', 'mgr', launch);
    addRunEvent(db, RUN, 'reported', 'mgr');
    const actual = {
      run_id: RUN,
      source: 'omp-jsonl' as const,
      source_ref: launch.session_ref,
      basis: 'actual' as const,
      provider: 'test-provider',
      model: 'test-model',
      input_tokens: 10,
      output_tokens: 20,
      cache_read_tokens: 5,
      cache_write_tokens: 2,
      cost_usd: 0.25,
    };
    assert.equal(addUsage(db, actual), addUsage(db, actual));
    const unknown = { run_id: RUN, source: 'none' as const, source_ref: RUN, basis: 'unknown' as const };
    assert.equal(addUsage(db, unknown), addUsage(db, { ...unknown, model: null }));
  });
  const current = getLiveRun(db, CARD);
  assert.equal(current?.status, 'reported');
  for (const [key, value] of Object.entries(launch)) assert.equal(current?.[key], value);
  assert.match(String(current?.since), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.deepEqual(
    { ...db.prepare('SELECT * FROM v_run_cost WHERE run_id=?').get(RUN) },
    {
      run_id: RUN,
      card_id: CARD,
      agent_id: 'w1',
      usd_actual: 0.25,
      io_tokens: 30,
      cache_read_tokens: 5,
      unknown_rows: 1,
      usage_rows: 2,
    },
  );
  await commandTransaction(db, async () => addRunEvent(db, RUN, 'closed', 'mgr', { evidence: 'ended' }));
  assert.equal(db.prepare('SELECT pane_id FROM v_run_current WHERE run_id=?').get(RUN)?.pane_id, launch.pane_id);
});

test('run API rolls back identity, events and usage with the caller transaction', async (t) => {
  const db = seed();
  t.after(() => db.close());
  move(db, 'issued', 'working', 'w1');
  await assert.rejects(
    commandTransaction(db, async () => {
      createRun(db, values);
      addUsage(db, { run_id: RUN, source: 'none', source_ref: RUN, basis: 'unknown' });
      throw new Error('caller failure');
    }),
    { message: 'caller failure' },
  );
  for (const table of ['worker_runs', 'run_events', 'run_usage'])
    assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n, 0);
});

test('run schema checks harness kind, sha and actual versus unknown cost', async (t) => {
  const db = seed();
  t.after(() => db.close());
  move(db, 'issued', 'working', 'w1');
  for (const invalid of [
    { harness: 'herdr' as const, kind: null },
    { harness: 'omp' as const, kind: 'omp' as const },
    { base_sha: 'bad' },
    { model: ' ' },
  ]) {
    await assert.rejects(
      commandTransaction(db, async () => createRun(db, { ...values, ...invalid })),
      /CHECK constraint failed/,
    );
  }
  await commandTransaction(db, async () => createRun(db, { ...values, harness: 'omp', kind: null }));
  for (const invalid of [
    { basis: 'actual' as const },
    { basis: 'unknown' as const, cost_usd: 1 },
    { basis: 'actual' as const, cost_usd: -1 },
  ])
    assert.throws(
      () => addUsage(db, { run_id: RUN, source: 'none', source_ref: 'invalid', ...invalid }),
      /CHECK constraint failed/,
    );
  assert.deepEqual(
    { ...db.prepare('SELECT usd_actual,usage_rows,unknown_rows FROM v_run_cost').get() },
    {
      usd_actual: 0,
      usage_rows: 0,
      unknown_rows: 0,
    },
  );
});

test('migrates a v1 ledger with rows to v2 without data loss', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aps-runs-migrate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  copyFileSync(join(APS_SQL_DIR, '0001_aps.sql'), join(dir, '0001_aps.sql'));
  const v1 = seed({ sqlDir: dir });
  move(v1, 'issued', 'working', 'w1');
  const tables = v1.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
  const rows = tables.map((table) => ({
    name: String(table.name),
    rows: v1.prepare(`SELECT * FROM ${table.name}`).all(),
  }));
  const schema = v1
    .prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name")
    .all();
  assert.equal(v1.prepare('PRAGMA user_version').get()?.user_version, 1);
  const file = join(dir, 'ledger.db');
  v1.prepare('VACUUM INTO ?').run(file);
  v1.close();
  const migrated = openApsDb(file);
  assert.equal(migrated.prepare('PRAGMA user_version').get()?.user_version, 2);
  for (const table of rows) assert.deepEqual(migrated.prepare(`SELECT * FROM ${table.name}`).all(), table.rows);
  for (const object of schema)
    assert.deepEqual(migrated.prepare('SELECT type,name,sql FROM sqlite_master WHERE name=?').get(object.name), object);
  assert.deepEqual(doctor(migrated), { integrity: ['ok'], foreignKeys: [], missingTriggers: [] });
  migrated.close();
  const reopened = openApsDb(file);
  t.after(() => reopened.close());
  assert.equal(reopened.prepare('SELECT count(*) AS n FROM worker_runs').get()?.n, 0);
  assert.equal(reopened.prepare('SELECT state FROM cards WHERE id=?').get(CARD)?.state, 'working');
});
