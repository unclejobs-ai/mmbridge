import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { APS_DB_ENV, APS_SQL_DIR, listMigrations, openApsDb, resolveApsDbPath } from '../dist/index.js';
import {
  CARD,
  ITEM,
  SHA,
  SHA2,
  SHOTS4,
  cardState,
  closeAgent,
  merge,
  move,
  rejects,
  review,
  seed,
  toInspecting,
} from './fixture.ts';

test('smoke: an allowed transition succeeds; done without a review is refused', () => {
  const db = seed();
  move(db, 'issued', 'working', 'w1');
  assert.deepEqual({ ...cardState(db) }, { state: 'working', attempt: 1 });
  rejects(db, 'C08', `UPDATE cards SET state='done' WHERE id='${CARD}'`);
  rejects(
    db,
    'T02',
    `INSERT INTO transitions(card_id,from_state,to_state,by_agent) VALUES('${CARD}','working','done','mgr')`,
  );
  toInspecting(db);
  rejects(
    db,
    'V01',
    `INSERT INTO transitions(card_id,from_state,to_state,by_agent) VALUES('${CARD}','inspecting','accepted','mgr')`,
  );
  assert.deepEqual({ ...cardState(db) }, { state: 'inspecting', attempt: 1 });
});

test('allowed path: revise once, then vision pass + owner OK + merge → done', () => {
  const db = seed({ needsOwner: 1, needsVision: 1 });
  toInspecting(db, 'w1', SHA);
  review(db, 'revise', SHA);
  move(db, 'inspecting', 'revise', 'mgr');
  db.exec(`UPDATE cards SET assignee='w2' WHERE id='${CARD}'`);
  toInspecting(db, 'w2', SHA2);
  review(db, 'accept', SHA2);
  db.exec(`INSERT INTO vision_audits(card_id,attempt,sha,auditor,screenshots_json,verdict)
           VALUES('${CARD}',2,'${SHA2}','viz','${SHOTS4}','pass')`);
  db.exec(`INSERT INTO owner_oks(card_id,sha,recorded_by,quote) VALUES('${CARD}','${SHA2}','l0','OK')`);
  move(db, 'inspecting', 'accepted', 'mgr');
  move(db, 'accepted', 'merge_wait', 'mgr');
  merge(db, SHA2);
  move(db, 'merge_wait', 'done', 'mgr');

  assert.deepEqual({ ...cardState(db) }, { state: 'done', attempt: 2 });
  const chain = db
    .prepare(
      `SELECT group_concat(to_state, '>') AS c FROM (SELECT to_state FROM transitions WHERE card_id = ? ORDER BY id)`,
    )
    .get(CARD) as { c: string };
  assert.equal(
    chain.c,
    'issued>working>reported>closed_session>inspecting>revise>working>reported>closed_session>inspecting>accepted>merge_wait>done',
  );
  const defects = db.prepare('SELECT source, opportunity_count FROM defects').all();
  assert.deepEqual(
    defects.map((d) => ({ ...d })),
    JSON.parse(ITEM).map(() => ({ source: 'review', opportunity_count: 2 })),
  );
});

test('mmbridge review import: session id and gate result live on the review row', () => {
  const db = seed();
  toInspecting(db);
  const uuid = '0f8fad5b-d9cb-469f-a165-70867728950e';
  const gate = JSON.stringify({ status: 'pass', warnings: [], baseRef: 'origin/main', diffDigest: 'abc123' });
  db.exec(`INSERT INTO reviews(card_id,attempt,reviewer,layer,sha,verdict,mmbridge_session_id,gate_json)
           VALUES('${CARD}',1,'rev','L1','${SHA}','accept','${uuid}','${gate}')`);
  const row = db.prepare('SELECT mmbridge_session_id, json_extract(gate_json, ?) AS s FROM reviews').get('$.status');
  assert.deepEqual({ ...row }, { mmbridge_session_id: uuid, s: 'pass' });
  assert.throws(
    () =>
      db.exec(`INSERT INTO reviews(card_id,attempt,reviewer,layer,sha,verdict,gate_json)
               VALUES('${CARD}',1,'rev','L1','${SHA}','accept','${gate}')`),
    { message: 'CHECK constraint failed: review_gate' },
  );
  assert.throws(
    () =>
      db.exec(`INSERT INTO reviews(card_id,attempt,reviewer,layer,sha,verdict,mmbridge_session_id)
               VALUES('${CARD}',1,'rev','L1','${SHA}','accept','not-a-uuid')`),
    /CHECK constraint failed/,
  );
  move(db, 'inspecting', 'accepted', 'mgr');
  assert.throws(
    () =>
      db.exec(`INSERT INTO merges(card_id,sha,merged_sha,target,verified_by,verify_command,gate_json)
               VALUES('${CARD}','${SHA}','${'c'.repeat(40)}','origin/main','mgr','git merge-base','{"status":"fail"}')`),
    /CHECK constraint failed/,
  );
});

