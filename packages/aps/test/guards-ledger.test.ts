// One executed rejection per ledger-integrity guard; L01/L02 run against every table they protect.
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { APS_SQL_DIR, doctor, openApsDb, recordReview } from '../dist/index.js';
import {
  CARD,
  ITEM,
  SHA,
  SHOTS4,
  cardState,
  closeAgent,
  merge,
  move,
  rejects,
  report,
  review,
  seed,
  toInspecting,
} from './fixture.ts';

const LEDGER_TABLES = [
  'transitions',
  'reports',
  'reviews',
  'vision_audits',
  'merges',
  'owner_oks',
  'defects',
  'briefings',
  'quota_samples',
  'card_links',
];
const DELETE_ONLY_TABLES = ['cards', 'agents', 'projects', 'feedback', 'pdca_runs'];
/** table → a no-op SET clause (the lock fires before any change). */
const REFERENCE_TABLES: Record<string, string> = {
  states: 'ord = ord',
  state_edges: 'actor = actor',
  defect_categories: 'description = description',
};

/** A done card with one row in every ledger table. */
function populated(): DatabaseSync {
  const db = seed({ needsVision: 1, needsOwner: 1 });
  toInspecting(db);
  review(db, 'accept');
  db.exec(`INSERT INTO vision_audits(card_id,attempt,sha,auditor,screenshots_json,verdict)
           VALUES('${CARD}',1,'${SHA}','viz','${SHOTS4}','pass');
           INSERT INTO owner_oks(card_id,sha,recorded_by,quote) VALUES('${CARD}','${SHA}','l0','OK');
           INSERT INTO defects(card_id,attempt,source,category,severity,description,opportunity_count,recorded_by)
           VALUES('${CARD}',1,'ci','ci','minor','flaky lint',2,'mgr');
           INSERT INTO briefings(level,author,period_from,period_to,body_md,metrics_json)
           VALUES('L2','mgr','2026-10-11T00:00Z','2026-10-11T02:00Z','# brief','{}');
           INSERT INTO quota_samples(vendor,account,metric,value) VALUES('anthropic','main','weekly_pct',41);
           INSERT INTO card_links(card_id,attempt,kind,ref,detail_json,by_agent)
           VALUES('${CARD}',1,'context_node','node-1','{"parentId":null,"summary":"card","projectKey":"p"}','mgr');
           INSERT INTO feedback(from_agent,to_agent,kind,card_id,body) VALUES('w2','mgr','proposal','${CARD}','split it');
           INSERT INTO pdca_runs(scc_run_id,card_id,problem) VALUES('scc-1','${CARD}','rework rate');`);
  move(db, 'inspecting', 'accepted', 'mgr');
  move(db, 'accepted', 'merge_wait', 'mgr');
  merge(db);
  move(db, 'merge_wait', 'done', 'mgr');
  return db;
}

test('append-only and no-replace: L01, L02 on every table', () => {
  const db = populated();
  for (const table of LEDGER_TABLES) {
    rejects(db, 'L01', `UPDATE ${table} SET at = at`);
    rejects(db, 'L01', `DELETE FROM ${table}`);
  }
  for (const table of DELETE_ONLY_TABLES) rejects(db, 'L01', `DELETE FROM ${table}`);
  for (const table of [...LEDGER_TABLES, ...DELETE_ONLY_TABLES]) {
    rejects(db, 'L02', `INSERT OR REPLACE INTO ${table} SELECT * FROM ${table} LIMIT 1`);
  }
});

test('reference tables: L03 on insert, update and delete', () => {
  const db = seed();
  for (const [table, noop] of Object.entries(REFERENCE_TABLES)) {
    rejects(db, 'L03', `INSERT INTO ${table} SELECT * FROM ${table} LIMIT 1`);
    rejects(db, 'L03', `UPDATE ${table} SET ${noop}`);
    rejects(db, 'L03', `DELETE FROM ${table}`);
  }
  rejects(db, 'L03', `INSERT INTO state_edges VALUES('working','done','any',0)`);
});

test('projects: J01, J02', () => {
  const db = seed();
  rejects(db, 'J01', `INSERT INTO projects(id,prefix,name,next_seq) VALUES('mm','MM','mmbridge',5)`);
  rejects(db, 'J01', `UPDATE projects SET next_seq = 99 WHERE id='ss'`);
  rejects(db, 'J02', `UPDATE projects SET prefix = 'SC' WHERE id='ss'`);
});

