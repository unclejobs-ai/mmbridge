import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { APS_SQL_DIR, doctor, openApsDb } from '../dist/index.js';
import { backfillEvents, syncOmpWorkers, syncOwnerEntries } from '../dist/directives.js';
import { CARD, SHA, rejects, seed } from './fixture.ts';

const source = '/canonical/INBOX.md';
const entry = { id: 'IN-20261013-APSMMB', quote: '  대표님 원문\n둘째 줄  \n', cls: 'directive (orchestration host)', to: 'TODO exact text', note: '', at: '2026-10-13 09:00 KST' };

test('owner_directives: STRICT, verbatim unbound intake, required quote and unique IN id', () => {
  const db = seed();
  try {
    syncOwnerEntries(db, backfillEvents([entry], source), source);
    const row = db.prepare('SELECT * FROM owner_directives').get()!;
    assert.equal(row.quote, entry.quote);
    assert.equal(row.card_id, null);
    assert.equal(db.prepare("SELECT strict FROM pragma_table_list WHERE name='owner_directives'").get()?.strict, 1);
    assert.equal(db.prepare("SELECT strict FROM pragma_table_list WHERE name='owner_directive_triage'").get()?.strict, 1);
    const insert = db.prepare('INSERT INTO owner_directives(in_id,quote,source_ref,recorded_by) VALUES(?,?,?,?)');
    for (const quote of ['', '  ', '\n\t\r']) assert.throws(() => insert.run('IN-empty', quote, 'inbox', 'mgr'), /CHECK constraint/);
    assert.throws(() => insert.run('IN-bad-type', new Uint8Array([1]), 'inbox', 'mgr'), /cannot store BLOB/);
    rejects(db, 'L02', `INSERT INTO owner_directives(in_id,quote,source_ref,recorded_by) VALUES('${entry.id}','replace','inbox','mgr')`);
    rejects(db, 'L02', 'INSERT OR REPLACE INTO owner_directives SELECT * FROM owner_directives');
    db.exec('PRAGMA foreign_keys=OFF');
    rejects(db, 'T00', "INSERT INTO owner_directives(in_id,quote,source_ref,recorded_by) VALUES('IN-unknown','x','inbox','unknown')");
    rejects(db, 'T00', "INSERT INTO owner_directives(in_id,quote,source_ref,recorded_by,card_id) VALUES('IN-unknown-card','x','inbox','mgr','unknown')");
  } finally { db.close(); }
});

test('owner_directives: only one NULL-to-card link is allowed; every other update/delete/replacement is refused', () => {
  const db = seed();
  try {
    syncOwnerEntries(db, backfillEvents([entry], source), source);
    for (const field of ['id','in_id','quote','class','dest','note','source_ref','recorded_by','at','card_id']) {
      rejects(db, 'L01', `UPDATE owner_directives SET ${field}=${field}`);
    }
    rejects(db, 'L01', 'DELETE FROM owner_directives');
    rejects(db, 'L01', `UPDATE owner_directives SET card_id='${CARD}',quote='changed'`);
    db.exec('PRAGMA foreign_keys=OFF');
    rejects(db, 'T00', "UPDATE owner_directives SET card_id='missing'");
    db.exec(`UPDATE owner_directives SET card_id='${CARD}'`);
    assert.equal(db.prepare('SELECT card_id FROM owner_directives').get()?.card_id, CARD);
    rejects(db, 'L01', 'UPDATE owner_directives SET card_id=NULL');
    rejects(db, 'L01', `UPDATE owner_directives SET card_id='${CARD}'`);
    rejects(db, 'L01', "UPDATE owner_directives SET card_id='other'");
    rejects(db, 'L01', "UPDATE owner_directive_triage SET note='changed'");
    rejects(db, 'L01', 'DELETE FROM owner_directive_triage');
    rejects(db, 'L02', 'INSERT OR REPLACE INTO owner_directive_triage SELECT * FROM owner_directive_triage');
    rejects(db, 'T00', "INSERT INTO owner_directive_triage(directive_id,class,dest,source_ref,recorded_by) VALUES(999,'now','TODO','bad','mgr')");
  } finally { db.close(); }
});

