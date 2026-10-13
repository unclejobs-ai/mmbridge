-- Migration 0004: unbound owner intake plus immutable triage history.
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
BEGIN IMMEDIATE;

CREATE TABLE owner_directives (
  id          INTEGER PRIMARY KEY,
  in_id       TEXT NOT NULL UNIQUE CHECK (length(trim(in_id)) > 0),
  quote       TEXT NOT NULL CHECK (length(trim(quote, char(9)||char(10)||char(13)||' ')) > 0),
  class       TEXT NOT NULL DEFAULT 'untriaged',
  dest        TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT '',
  source_ref  TEXT NOT NULL CHECK (length(trim(source_ref)) > 0),
  recorded_by TEXT NOT NULL REFERENCES agents(id),
  at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  card_id     TEXT REFERENCES cards(id)
) STRICT;

CREATE TABLE owner_directive_triage (
  id           INTEGER PRIMARY KEY,
  directive_id INTEGER NOT NULL REFERENCES owner_directives(id),
  class        TEXT NOT NULL CHECK (length(trim(class)) > 0),
  dest         TEXT NOT NULL,
  note         TEXT NOT NULL DEFAULT '',
  source_ref   TEXT NOT NULL UNIQUE CHECK (length(trim(source_ref)) > 0),
  recorded_by  TEXT NOT NULL REFERENCES agents(id),
  at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE INDEX idx_owner_triage_directive ON owner_directive_triage(directive_id, id);
CREATE INDEX idx_owner_directives_card ON owner_directives(card_id);

CREATE VIEW v_owner_directives AS
SELECT d.id,d.in_id,d.quote,coalesce(t.class,d.class) AS class,
       coalesce(t.dest,d.dest) AS dest,coalesce(t.note,d.note) AS note,
       d.source_ref,d.recorded_by,d.at,d.card_id,t.at AS triaged_at
FROM owner_directives d LEFT JOIN owner_directive_triage t
  ON t.id=(SELECT max(h.id) FROM owner_directive_triage h WHERE h.directive_id=d.id);

CREATE TRIGGER trg_owner_directives_ins BEFORE INSERT ON owner_directives BEGIN
  SELECT RAISE(ABORT, 'APS-L02: ledger rows cannot be replaced')
    WHERE EXISTS (SELECT 1 FROM owner_directives WHERE id=NEW.id OR in_id=NEW.in_id);
  SELECT RAISE(ABORT, 'APS-T00: unknown card or agent')
    WHERE NOT EXISTS (SELECT 1 FROM agents WHERE id=NEW.recorded_by)
       OR (NEW.card_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM cards WHERE id=NEW.card_id));
END;
CREATE TRIGGER trg_owner_directives_upd BEFORE UPDATE ON owner_directives BEGIN
  SELECT RAISE(ABORT, 'APS-L01: ledger rows are append-only')
    WHERE NOT (OLD.card_id IS NULL AND NEW.card_id IS NOT NULL
      AND NEW.id IS OLD.id AND NEW.in_id IS OLD.in_id AND NEW.quote IS OLD.quote
      AND NEW.class IS OLD.class AND NEW.dest IS OLD.dest AND NEW.note IS OLD.note
      AND NEW.source_ref IS OLD.source_ref AND NEW.recorded_by IS OLD.recorded_by AND NEW.at IS OLD.at);
  SELECT RAISE(ABORT, 'APS-T00: unknown card or agent')
    WHERE NOT EXISTS (SELECT 1 FROM cards WHERE id=NEW.card_id);
END;
CREATE TRIGGER trg_owner_directives_del BEFORE DELETE ON owner_directives
BEGIN SELECT RAISE(ABORT, 'APS-L01: ledger rows are append-only'); END;
CREATE TRIGGER trg_owner_triage_ins BEFORE INSERT ON owner_directive_triage BEGIN
  SELECT RAISE(ABORT, 'APS-L02: ledger rows cannot be replaced')
    WHERE EXISTS (SELECT 1 FROM owner_directive_triage WHERE id=NEW.id OR source_ref=NEW.source_ref);
  SELECT RAISE(ABORT, 'APS-T00: unknown card or agent')
    WHERE NOT EXISTS (SELECT 1 FROM agents WHERE id=NEW.recorded_by)
       OR NOT EXISTS (SELECT 1 FROM owner_directives WHERE id=NEW.directive_id);
END;
CREATE TRIGGER trg_owner_triage_upd BEFORE UPDATE ON owner_directive_triage
BEGIN SELECT RAISE(ABORT, 'APS-L01: ledger rows are append-only'); END;
CREATE TRIGGER trg_owner_triage_del BEFORE DELETE ON owner_directive_triage
BEGIN SELECT RAISE(ABORT, 'APS-L01: ledger rows are append-only'); END;

PRAGMA user_version = 4;
COMMIT;
