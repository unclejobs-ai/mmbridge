import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { ApsInputError, getCard, insertRow, issueCard, moveCard, newAgent, recordReport, transaction } from './ledger.js';

export interface OwnerEntry {
  id: string;
  quote: string;
  cls: string;
  to: string;
  note: string;
  at: string;
}
export interface OwnerEvent {
  ref: string;
  entry: OwnerEntry;
}
const field = (value: string): string => value === '—' ? '' : value;

/** Stable live tool identity, never reopen a closed agent session. */
function recorder(db: DatabaseSync): string {
  const existing = db.prepare("SELECT id FROM agents WHERE name='ssops' AND status<>'closed' ORDER BY started_at DESC,id DESC LIMIT 1").get();
  return existing ? String(existing.id) : newAgent(db, { name: 'ssops', layer: 'L1', model: 'intake-cli', vendor: 'local' });
}

/** Each event commits independently: no long write lock during a large backfill. */
export function syncOwnerEntries(db: DatabaseSync, events: OwnerEvent[], source: string): { inserted: number; triaged: number; total: number } {
  const by = recorder(db);
  let inserted = 0;
  let triaged = 0;
  for (const event of events) {
    const change = transaction(db, () => {
      const e = event.entry;
      if (!e.id || !e.quote.trim()) throw new ApsInputError(`empty owner entry ${e.id}`);
      const cls = field(e.cls) || 'untriaged';
      const dest = field(e.to);
      const note = field(e.note);
      let row = db.prepare('SELECT id,quote FROM owner_directives WHERE in_id=?').get(e.id);
      let added = 0;
      if (!row) {
        const id = insertRow(db, 'owner_directives', {
          in_id: e.id, quote: e.quote, class: cls, dest, note,
          source_ref: `${source}#${e.id}`, recorded_by: by, at: e.at,
        });
        row = { id, quote: e.quote };
        added = 1;
      } else if (row.quote !== e.quote) {
        throw new ApsInputError(`owner quote conflict ${e.id}; original is immutable; input remains in INBOX/outbox`);
      }
      let revised = 0;
      if (!db.prepare('SELECT 1 FROM owner_directive_triage WHERE source_ref=?').get(event.ref)) {
        insertRow(db, 'owner_directive_triage', {
          directive_id: row.id, class: cls, dest, note, source_ref: event.ref, recorded_by: by,
        });
        revised = 1;
      }
      return { added, revised };
    });
    inserted += change.added;
    triaged += change.revised;
  }
  return { inserted, triaged, total: Number(db.prepare('SELECT count(*) AS n FROM owner_directives').get()?.n) };
}

export function backfillEvents(entries: OwnerEntry[], source: string): OwnerEvent[] {
  return entries.map((entry) => ({ ref: `${source}#backfill:${createHash('sha256').update(JSON.stringify(entry)).digest('hex')}`, entry }));
}

interface WorkerInput { name: string; project: string; title: string; status: string; pr: string; sha: string }
export function parseOmpWorkers(input: string): WorkerInput[] {
  return input.split(/\r?\n/).filter((line) => line.trim() && !line.trimStart().startsWith('#')).map((line, index) => {
    const parts = line.split('|').map((part) => part.trim());
    if (parts.length !== 6 || parts.slice(0, 4).some((part) => !part)) throw new ApsInputError(`omp input line ${index + 1}: expected name|project|title|status|pr|sha`);
    const [name, project, title, status, pr, sha] = parts;
    if (!['issued','running','working','active','idle','blocked','reported','completed','done','closed','rejected','inspecting','accepted','merge_wait','revise'].includes(status)) {
      throw new ApsInputError(`omp input line ${index + 1}: unknown status ${status}`);
    }
    return { name, project, title, status, pr, sha };
  });
}

