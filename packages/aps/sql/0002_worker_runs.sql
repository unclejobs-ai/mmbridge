-- Dispatch identity, lifecycle and cost evidence. 0001 remains frozen.
BEGIN IMMEDIATE;

CREATE TABLE worker_runs (
  id TEXT PRIMARY KEY CHECK (id NOT GLOB '*[^A-Za-z0-9._:@-]*' AND length(id) BETWEEN 1 AND 96),
  card_id TEXT NOT NULL REFERENCES cards(id),
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  harness TEXT NOT NULL CHECK (harness IN ('herdr','omp','devin','grok')),
  kind TEXT CHECK ((harness = 'herdr') = (kind IS NOT NULL) AND (kind IS NULL OR kind IN ('omp','devin','grok'))),
  model TEXT NOT NULL CHECK (length(trim(model)) > 0),
  worktree TEXT NOT NULL,
  branch TEXT NOT NULL,
  base_sha TEXT NOT NULL CHECK (length(base_sha) IN (40,64) AND base_sha NOT GLOB '*[^0-9a-f]*'),
  packet_dir TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES agents(id),
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT, WITHOUT ROWID;
CREATE TABLE run_events (
  id INTEGER PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES worker_runs(id),
  status TEXT NOT NULL CHECK (status IN ('intent','launched','reported','closed','blocked','failed','abandoned')),
  by_agent TEXT NOT NULL REFERENCES agents(id),
  detail_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail_json)),
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE TABLE run_usage (
  id INTEGER PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES worker_runs(id),
  source TEXT NOT NULL CHECK (source IN ('omp-jsonl','grok-json','none')),
  source_ref TEXT NOT NULL,
  basis TEXT NOT NULL CHECK (basis IN ('actual','unknown')),
  provider TEXT,
  model TEXT,
  input_tokens INTEGER CHECK (input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens >= 0),
  cache_read_tokens INTEGER CHECK (cache_read_tokens >= 0),
  cache_write_tokens INTEGER CHECK (cache_write_tokens >= 0),
  cost_usd REAL CHECK (cost_usd IS NULL OR cost_usd >= 0),
  supersedes_id INTEGER UNIQUE REFERENCES run_usage(id),
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK ((basis = 'actual') = (cost_usd IS NOT NULL)),
  CHECK (source <> 'none' OR basis = 'unknown')
) STRICT;
CREATE INDEX idx_run_events_run ON run_events(run_id,id);
CREATE INDEX idx_worker_runs_card ON worker_runs(card_id);
CREATE INDEX idx_worker_runs_agent ON worker_runs(agent_id);
-- SQLite UNIQUE permits multiple NULLs; unknown-model evidence must also be idempotent.
CREATE UNIQUE INDEX idx_run_usage_identity ON run_usage(run_id,source,source_ref,(model IS NULL),coalesce(model,''),coalesce(supersedes_id,0));

CREATE VIEW v_run_current AS
SELECT r.id AS run_id, r.card_id, r.attempt, r.agent_id, r.harness, r.kind, r.model,
       r.worktree, r.branch, r.packet_dir, e.status, e.at AS since,
       json_extract(l.detail_json,'$.workspace_id') AS workspace_id,
       json_extract(l.detail_json,'$.tab_id') AS tab_id,
       json_extract(l.detail_json,'$.pane_id') AS pane_id,
       json_extract(l.detail_json,'$.terminal_id') AS terminal_id,
       json_extract(l.detail_json,'$.pid') AS pid,
       json_extract(l.detail_json,'$.session_ref') AS session_ref
FROM worker_runs r
LEFT JOIN run_events e ON e.id = (SELECT max(id) FROM run_events WHERE run_id = r.id)
LEFT JOIN run_events l ON l.id = (SELECT max(id) FROM run_events WHERE run_id = r.id AND status = 'launched');

CREATE VIEW v_run_cost AS
SELECT r.id AS run_id, r.card_id, r.agent_id,
       coalesce(sum(u.cost_usd),0.0) AS usd_actual,
       coalesce(sum(coalesce(u.input_tokens,0) + coalesce(u.output_tokens,0)),0) AS io_tokens,
       coalesce(sum(u.cache_read_tokens),0) AS cache_read_tokens,
       coalesce(sum(u.basis = 'unknown'),0) AS unknown_rows,
       count(u.id) AS usage_rows
FROM worker_runs r LEFT JOIN run_usage u
  ON u.run_id = r.id AND NOT EXISTS (SELECT 1 FROM run_usage newer WHERE newer.supersedes_id = u.id)
GROUP BY r.id;

CREATE TRIGGER trg_worker_runs_ins BEFORE INSERT ON worker_runs BEGIN
  SELECT RAISE(ABORT, 'APS-L02: ledger rows cannot be replaced')
   WHERE EXISTS (SELECT 1 FROM worker_runs WHERE id = NEW.id);
  SELECT RAISE(ABORT, 'APS-T00: unknown card or agent')
   WHERE NOT EXISTS (SELECT 1 FROM cards WHERE id = NEW.card_id)
      OR NOT EXISTS (SELECT 1 FROM agents WHERE id = NEW.agent_id)
      OR NOT EXISTS (SELECT 1 FROM agents WHERE id = NEW.created_by);
  SELECT RAISE(ABORT, 'APS-T05: a closed agent session cannot perform transitions')
   WHERE EXISTS (SELECT 1 FROM agents WHERE id IN (NEW.agent_id,NEW.created_by) AND status = 'closed');
  SELECT RAISE(ABORT, 'APS-N01: card already has a live run')
   WHERE EXISTS (SELECT 1 FROM v_run_current WHERE card_id = NEW.card_id
                 AND (status IS NULL OR status IN ('intent','launched','reported')));
  SELECT RAISE(ABORT, 'APS-N02: run must match the card''s working attempt and assignee')
   WHERE NOT EXISTS (SELECT 1 FROM cards WHERE id = NEW.card_id AND state = 'working'
                    AND attempt = NEW.attempt AND assignee = NEW.agent_id);
