import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { APS_SQL_DIR, openApsDb } from '../dist/index.js';

export const SHA = 'a'.repeat(40);
export const SHA2 = 'b'.repeat(40);
export const CARD = 'SS-C-0001';
export const AC2 = JSON.stringify([
  { id: 'AC1', text: 'first', command: 'pnpm test', expect: 'exit 0' },
  { id: 'AC2', text: 'second', command: 'pnpm lint', expect: 'exit 0' },
]);
export const EVIDENCE2 = JSON.stringify([
  { ac: 'AC1', command: 'pnpm test', output: 'ok', ok: true },
  { ac: 'AC2', command: 'pnpm lint', output: 'ok', ok: true },
]);
export const SHOTS4 = JSON.stringify([
  { theme: 'light', viewport: 'mobile', path: 'l-m.png' },
  { theme: 'light', viewport: 'desktop', path: 'l-d.png' },
  { theme: 'dark', viewport: 'mobile', path: 'd-m.png' },
  { theme: 'dark', viewport: 'desktop', na_reason: 'desktop has no dark mode' },
]);
export const ITEM = JSON.stringify([{ severity: 'major', category: 'correctness', text: 'off by one', ref: 'a.ts:1' }]);

/** code → exact RAISE message, parsed from every migration file. */
export function guardMessages(): Map<string, string> {
  const sql = readFileSync(`${APS_SQL_DIR}0001_aps.sql`, 'utf8');
  const messages = new Map<string, string>();
  for (const match of sql.matchAll(/RAISE\(ABORT, '(APS-([A-Z]\d{2}): [^']*)'\)/g)) {
    const [, message, code] = match;
    const seen = messages.get(code);
    assert.ok(seen === undefined || seen === message, `${code} has two different messages`);
    messages.set(code, message);
  }
  return messages;
}

const MESSAGES = guardMessages();

/** Runs sql and asserts it is refused with exactly the guard's message. */
export function rejects(db: DatabaseSync, code: string, sql: string): void {
  const message = MESSAGES.get(code);
  assert.ok(message, `unknown guard code ${code}`);
  assert.throws(() => db.exec(sql), { message });
}

/** Project ss, agents and card SS-C-0001 (assignee w1, manager mgr), state issued. */
export function seed(opts: { needsOwner?: 0 | 1; needsVision?: 0 | 1; size?: 'S' | 'M' | 'L' } = {}): DatabaseSync {
  const db = openApsDb(':memory:');
  db.exec(`
    INSERT INTO projects(id,prefix,name) VALUES('ss','SS','SceneSteller');
    INSERT INTO agents(id,name,layer,model,vendor) VALUES
      ('l0','opus-l0','L0','opus-5.5','anthropic'),
      ('mgr','sol-l2','L2','sol-6.1','openai'),
      ('w1','devin','L3','swe-2-max','cognition'),
      ('w1b','devin','L3','swe-2-max','cognition'),
      ('w2','grok','L3','grok-4.7','xai'),
      ('rev','opus-l1','L1','opus-5.5','anthropic'),
      ('viz','viewer','L1','sonnet-5.5','anthropic');
    INSERT INTO cards(id,project,title,kind,size,scope,acceptance_json,forbidden,needs_owner,needs_vision,layer_owner,assignee)
    VALUES('${CARD}','ss','card','mech','${opts.size ?? 'S'}','scope','${AC2}','none',
           ${opts.needsOwner ?? 0},${opts.needsVision ?? 0},'mgr','w1');
  `);
  return db;
}

export function move(db: DatabaseSync, from: string, to: string, by: string, note = ''): void {
  db.exec(
    `INSERT INTO transitions(card_id,from_state,to_state,by_agent,note) VALUES('${CARD}','${from}','${to}','${by}','${note}')`,
  );
}

export function report(db: DatabaseSync, by = 'w1', sha = SHA): void {
  const attempt = (db.prepare('SELECT attempt FROM cards WHERE id = ?').get(CARD) as { attempt: number }).attempt;
  db.exec(`INSERT INTO reports(card_id,attempt,by_agent,sha,branch,files_json,evidence_json,status)
           VALUES('${CARD}',${attempt},'${by}','${sha}','feat/x','["a.ts"]','${EVIDENCE2}','DONE')`);
}

export function closeAgent(db: DatabaseSync, id: string): void {
  db.exec(`UPDATE agents SET status='closed', closed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
           closed_by='mgr', close_note='herdr pane gone' WHERE id='${id}'`);
}

export function review(db: DatabaseSync, verdict: 'accept' | 'revise' | 'reject', sha = SHA): void {
  const attempt = (db.prepare('SELECT attempt FROM cards WHERE id = ?').get(CARD) as { attempt: number }).attempt;
  const items = verdict === 'accept' ? '[]' : ITEM;
  db.exec(`INSERT INTO reviews(card_id,attempt,reviewer,layer,sha,verdict,items_json)
           VALUES('${CARD}',${attempt},'rev','L1','${sha}','${verdict}','${items}')`);
}

/** (issued|revise →) working → reported → closed_session → inspecting, with worker `by`. */
export function toInspecting(db: DatabaseSync, by = 'w1', sha = SHA): void {
  const { state } = cardState(db);
  if (state !== 'working') move(db, state, 'working', by);
  report(db, by, sha);
  move(db, 'working', 'reported', by);
  closeAgent(db, by);
  move(db, 'reported', 'closed_session', 'mgr');
  move(db, 'closed_session', 'inspecting', 'mgr');
}

export function toMergeWait(db: DatabaseSync): void {
  toInspecting(db);
  review(db, 'accept');
  move(db, 'inspecting', 'accepted', 'mgr');
  move(db, 'accepted', 'merge_wait', 'mgr');
}

export function merge(db: DatabaseSync, sha = SHA, by = 'mgr'): void {
  db.exec(`INSERT INTO merges(card_id,sha,merged_sha,target,verified_by,verify_command)
           VALUES('${CARD}','${sha}','${'c'.repeat(40)}','origin/main','${by}','git merge-base --is-ancestor')`);
}

export function cardState(db: DatabaseSync): { state: string; attempt: number } {
  return db.prepare('SELECT state, attempt FROM cards WHERE id = ?').get(CARD) as { state: string; attempt: number };
}