/** Inventory registration is not a code review or merge approval. Those gates remain fail-closed. */
export function syncOmpWorkers(db: DatabaseSync, input: string): { name: string; card: string; state: string; warning?: string }[] {
  const workers = parseOmpWorkers(input);
  const by = recorder(db);
  return workers.map((worker) => transaction(db, () => {
    if (!db.prepare('SELECT 1 FROM projects WHERE id=?').get(worker.project)) throw new ApsInputError(`project ${worker.project} not found`);
    const previous = db.prepare('SELECT * FROM cards WHERE project=? AND source_ref=? ORDER BY created_at DESC,id DESC').all(worker.project, worker.name);
    if (previous.length > 1) throw new ApsInputError(`ambiguous omp cards for ${worker.name} in ${worker.project}`);
    let card = previous[0];
    let agent = card?.assignee ? db.prepare('SELECT * FROM agents WHERE id=?').get(card.assignee) : db.prepare("SELECT * FROM agents WHERE name=? AND project=? AND status<>'closed' ORDER BY started_at DESC,id DESC LIMIT 1").get(worker.name, worker.project);
    if (!agent) {
      const id = newAgent(db, { name: worker.name, project: worker.project, layer: 'L2', model: 'omp-worker', vendor: 'local' });
      agent = db.prepare('SELECT * FROM agents WHERE id=?').get(id)!;
    }
    if (!card) {
      const issued = issueCard(db, {
        project: worker.project, title: worker.title, kind: 'research', size: 'S',
        scope: 'omp inventory registration only; task acceptance remains in the original brief',
        body_md: `Imported worker: ${worker.name}\nTitle: ${worker.title}\nStatus: ${worker.status}\nPR: ${worker.pr}\nSHA: ${worker.sha}`,
        acceptance_json: JSON.stringify([{ id: 'AC1', text: 'Record the supplied omp worker inventory snapshot, not verification of its implementation.' }]),
        forbidden: 'Do not infer review, merge, paid API permission, or task acceptance from a worker status.',
        needs_owner: 0, needs_vision: 0, layer_owner: by, assignee: agent.id, source_ref: worker.name,
      });
      card = getCard(db, issued[0].card);
    }
    const id = String(card.id);
    const note = `omp inventory: ${worker.status}; title=${worker.title}; pr=${worker.pr}; sha=${worker.sha}`;
    const snapshotRef = `omp:${createHash('sha256').update(JSON.stringify(worker)).digest('hex')}`;
    if (!db.prepare("SELECT 1 FROM card_links WHERE card_id=? AND kind='other' AND ref=?").get(id, snapshotRef)) {
      insertRow(db, 'card_links', { card_id: id, kind: 'other', ref: snapshotRef, detail_json: JSON.stringify(worker), by_agent: by });
    }
    if (worker.pr && !db.prepare("SELECT 1 FROM card_links WHERE card_id=? AND kind='pr' AND ref=?").get(id, worker.pr)) {
      insertRow(db, 'card_links', { card_id: id, kind: 'pr', ref: worker.pr, by_agent: by });
    }
    let state = String(card.state);
    let warning: string | undefined;
    if (worker.status === 'rejected' && state === 'issued') {
      moveCard(db, id, 'rejected', by, note);
      state = 'rejected';
    } else if (worker.status !== 'issued' && worker.status !== 'rejected' && (state === 'issued' || state === 'revise')) {
      if (agent.status === 'closed') warning = 'closed agent session cannot restart; register a new worker session name';
      else {
        if (state === 'issued' && card.title !== worker.title) db.prepare('UPDATE cards SET title=? WHERE id=?').run(worker.title, id);
        moveCard(db, id, 'working', by, note);
        state = 'working';
      }
    }
    if (['reported','completed','done','closed','inspecting','accepted','merge_wait'].includes(worker.status) && state === 'working') {
      if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(worker.sha)) warning = 'report transition deferred: full SHA is missing (supplied SHA retained in inventory snapshot)';
      else {
        recordReport(db, id, {
          by_agent: agent.id, recorded_by: by, sha: worker.sha, branch: `omp/${worker.name}`,
          pr_url: worker.pr || null, files_json: '[]',
          evidence_json: JSON.stringify([{ ac: 'AC1', command: 'ssops omp-sync', output: note, ok: true }]),
          status: 'DONE', body_md: 'Inventory snapshot recorded. No code tests, independent review, session closure, or merge is asserted.',
        });
        state = 'reported';
      }
    }
    if (agent.status !== 'closed') db.prepare('UPDATE agents SET status=? WHERE id=?').run(worker.status === 'idle' ? 'idle' : 'active', agent.id);
    if (!['issued','running','working','active','idle','blocked','reported'].includes(worker.status) && state !== worker.status) {
      warning = warning || `requested ${worker.status} recorded as inventory only; APS remains ${state}; independent report/session/review/merge evidence is required`;
    }
    return { name: worker.name, card: id, state, ...(warning ? { warning } : {}) };
  }));
}