test('backfill idempotency and triage replay preserve original intake while effective class/dest/note change', () => {
  const db = seed();
  try {
    const entries = [entry, { ...entry, id: 'IN-20261013-02', quote: '두번째', cls: '—', to: '—' }];
    const events = backfillEvents(entries, source);
    assert.deepEqual(syncOwnerEntries(db, events, source), { inserted: 2, triaged: 2, total: 2 });
    assert.deepEqual(syncOwnerEntries(db, events, source), { inserted: 0, triaged: 0, total: 2 });
    const triaged = { ...entry, cls: 'now', to: 'TODO new destination', note: 'triage note' };
    const journal = [...events, { ref: 'event-one', entry: triaged }, { ref: 'event-two', entry }];
    syncOwnerEntries(db, journal, source);
    syncOwnerEntries(db, journal, source);
    assert.equal(db.prepare('SELECT count(*) n FROM owner_directive_triage').get()?.n, 4);
    assert.equal(db.prepare('SELECT class FROM owner_directives WHERE in_id=?').get(entry.id)?.class, entry.cls);
    assert.equal(db.prepare('SELECT class FROM v_owner_directives WHERE in_id=?').get(entry.id)?.class, entry.cls);
    syncOwnerEntries(db, [{ ref: 'event-three', entry: triaged }], source);
    const effective = db.prepare('SELECT quote,class,dest,note FROM v_owner_directives WHERE in_id=?').get(entry.id)!;
    assert.deepEqual({ ...effective }, { quote: entry.quote, class: 'now', dest: triaged.to, note: triaged.note });
    assert.throws(() => syncOwnerEntries(db, [{ ref: 'quote-change', entry: { ...entry, quote: 'changed' } }], source), /owner quote conflict/);
    assert.equal(db.prepare('SELECT count(*) n FROM owner_directives').get()?.n, 2);
  } finally { db.close(); }
});

test('omp-sync upserts identities/cards and inventory, takes allowed edges and never fabricates independent approval', () => {
  const db = seed();
  try {
    const running = 'AirWorker|ss|Original title|working|123|abcdef0';
    const first = syncOmpWorkers(db, running)[0];
    assert.equal(first.state, 'working');
    assert.equal(db.prepare('SELECT source_ref FROM cards WHERE id=?').get(first.card)?.source_ref, 'AirWorker');
    const counts = () => [db.prepare('SELECT count(*) n FROM agents').get()?.n, db.prepare('SELECT count(*) n FROM cards').get()?.n, db.prepare('SELECT count(*) n FROM transitions').get()?.n, db.prepare('SELECT count(*) n FROM card_links').get()?.n];
    const before = counts();
    syncOmpWorkers(db, running);
    assert.deepEqual(counts(), before);
    syncOmpWorkers(db, 'AirWorker|ss|Updated title|idle|124|abcdef0');
    assert.equal(db.prepare("SELECT status FROM agents WHERE name='AirWorker'").get()?.status, 'idle');
    assert.equal(db.prepare("SELECT json_extract(detail_json,'$.title') AS title FROM card_links WHERE card_id=? AND kind='other' ORDER BY id DESC LIMIT 1").get(first.card)?.title, 'Updated title');
    const deferred = syncOmpWorkers(db, 'AirWorker|ss|Updated title|done|124|abcdef0')[0];
    assert.equal(deferred.state, 'working');
    assert.match(deferred.warning!, /full SHA/);
    const reported = syncOmpWorkers(db, `AirWorker|ss|Updated title|done|124|${SHA}`)[0];
    assert.equal(reported.state, 'reported');
    assert.match(reported.warning!, /independent/);
    assert.equal(db.prepare('SELECT count(*) n FROM reviews').get()?.n, 0);
    assert.equal(db.prepare('SELECT count(*) n FROM merges').get()?.n, 0);
    assert.equal(db.prepare('SELECT count(*) n FROM owner_oks').get()?.n, 0);
    assert.equal(db.prepare("SELECT count(*) n FROM transitions t WHERE t.from_state IS NOT NULL AND NOT EXISTS (SELECT 1 FROM state_edges e WHERE e.from_state=t.from_state AND e.to_state=t.to_state)").get()?.n, 0);
    assert.throws(() => syncOmpWorkers(db, 'Invalid|ss|Missing fields'), /expected name/);
    assert.throws(() => syncOmpWorkers(db, 'Unknown|missing|Title|working||'), /project missing/);
    assert.equal(db.prepare("SELECT count(*) n FROM agents WHERE name='Unknown'").get()?.n, 0);
  } finally { db.close(); }
});

