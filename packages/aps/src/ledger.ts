import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { APS_SQL_DIR, listMigrations } from './index.js';

export class ApsInputError extends Error {}
export type Row = Record<string, SQLInputValue>;
export interface Transition {
  card: string;
  from: string | null;
  to: string;
  by: string;
  attempt: number;
}
const activeTransactions = new WeakSet<DatabaseSync>();
export async function commandTransaction<T>(db: DatabaseSync, action: () => Promise<T>): Promise<T> {
  db.exec('BEGIN IMMEDIATE');
  activeTransactions.add(db);
  try {
    const result = await action();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    activeTransactions.delete(db);
  }
}
export function transaction<T>(db: DatabaseSync, action: () => T): T {
  if (activeTransactions.has(db)) return action();
  db.exec('BEGIN IMMEDIATE');
  activeTransactions.add(db);
  try {
    const result = action();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    activeTransactions.delete(db);
  }
}
export function insertRow(db: DatabaseSync, table: string, values: Row): number {
  const keys = Object.keys(values);
  return Number(
    db
      .prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
      .run(...Object.values(values)).lastInsertRowid,
  );
}
export function getCard(db: DatabaseSync, id: string): Row {
  const card = db
    .prepare('SELECT c.*, v.sha, v.rework_count FROM cards c JOIN v_card_current v ON v.card_id=c.id WHERE c.id=?')
    .get(id);
  if (!card) throw new ApsInputError(`card ${id} not found`);
  return card;
}
export function getAgent(db: DatabaseSync, id: string): Row {
  const agent = db.prepare('SELECT * FROM agents WHERE id=?').get(id);
  if (!agent) throw new ApsInputError(`agent ${id} not found`);
  return agent;
}
export function moveCard(db: DatabaseSync, id: string, to: string, by: string, note = ''): Transition {
  const card = getCard(db, id);
  insertRow(db, 'transitions', { card_id: id, from_state: card.state, to_state: to, by_agent: by, note });
  return { card: id, from: String(card.state), to, by, attempt: Number(getCard(db, id).attempt) };
}
export function issueCard(db: DatabaseSync, values: Row): Transition[] {
  return transaction(db, () => {
    const project = db.prepare('SELECT prefix,next_seq FROM projects WHERE id=?').get(values.project);
    if (!project) throw new ApsInputError(`project ${values.project} not found`);
    const id = `${project.prefix}-C-${String(project.next_seq).padStart(4, '0')}`;
    insertRow(db, 'cards', { id, ...values });
    return [{ card: id, from: null, to: 'issued', by: String(values.layer_owner), attempt: 0 }];
  });
}
export function newAgent(db: DatabaseSync, values: Row): string {
  const slug =
    String(values.name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 30) || 'agent';
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  let id = `${slug}-${stamp}`;
  if (db.prepare('SELECT 1 FROM agents WHERE id=?').get(id)) id += `-${randomUUID().slice(0, 8)}`;
  transaction(db, () => insertRow(db, 'agents', { id, ...values }));
  return id;
}
export function startCard(db: DatabaseSync, id: string, assignee: string): Transition[] {
  return transaction(db, () => {
    db.prepare('UPDATE cards SET assignee=? WHERE id=?').run(assignee, id);
    return [moveCard(db, id, 'working', assignee)];
  });
}
export function recordReport(db: DatabaseSync, id: string, values: Row): { id: number } | Transition[] {
  return transaction(db, () => {
    const card = getCard(db, id);
    const reportId = insertRow(db, 'reports', { card_id: id, attempt: card.attempt, ...values });
    return values.status === 'BLOCKED'
      ? { id: reportId }
      : [moveCard(db, id, 'reported', String(values.recorded_by ?? values.by_agent))];
  });
}
export function closeSession(db: DatabaseSync, id: string, by: string, note: string, abandon: boolean): Transition[] {
  return transaction(db, () => {
    const cards = db
      .prepare("SELECT id,state FROM cards WHERE assignee=? AND state IN ('working','reported') ORDER BY id")
      .all(id);
    if (!abandon && cards.some((card) => card.state === 'working'))
      throw new ApsInputError(`agent ${id} has working cards; use --abandon to return them`);
    const changes = cards
      .filter((card) => card.state === 'working')
      .map((card) => moveCard(db, String(card.id), 'issued', by, note));
    db.prepare(
      "UPDATE agents SET status='closed',closed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),closed_by=?,close_note=? WHERE id=?",
    ).run(by, note, id);
    for (const card of cards.filter((card) => card.state === 'reported'))
      changes.push(moveCard(db, String(card.id), 'closed_session', by));
    return changes;
  });
}
export function addLink(
  db: DatabaseSync,
  id: string,
  by: string,
  kind: string,
  ref: string,
  detail: unknown = {},
): void {
  insertRow(db, 'card_links', {
    card_id: id,
    attempt: getCard(db, id).attempt,
    by_agent: by,
    kind,
    ref,
    detail_json: JSON.stringify(detail),
  });
}
export interface LedgerLink {
  kind: string;
  ref: string;
  detail?: unknown;
}
export function recordReview(
  db: DatabaseSync,
  id: string,
  by: string,
  values: Row,
  links: LedgerLink[] = [],
  options?: { partial?: boolean },
): Transition[] {
  if (options?.partial && values.verdict !== 'accept') {
    throw new ApsInputError('partial requires verdict accept');
  }
  return transaction(db, () => {
    const card = getCard(db, id);
    const transitions: Transition[] = [];
    if (card.state === 'closed_session') transitions.push(moveCard(db, id, 'inspecting', by));
    insertRow(db, 'reviews', {
      card_id: id,
      attempt: card.attempt,
      sha: card.sha,
      reviewer: by,
      layer: getAgent(db, by).layer,
      ...values,
    });
    for (const link of links) addLink(db, id, by, link.kind, link.ref, link.detail);
    if (values.verdict === 'revise' || values.verdict === 'reject')
      transitions.push(moveCard(db, id, values.verdict === 'revise' ? 'revise' : 'rejected', by));
    else if (!options?.partial && getCard(db, id).state === 'inspecting') {
      transitions.push(moveCard(db, id, 'accepted', by));
      transitions.push(moveCard(db, id, 'merge_wait', by));
    }
    return transitions;
  });
}
export function recordVision(db: DatabaseSync, id: string, by: string, values: Row): { id: number } | Transition[] {
  return transaction(db, () => {
    const card = getCard(db, id);
    const auditId = insertRow(db, 'vision_audits', {
      card_id: id,
      attempt: card.attempt,
      sha: card.sha,
      auditor: by,
      ...values,
    });
    return values.verdict === 'fail' ? [moveCard(db, id, 'revise', by)] : { id: auditId };
  });
}
export function doctor(db: DatabaseSync): { integrity: string[]; foreignKeys: Row[]; missingTriggers: string[] } {
  const expected = new Set<string>();
  for (const migration of listMigrations()) {
    const sql = readFileSync(join(APS_SQL_DIR, migration.file), 'utf8');
    for (const match of sql.matchAll(/\b(CREATE|DROP)\s+TRIGGER\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?([a-z0-9_]+)/gi)) {
      if (match[1].toUpperCase() === 'CREATE') expected.add(match[2]);
      else expected.delete(match[2]);
    }
  }
  const actual = new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='trigger'")
      .all()
      .map((row) => String(row.name)),
  );
  const result = {
    integrity: db
      .prepare('PRAGMA integrity_check')
      .all()
      .map((row) => String(row.integrity_check)),
    foreignKeys: db.prepare('PRAGMA foreign_key_check').all(),
    missingTriggers: [...expected].filter((name) => !actual.has(name)),
  };
  if (result.integrity.some((value) => value !== 'ok') || result.foreignKeys.length || result.missingTriggers.length)
    throw new Error(`APS-DOCTOR: ledger integrity failed: ${JSON.stringify(result)}`);
  return result;
}
export function escalateFeedback(db: DatabaseSync): string[] {
  return transaction(db, () => {
    const minutes = Number(
      db.prepare("SELECT value FROM settings WHERE key='feedback_escalate_minutes'").get()?.value ?? 30,
    );
    const overdue = db
      .prepare(
        "SELECT id FROM feedback WHERE response IS NULL AND escalated=0 AND julianday(created_at)<julianday('now')-?/1440.0 ORDER BY id",
      )
      .all(minutes);
    for (const row of overdue)
      db.prepare("UPDATE feedback SET escalated=1,escalated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(
        row.id,
      );
    return overdue.map((row) => `APS-K10: feedback ${row.id} unanswered for > ${minutes} min; escalated`);
  });
}
export function respondFeedback(
  db: DatabaseSync,
  id: number,
  by: string,
  response: string,
  reason?: string,
): { id: number } {
  return transaction(db, () => {
    if (!db.prepare('SELECT id FROM feedback WHERE id=?').get(id)) throw new ApsInputError(`feedback ${id} not found`);
    db.prepare(
      "UPDATE feedback SET response=?,response_reason=?,responded_by=?,responded_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
    ).run(response, reason ?? null, by, id);
    return { id };
  });
}