test('agents: A01–A04', () => {
  const db = seed();
  rejects(
    db,
    'A01',
    `INSERT INTO agents(id,name,layer,model,vendor,status,closed_at) VALUES('x','x','L3','m','v','closed','now')`,
  );
  rejects(db, 'A03', `UPDATE agents SET name='renamed' WHERE id='w2'`);
  rejects(
    db,
    'A04',
    `UPDATE agents SET status='closed', closed_at='now', closed_by='w2', close_note='self' WHERE id='w2'`,
  );
  db.exec(`UPDATE agents SET status='closed', closed_at='now', closed_by='mgr', close_note='done' WHERE id='w2'`);
  rejects(db, 'A02', `UPDATE agents SET status='active', closed_at=NULL WHERE id='w2'`);
});

test('defects: F01–F04', () => {
  const db = seed();
  move(db, 'issued', 'working', 'w1');
  const defect = (o: { opportunity?: number; category?: string; attempt?: number; by?: string }) =>
    `INSERT INTO defects(card_id,attempt,source,category,severity,description,opportunity_count,recorded_by)
     VALUES('${CARD}',${o.attempt ?? 1},'ci','${o.category ?? 'ci'}','minor','red build',${o.opportunity ?? 2},'${o.by ?? 'mgr'}')`;
  rejects(db, 'F01', defect({ opportunity: 7 }));
  rejects(db, 'F02', defect({ category: 'vibes' }));
  rejects(db, 'F03', defect({ attempt: 5 }));
  rejects(db, 'F04', defect({ by: 'ghost' }));
});

test('feedback: K00–K04', () => {
  const db = seed();
  rejects(
    db,
    'K00',
    `INSERT INTO feedback(from_agent,to_agent,kind,body,escalated,escalated_at) VALUES('w2','mgr','andon','stuck',1,'now')`,
  );
  db.exec(`INSERT INTO feedback(from_agent,to_agent,kind,body) VALUES('w2','mgr','objection','spec is wrong')`);
  rejects(db, 'K03', `UPDATE feedback SET body='softer' WHERE id=1`);
  rejects(db, 'K02', `UPDATE feedback SET response='reject', responded_by='mgr', responded_at='now' WHERE id=1`);
  db.exec(`UPDATE feedback SET escalated=1, escalated_at='now' WHERE id=1`);
  rejects(db, 'K04', 'UPDATE feedback SET escalated=0, escalated_at=NULL WHERE id=1');
  db.exec(`UPDATE feedback SET response='accept', responded_by='mgr', responded_at='now' WHERE id=1`);
  rejects(db, 'K01', `UPDATE feedback SET response='partial', response_reason='changed my mind' WHERE id=1`);
});

test('PDCA: Q00–Q06 (Check cannot be skipped)', () => {
  const db = seed();
  rejects(db, 'Q00', `INSERT INTO pdca_runs(scc_run_id,problem,phase) VALUES('scc-0','x','do')`);
  db.exec(`INSERT INTO pdca_runs(scc_run_id,problem) VALUES('scc-1','rework rate')`);
  rejects(db, 'Q05', `UPDATE pdca_runs SET problem='other' WHERE id=1`);
  rejects(db, 'Q01', `UPDATE pdca_runs SET phase='check' WHERE id=1`);
  db.exec(`UPDATE pdca_runs SET phase='do' WHERE id=1`);
  rejects(db, 'Q02', `UPDATE pdca_runs SET phase='check' WHERE id=1`);
  db.exec(`UPDATE pdca_runs SET phase='check', baseline_json='{"rework":0.3}' WHERE id=1`);
  rejects(db, 'Q06', `UPDATE pdca_runs SET baseline_json='{"rework":0.1}' WHERE id=1`);
  rejects(db, 'Q03', `UPDATE pdca_runs SET phase='act' WHERE id=1`);
  db.exec(`UPDATE pdca_runs SET phase='act', result_json='{"rework":0.2}' WHERE id=1`);
  rejects(db, 'Q04', `UPDATE pdca_runs SET phase='closed' WHERE id=1`);
});

test('auto defects from a revise review carry the card opportunity count', () => {
  const db = seed();
  toInspecting(db);
  db.exec(`INSERT INTO reviews(card_id,attempt,reviewer,layer,sha,verdict,items_json)
           VALUES('${CARD}',1,'rev','L1','${SHA}','revise','${ITEM}')`);
  const rows = db.prepare('SELECT source, category, opportunity_count AS n, review_id FROM defects').all();
  assert.deepEqual(
    rows.map((row) => ({ ...row })),
    [{ source: 'review', category: 'correctness', n: 2, review_id: 1 }],
  );
});

test('a closed reviewer without recorded_by still fails V10', () => {
  const db = seed();
  toInspecting(db);
  closeAgent(db, 'rev');
  rejects(
    db,
    'V10',
    `INSERT INTO reviews(card_id,attempt,reviewer,layer,sha,verdict) VALUES('${CARD}',1,'rev','L1','${SHA}','accept')`,
  );
});

