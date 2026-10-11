import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { ApsInputError, type Row, insertRow, transaction } from './ledger.js';

export type RunStatus = 'intent' | 'launched' | 'reported' | 'closed' | 'blocked' | 'failed' | 'abandoned';
export type WorkerKind = 'omp' | 'devin' | 'grok';
export interface CreateRunInput {
  id?: string;
  card_id: string;
  attempt: number;
  agent_id: string;
  harness: 'herdr' | WorkerKind;
  kind?: WorkerKind | null;
  model: string;
  worktree: string;
  branch: string;
  base_sha: string;
  packet_dir: string;
  created_by: string;
}
export interface RunUsageInput {
  run_id: string;
  source: 'omp-jsonl' | 'grok-json' | 'none';
  source_ref: string;
  basis: 'actual' | 'unknown';
  provider?: string | null;
  model?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_tokens?: number | null;
  cache_write_tokens?: number | null;
  cost_usd?: number | null;
  /** Explicitly supersede unknown evidence; the original row remains immutable. */
  supersedes_id?: number | null;
}

/** Creates identity and intent atomically, joining an existing commandTransaction. */
export function createRun(db: DatabaseSync, values: CreateRunInput): string {
  return transaction(db, () => {
    const id = values.id ?? randomUUID();
    insertRow(db, 'worker_runs', { ...values, id, kind: values.kind ?? null });
    addRunEvent(db, id, 'intent', values.created_by);
    return id;
  });
}

export function addRunEvent(
  db: DatabaseSync,
  run: string,
  status: RunStatus,
  by: string,
  detail: unknown = {},
): number {
  return insertRow(db, 'run_events', {
    run_id: run,
    status,
    by_agent: by,
    detail_json: JSON.stringify(detail),
  });
}

export function getLiveRun(db: DatabaseSync, card: string): Row | undefined {
  return db
    .prepare(
      "SELECT * FROM v_run_current WHERE card_id=? AND (status IS NULL OR status IN ('intent','launched','reported'))",
    )
    .get(card);
}

/** Replays identical evidence only; unknown→actual requires an explicit supersedes_id. */
export function addUsage(db: DatabaseSync, values: RunUsageInput): number {
  return transaction(db, () => {
    const evidence = {
      ...values,
      provider: values.provider ?? null,
      model: values.model ?? null,
      input_tokens: values.input_tokens ?? null,
      output_tokens: values.output_tokens ?? null,
      cache_read_tokens: values.cache_read_tokens ?? null,
      cache_write_tokens: values.cache_write_tokens ?? null,
      cost_usd: values.cost_usd ?? null,
      supersedes_id: values.supersedes_id ?? null,
    };
    const existing = db
      .prepare(
        'SELECT * FROM run_usage WHERE run_id=? AND source=? AND source_ref=? AND model IS ? AND supersedes_id IS ?',
      )
      .get(values.run_id, values.source, values.source_ref, evidence.model, evidence.supersedes_id);
    if (existing) {
      if (Object.entries(evidence).some(([key, value]) => existing[key] !== value)) {
        throw new ApsInputError('usage identity has conflicting evidence; supersede unknown evidence explicitly');
      }
      return Number(existing.id);
    }
    if (evidence.supersedes_id !== null) {
      const previous = db.prepare('SELECT run_id,basis FROM run_usage WHERE id=?').get(evidence.supersedes_id);
      if (previous?.run_id !== values.run_id || previous?.basis !== 'unknown' || values.basis !== 'actual') {
        throw new ApsInputError(
          'supersedes_id must reference unknown evidence for this run, replaced by actual evidence',
        );
      }
    }
    return insertRow(db, 'run_usage', evidence);
  });
}