test('a closed agent session cannot move cards', () => {
  const db = seed();
  move(db, 'issued', 'working', 'w1');
  closeAgent(db, 'w2');
  rejects(
    db,
    'T05',
    `INSERT INTO transitions(card_id,from_state,to_state,by_agent) VALUES('${CARD}','working','reported','w2')`,
  );
});

test('openApsDb applies migrations once and refuses a newer ledger (APS-U01)', () => {
  assert.deepEqual(
    listMigrations().map((m) => m.version),
    [1, 2, 3, 4, 5],
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aps-'));
  const file = path.join(dir, 'nested', 'aps.db');
  openApsDb(file).close();
  const reopened = openApsDb(file);
  assert.equal(reopened.prepare('PRAGMA user_version').get()?.user_version, 5);
  assert.equal(reopened.prepare('PRAGMA foreign_keys').get()?.foreign_keys, 1);
  reopened.close();

  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA user_version = 99');
  raw.close();
  assert.throws(() => openApsDb(file), { message: 'APS-U01: ledger schema v99 is newer than this build (max v5)' });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('migration catalogue rejects duplicate versions on fresh and migrated ledgers', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aps-duplicate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'aps.db');
  openApsDb(file).close();
  fs.copyFileSync(path.join(APS_SQL_DIR, '0001_aps.sql'), path.join(dir, '0001_aps.sql'));
  fs.copyFileSync(path.join(APS_SQL_DIR, '0002_worker_runs.sql'), path.join(dir, '0002_worker_runs.sql'));
  fs.writeFileSync(
    path.join(dir, '0002_legacy_items.sql'),
    'CREATE TABLE legacy_items(id TEXT); PRAGMA user_version=2;',
  );
  assert.throws(() => listMigrations(dir), /duplicate APS migration version 2/);
  assert.throws(() => openApsDb(':memory:', dir), /duplicate APS migration version 2/);
  assert.throws(() => openApsDb(file, dir), /duplicate APS migration version 2/);
  const unchanged = openApsDb(file);
  t.after(() => unchanged.close());
  assert.equal(unchanged.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='legacy_items'").get()?.n, 0);
});

test('migration loader refuses a file that stamps the wrong user_version', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aps-version-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.copyFileSync(path.join(APS_SQL_DIR, '0001_aps.sql'), path.join(dir, '0001_aps.sql'));
  fs.copyFileSync(path.join(APS_SQL_DIR, '0002_worker_runs.sql'), path.join(dir, '0002_worker_runs.sql'));
  fs.writeFileSync(
    path.join(dir, '0003_legacy_items.sql'),
    'BEGIN IMMEDIATE; CREATE TABLE legacy_items(id TEXT); PRAGMA user_version=2; COMMIT;',
  );
  assert.throws(() => openApsDb(':memory:', dir), /0003_legacy_items.sql set user_version 2, expected 3/);
});

test('resolveApsDbPath precedence: flag > env > config > default', () => {
  const env = { [APS_DB_ENV]: '/env/aps.db' };
  assert.equal(resolveApsDbPath({ flag: '/flag/aps.db', env, configPath: '/cfg/aps.db' }), '/flag/aps.db');
  assert.equal(resolveApsDbPath({ env, configPath: '/cfg/aps.db' }), '/env/aps.db');
  assert.equal(resolveApsDbPath({ env: {}, configPath: '/cfg/aps.db' }), '/cfg/aps.db');
  assert.equal(resolveApsDbPath({ env: {} }), path.join(os.homedir(), 'ss-work', 'aps', 'aps.db'));
});
