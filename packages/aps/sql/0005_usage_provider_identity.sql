-- Usage identity gains the provider (issue #15: intermittent "usage identity conflict" on collect).
-- parseOmpUsage aggregates a transcript by (provider, model), but the v2 identity deduplicated by
-- model alone, so one transcript repeating a model under two providers (a real one plus 'unknown'
-- when message.provider is absent) collided with differing evidence. The parser grain and the
-- ledger identity now match; messages are unchanged.
BEGIN IMMEDIATE;

DROP INDEX idx_run_usage_identity;
-- SQLite UNIQUE permits multiple NULLs; unknown-provider evidence must also be idempotent.
CREATE UNIQUE INDEX idx_run_usage_identity ON run_usage(run_id,source,source_ref,
  (provider IS NULL),coalesce(provider,''),(model IS NULL),coalesce(model,''),coalesce(supersedes_id,0));

DROP TRIGGER trg_run_usage_ins;
CREATE TRIGGER trg_run_usage_ins BEFORE INSERT ON run_usage BEGIN
  SELECT RAISE(ABORT, 'APS-L02: ledger rows cannot be replaced')
   WHERE EXISTS (SELECT 1 FROM run_usage WHERE id = NEW.id
                 OR (run_id = NEW.run_id AND source = NEW.source AND source_ref = NEW.source_ref
                     AND provider IS NEW.provider AND model IS NEW.model
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

PRAGMA user_version = 5;
COMMIT;
