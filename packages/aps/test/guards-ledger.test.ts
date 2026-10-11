// One executed rejection per ledger-integrity guard; L01/L02 run against every table they protect.
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ApsInputError, recordReview } from '../dist/index.js';
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

function toClosedSession(db: DatabaseSync): void {
  move(db, 'issued', 'working', 'w1');
  report(db);
  move(db, 'working', 'reported', 'w1');
  closeAgent(db, 'w1');
  move(db, 'reported', 'closed_session', 'mgr');
}

test('partial accept on closed_session stops at inspecting; later accept reaches merge_wait', () => {
  const db = seed();
  toClosedSession(db);
  const first = recordReview(db, CARD, 'rev', { verdict: 'accept', items_json: '[]' }, [], { partial: true });
  assert.deepEqual(
    first.map((row) => [row.from, row.to]),
    [['closed_session', 'inspecting']],
  );
  assert.equal(cardState(db).state, 'inspecting');
  assert.equal(db.prepare('SELECT count(*) AS n FROM reviews').get()?.n, 1);

  const second = recordReview(db, CARD, 'viz', { verdict: 'accept', items_json: '[]' });
  assert.deepEqual(
    second.map((row) => row.to),
    ['accepted', 'merge_wait'],
  );
  assert.equal(cardState(db).state, 'merge_wait');
  assert.equal(db.prepare('SELECT count(*) AS n FROM reviews').get()?.n, 2);
});

test('partial with a non-accept verdict is refused', () => {
  const db = seed();
  toClosedSession(db);
  assert.throws(
    () => recordReview(db, CARD, 'rev', { verdict: 'revise', items_json: ITEM }, [], { partial: true }),
    (error: unknown) => error instanceof ApsInputError && error.message === 'partial requires verdict accept',
  );
  assert.equal(cardState(db).state, 'closed_session');
  assert.equal(db.prepare('SELECT count(*) AS n FROM reviews').get()?.n, 0);
});

test('partial accept on inspecting leaves the state unchanged', () => {
  const db = seed();
  toInspecting(db);
  const transitions = recordReview(db, CARD, 'rev', { verdict: 'accept', items_json: '[]' }, [], { partial: true });
  assert.deepEqual(transitions, []);
  assert.equal(cardState(db).state, 'inspecting');
  assert.equal(db.prepare('SELECT reviewer, verdict FROM reviews').get()?.reviewer, 'rev');
});