END;
CREATE TRIGGER trg_run_events_ins BEFORE INSERT ON run_events BEGIN
  SELECT RAISE(ABORT, 'APS-L02: ledger rows cannot be replaced')
   WHERE EXISTS (SELECT 1 FROM run_events WHERE id = NEW.id);
  SELECT RAISE(ABORT, 'APS-T00: unknown card or agent')
   WHERE NOT EXISTS (SELECT 1 FROM worker_runs WHERE id = NEW.run_id)
      OR NOT EXISTS (SELECT 1 FROM agents WHERE id = NEW.by_agent);
  SELECT RAISE(ABORT, 'APS-T05: a closed agent session cannot perform transitions')
   WHERE EXISTS (SELECT 1 FROM agents WHERE id = NEW.by_agent AND status = 'closed');
  SELECT RAISE(ABORT, 'APS-N03: run event is not a forward lifecycle step')
   WHERE NOT (
        (NOT EXISTS (SELECT 1 FROM run_events WHERE run_id = NEW.run_id) AND NEW.status = 'intent')
        OR EXISTS (
          SELECT 1 FROM run_events WHERE id = (SELECT max(id) FROM run_events WHERE run_id = NEW.run_id)
           AND ((status = 'intent' AND NEW.status IN ('launched','failed'))
             OR (status = 'launched' AND NEW.status IN ('reported','blocked','failed','abandoned'))
             OR (status = 'reported' AND NEW.status = 'closed'))
        )
      );
  SELECT RAISE(ABORT, 'APS-N04: closed run event needs close evidence')
   WHERE NEW.status = 'closed' AND NOT (
     coalesce(json_type(NEW.detail_json,'$.evidence') = 'object'
       OR (json_type(NEW.detail_json,'$.evidence') = 'text'
           AND length(trim(json_extract(NEW.detail_json,'$.evidence'))) > 0),0)
   );
END;
-- BEFORE INSERT sees an unspecified rowid as -1; check chronology after allocation.
CREATE TRIGGER trg_run_events_order AFTER INSERT ON run_events BEGIN
  SELECT RAISE(ABORT, 'APS-N03: run event is not a forward lifecycle step')
   WHERE NEW.id < (SELECT max(id) FROM run_events WHERE run_id = NEW.run_id);
END;
CREATE TRIGGER trg_run_usage_ins BEFORE INSERT ON run_usage BEGIN
  SELECT RAISE(ABORT, 'APS-L02: ledger rows cannot be replaced')
   WHERE EXISTS (SELECT 1 FROM run_usage WHERE id = NEW.id
                 OR (run_id = NEW.run_id AND source = NEW.source AND source_ref = NEW.source_ref AND model IS NEW.model
                     AND (supersedes_id IS NEW.supersedes_id OR id IS NOT NEW.supersedes_id))
                 OR supersedes_id = NEW.supersedes_id);
  SELECT RAISE(ABORT, 'APS-T00: unknown card or agent')
   WHERE NOT EXISTS (SELECT 1 FROM worker_runs WHERE id = NEW.run_id);
  SELECT RAISE(ABORT, 'CHECK constraint failed: run_usage_supersedes')
   WHERE NEW.supersedes_id IS NOT NULL AND NOT EXISTS (
     SELECT 1 FROM run_usage WHERE id = NEW.supersedes_id AND run_id = NEW.run_id
       AND basis = 'unknown' AND NEW.basis = 'actual'
   );
END;
CREATE TRIGGER trg_worker_runs_upd BEFORE UPDATE ON worker_runs BEGIN SELECT RAISE(ABORT, 'APS-L01: ledger rows are append-only'); END;
CREATE TRIGGER trg_worker_runs_del BEFORE DELETE ON worker_runs BEGIN SELECT RAISE(ABORT, 'APS-L01: ledger rows are append-only'); END;
CREATE TRIGGER trg_run_events_upd BEFORE UPDATE ON run_events BEGIN SELECT RAISE(ABORT, 'APS-L01: ledger rows are append-only'); END;
CREATE TRIGGER trg_run_events_del BEFORE DELETE ON run_events BEGIN SELECT RAISE(ABORT, 'APS-L01: ledger rows are append-only'); END;
CREATE TRIGGER trg_run_usage_upd BEFORE UPDATE ON run_usage BEGIN SELECT RAISE(ABORT, 'APS-L01: ledger rows are append-only'); END;
CREATE TRIGGER trg_run_usage_del BEFORE DELETE ON run_usage BEGIN SELECT RAISE(ABORT, 'APS-L01: ledger rows are append-only'); END;

PRAGMA user_version = 2;
COMMIT;