test('ssops add/triage remain durable with APS unavailable, preserve whitespace, and replay every triage idempotently', () => {
  const root = mkdtempSync(join(tmpdir(), 'aps-directives-'));
  const cli = fileURLToPath(new URL('../scripts/ssops.mjs', import.meta.url));
  const runner = fileURLToPath(new URL('../dist/ssops-bridge.js', import.meta.url));
  const dbPath = join(root, 'aps.db');
  const run = (args: string[], unavailable = false) => spawnSync(process.execPath, [cli, ...args], {
    env: { ...process.env, SS_WORK: root, SSOPS_APS_RUNNER: unavailable ? join(root, 'absent.js') : runner, MMBRIDGE_APS_DB: dbPath, SSOPS_APS_HOST: '' }, encoding: 'utf8',
  });
  try {
    const quote = '  지시 원문\n\n마지막 줄  \n';
    const added = run(['inbox','add','--text',quote], true);
    assert.equal(added.status, 0, added.stderr);
    assert.match(added.stderr, /WARNING APS/);
    const id = added.stdout.trim();
    for (const cls of ['now','decision']) {
      const result = run(['inbox','triage',id,'--class',cls,'--to',`TODO ${cls}`,'--note',`note ${cls}`], true);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /WARNING APS/);
    }
    assert.equal(readFileSync(join(root, 'INBOX.aps-outbox.jsonl'), 'utf8').trim().split('\n').length, 3);
    assert.match(readFileSync(join(root, 'INBOX.md'), 'utf8'), /class: decision/);
    const replay = run(['inbox','backfill']);
    assert.equal(replay.status, 0, replay.stderr);
    assert.match(replay.stdout, /owner_directives 1 \/ INBOX 1/);
    const db = openApsDb(dbPath);
    try {
      assert.equal(db.prepare('SELECT quote FROM owner_directives').get()?.quote, quote);
      assert.equal(db.prepare('SELECT class FROM owner_directives').get()?.class, 'untriaged');
      assert.equal(db.prepare('SELECT class FROM v_owner_directives').get()?.class, 'decision');
      const before = db.prepare('SELECT count(*) n FROM owner_directive_triage').get()?.n;
      const second = run(['inbox','backfill']);
      assert.equal(second.status, 0, second.stderr);
      assert.equal(db.prepare('SELECT count(*) n FROM owner_directive_triage').get()?.n, before);
      const online = run(['inbox','triage',id,'--class','now','--to','TODO final','--note','last']);
      assert.equal(online.status, 0, online.stderr);
      assert.equal(db.prepare('SELECT class FROM v_owner_directives').get()?.class, 'now');
    } finally { db.close(); }
    // Historical non-numeric IN ids and arbitrary class strings are backfilled verbatim.
    writeFileSync(join(root, 'INBOX.md'), '# INBOX\n\n### IN-20261011-APSMMB · 2026-10-11 12:00 KST · triaged\n> 원문\n- class: directive (legacy)\n- to: DESIGN.md\n- note: —\n');
    const legacy = run(['inbox','backfill']);
    assert.equal(legacy.status, 0, legacy.stderr);
    assert.match(legacy.stdout, /inserted 1/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('migration 0004 upgrades a populated v3 ledger without changing prior rows or guards', () => {
  const root = mkdtempSync(join(tmpdir(), 'aps-directives-migration-'));
  const path = join(root, 'aps.db');
  let db;
  try {
    for (const file of ['0001_aps.sql','0002_worker_runs.sql','0003_review_recorded_by.sql']) copyFileSync(join(APS_SQL_DIR, file), join(root, file));
    const prior = seed({ sqlDir: root });
    const tables = prior.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => String(row.name));
    const rows = tables.map((name) => ({ name, rows: prior.prepare(`SELECT * FROM ${name}`).all() }));
    const triggers = prior.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all();
    prior.prepare('VACUUM INTO ?').run(path);
    prior.close();
    db = openApsDb(path);
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 4);
    for (const table of rows) assert.deepEqual(db.prepare(`SELECT * FROM ${table.name}`).all(), table.rows);
    for (const trigger of triggers) assert.equal(db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(trigger.name)?.sql, trigger.sql);
    rejects(db, 'C08', `UPDATE cards SET state='done' WHERE id='${CARD}'`);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    db.close();
    db = openApsDb(path);
    assert.equal(db.prepare('SELECT count(*) n FROM owner_directives').get()?.n, 0);
  } finally { db?.close(); rmSync(root, { recursive: true, force: true }); }
});

test('doctor checks the applied catalogue on old v1/v2 ledgers and still detects missing current-version guards', () => {
  const root = mkdtempSync(join(tmpdir(), 'aps-doctor-version-'));
  let db;
  try {
    copyFileSync(join(APS_SQL_DIR, '0001_aps.sql'), join(root, '0001_aps.sql'));
    db = openApsDb(':memory:', root);
    assert.deepEqual(doctor(db), { integrity: ['ok'], foreignKeys: [], missingTriggers: [] });
    db.close();
    copyFileSync(join(APS_SQL_DIR, '0002_worker_runs.sql'), join(root, '0002_worker_runs.sql'));
    db = openApsDb(':memory:', root);
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 2);
    assert.deepEqual(doctor(db), { integrity: ['ok'], foreignKeys: [], missingTriggers: [] });
    db.exec('DROP TRIGGER trg_transitions_upd');
    assert.throws(() => doctor(db), /trg_transitions_upd/);
    db.close();
    db = openApsDb(':memory:');
    db.exec('DROP TRIGGER trg_owner_directives_upd');
    assert.throws(() => doctor(db), /trg_owner_directives_upd/);
  } finally { db?.close(); rmSync(root, { recursive: true, force: true }); }
});