test('reviews: V16 proxy recorder', () => {
  const db = seed();
  toInspecting(db);
  const insert = (recordedBy: string) =>
    `INSERT INTO reviews(card_id,attempt,reviewer,layer,sha,verdict,recorded_by) VALUES('${CARD}',1,'rev','L1','${SHA}','accept','${recordedBy}')`;
  rejects(db, 'V16', insert('mgr'));
  rejects(db, 'V16', insert('rev'));
  rejects(db, 'V16', insert('w1'));
  rejects(db, 'V16', insert('nobody'));
  closeAgent(db, 'viz');
  rejects(db, 'V16', insert('viz'));
  db.exec(`INSERT INTO agents(id,name,layer,model,vendor) VALUES('rev2','opus-l1','L1','opus','anthropic')`);
  rejects(db, 'V16', insert('rev2'));
  db.exec(`INSERT INTO agents(id,name,layer,model,vendor) VALUES('l1proxy','proxy','L1','opus','anthropic')`);
  db.exec(insert('l1proxy'));
  db.exec(insert('l0'));
  assert.deepEqual(
    db
      .prepare('SELECT recorded_by FROM reviews ORDER BY id')
      .all()
      .map((row) => row.recorded_by),
    ['l1proxy', 'l0'],
  );
});

test('closed reviewer + live L1 proxy accept moves closed_session through inspecting to merge_wait', () => {
  const db = seed();
  move(db, 'issued', 'working', 'w1');
  report(db);
  move(db, 'working', 'reported', 'w1');
  closeAgent(db, 'w1');
  move(db, 'reported', 'closed_session', 'mgr');
  closeAgent(db, 'rev');
  const transitions = recordReview(db, CARD, 'rev', { verdict: 'accept', items_json: '[]', recorded_by: 'viz' });
  assert.deepEqual(
    transitions.map((row) => ({ to: row.to, by: row.by })),
    [
      { to: 'inspecting', by: 'viz' },
      { to: 'accepted', by: 'viz' },
      { to: 'merge_wait', by: 'viz' },
    ],
  );
  assert.equal(cardState(db).state, 'merge_wait');
  assert.deepEqual(
    { ...db.prepare('SELECT reviewer, layer, recorded_by, verdict FROM reviews').get() },
    {
      reviewer: 'rev',
      layer: 'L1',
      recorded_by: 'viz',
      verdict: 'accept',
    },
  );
});

test('migrates a v2 ledger with rows to v3 without data loss', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aps-review-migrate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  copyFileSync(join(APS_SQL_DIR, '0001_aps.sql'), join(dir, '0001_aps.sql'));
  copyFileSync(join(APS_SQL_DIR, '0002_worker_runs.sql'), join(dir, '0002_worker_runs.sql'));
  const v2 = seed({ sqlDir: dir });
  toInspecting(v2);
  review(v2, 'accept');
  const tables = v2.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
  const rows = tables.map((table) => ({
    name: String(table.name),
    rows: v2.prepare(`SELECT * FROM ${table.name}`).all(),
  }));
  const schema = v2
    .prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name")
    .all();
  assert.equal(v2.prepare('PRAGMA user_version').get()?.user_version, 2);
  const file = join(dir, 'ledger.db');
  v2.prepare('VACUUM INTO ?').run(file);
  v2.close();
  const migrated = openApsDb(file);
  t.after(() => migrated.close());
  assert.equal(migrated.prepare('PRAGMA user_version').get()?.user_version, 3);
  for (const table of rows) {
    const after = migrated.prepare(`SELECT * FROM ${table.name}`).all();
    if (table.name !== 'reviews') {
      assert.deepEqual(after, table.rows);
      continue;
    }
    assert.equal(after.length, table.rows.length);
    for (let i = 0; i < after.length; i++) {
      const current = after[i] as { recorded_by: string | null };
      assert.equal(current.recorded_by, null);
      const { recorded_by: _recordedBy, ...rest } = current;
      assert.deepEqual(rest, { ...table.rows[i] });
    }
  }
  for (const object of schema) {
    const name = String(object.name);
    if (name === 'reviews' || name === 'trg_reviews_ins') continue;
    assert.deepEqual(migrated.prepare('SELECT type,name,sql FROM sqlite_master WHERE name=?').get(name), object);
  }
  assert.equal(
    migrated.prepare("SELECT count(*) AS n FROM pragma_table_info('reviews') WHERE name='recorded_by'").get()?.n,
    1,
  );
  assert.deepEqual(doctor(migrated), { integrity: ['ok'], foreignKeys: [], missingTriggers: [] });
  assert.equal(migrated.prepare('SELECT state FROM cards WHERE id=?').get(CARD)?.state, 'inspecting');
});
