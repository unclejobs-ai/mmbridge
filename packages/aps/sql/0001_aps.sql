-- packages/aps/sql/0001_aps.sql — APS ledger schema v1 (migration 0001). Applied by openApsDb() (src/index.ts).
-- Every writer connection MUST run: PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
-- Guards are triggers. Every rejection message starts with 'APS-<code>:' (catalogue: docs/aps/DESIGN.md §5).
-- Guards are written fail-closed: a missing referenced row (FK off, raw SQL) never satisfies a guard.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

BEGIN IMMEDIATE;

-- ───────────── reference tables (fixed by migrations; locked by triggers at the end) ─────────────
CREATE TABLE states (
  name      TEXT PRIMARY KEY,
  ord       INTEGER NOT NULL UNIQUE,
  kanban_ko TEXT NOT NULL,
  terminal  INTEGER NOT NULL CHECK (terminal IN (0,1))
) STRICT, WITHOUT ROWID;

INSERT INTO states VALUES
  ('issued',1,'발행',0), ('working',2,'작업',0), ('reported',3,'완료보고',0),
  ('closed_session',4,'종료',0), ('inspecting',5,'검수',0), ('revise',6,'수정요청',0),
  ('accepted',7,'수락',0), ('merge_wait',8,'머지대기',0), ('done',9,'완료',1), ('rejected',10,'반려',1);

-- actor: 'manager' = by_agent must not be the assignee (compared by agents.name, i.e. worker identity)
CREATE TABLE state_edges (
  from_state    TEXT NOT NULL REFERENCES states(name),
  to_state      TEXT NOT NULL REFERENCES states(name),
  actor         TEXT NOT NULL CHECK (actor IN ('any','manager')),
  note_required INTEGER NOT NULL CHECK (note_required IN (0,1)),
  PRIMARY KEY (from_state, to_state)
) STRICT, WITHOUT ROWID;

INSERT INTO state_edges VALUES
  ('issued','working','any',0),
  ('issued','rejected','manager',1),
  ('working','reported','any',0),
  ('working','issued','manager',1),
  ('reported','closed_session','any',0),
  ('closed_session','inspecting','manager',0),
  ('inspecting','accepted','manager',0),
  ('inspecting','revise','manager',0),
  ('inspecting','rejected','manager',0),
  ('accepted','merge_wait','manager',0),
  ('accepted','revise','manager',0),
  ('merge_wait','done','manager',0),
  ('merge_wait','revise','manager',0),
  ('revise','working','any',0),
  ('revise','rejected','manager',1);

CREATE TABLE defect_categories (
  code        TEXT PRIMARY KEY,
  description TEXT NOT NULL
) STRICT, WITHOUT ROWID;

INSERT INTO defect_categories VALUES
  ('correctness','wrong behaviour or logic'), ('test','missing, weak or failing test'),
  ('security','security or privacy'), ('data','data integrity or migration'), ('perf','performance'),
  ('ux','interaction or flow'), ('visual','layout, colour, typography, responsive'),
  ('copy','wording, tone, i18n'), ('docs','documentation'), ('spec','acceptance not met or scope deviation'),
  ('process','APS process violation (missing evidence, session left open, ...)'), ('ci','CI or build failure'),
  ('other','anything else (explain in text)');

-- CLI-side configuration only. Nothing guard-relevant lives here (it is writable).
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT, WITHOUT ROWID;
INSERT INTO settings VALUES ('feedback_escalate_minutes','30');

-- ───────────── core tables ─────────────
CREATE TABLE projects (
  id         TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 40 AND id NOT GLOB '*[^a-z0-9-]*'),
  prefix     TEXT NOT NULL UNIQUE CHECK (length(prefix) BETWEEN 2 AND 8 AND prefix NOT GLOB '*[^A-Z]*'),
  name       TEXT NOT NULL CHECK (length(trim(name)) > 0),
  next_seq   INTEGER NOT NULL DEFAULT 1 CHECK (next_seq >= 1),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

-- One row per agent SESSION. name = stable worker identity (lane/persona); used for independence checks.
CREATE TABLE agents (
  id         TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64 AND id NOT GLOB '*[^A-Za-z0-9._:@-]*'),
  name       TEXT NOT NULL CHECK (length(trim(name)) > 0),
  layer      TEXT NOT NULL CHECK (layer IN ('L0','L1','L2','L3')),
  model      TEXT NOT NULL CHECK (length(trim(model)) > 0),
  vendor     TEXT NOT NULL CHECK (length(vendor) > 0 AND vendor NOT GLOB '*[^a-z0-9-]*'),
  project    TEXT REFERENCES projects(id),
  herdr_pane TEXT,
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','idle','closed')),
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  closed_at  TEXT,
  closed_by  TEXT REFERENCES agents(id),
  close_note TEXT,
  CONSTRAINT agent_closed_at CHECK ((status = 'closed') = (closed_at IS NOT NULL))
) STRICT;

CREATE TABLE cards (
  id              TEXT PRIMARY KEY,
  project         TEXT NOT NULL REFERENCES projects(id),
  title           TEXT NOT NULL CHECK (length(trim(title)) > 0),
  kind            TEXT NOT NULL CHECK (kind IN ('mech','design','review','vision','research')),
  size            TEXT NOT NULL CHECK (size IN ('S','M','L')),
  scope           TEXT NOT NULL CHECK (length(trim(scope)) > 0),
  body_md         TEXT NOT NULL DEFAULT '',
  acceptance_json TEXT NOT NULL,
  forbidden       TEXT NOT NULL CHECK (length(trim(forbidden)) > 0),
  needs_owner     INTEGER NOT NULL CHECK (needs_owner IN (0,1)),
  needs_vision    INTEGER NOT NULL CHECK (needs_vision IN (0,1)),
  layer_owner     TEXT NOT NULL REFERENCES agents(id),
  assignee        TEXT REFERENCES agents(id),
  parent_card     TEXT REFERENCES cards(id),
  source_ref      TEXT,
  state           TEXT NOT NULL DEFAULT 'issued' CHECK (state IN ('issued','working','reported','closed_session',
                    'inspecting','revise','accepted','merge_wait','done','rejected')),
  attempt         INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

-- The ONLY way to move a card: INSERT here. trg_transitions_apply then updates cards.state/attempt.
CREATE TABLE transitions (
  id         INTEGER PRIMARY KEY,
  card_id    TEXT NOT NULL REFERENCES cards(id),
  from_state TEXT REFERENCES states(name),
  to_state   TEXT NOT NULL REFERENCES states(name),
  by_agent   TEXT NOT NULL REFERENCES agents(id),
  note       TEXT NOT NULL DEFAULT '',
  at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE TABLE reports (
  id            INTEGER PRIMARY KEY,
  card_id       TEXT NOT NULL REFERENCES cards(id),
  attempt       INTEGER NOT NULL CHECK (attempt >= 1),
  by_agent      TEXT NOT NULL REFERENCES agents(id),
  recorded_by   TEXT REFERENCES agents(id),
  sha           TEXT NOT NULL,
  branch        TEXT NOT NULL CHECK (length(trim(branch)) > 0),
  pr_url        TEXT,
  files_json    TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  risks         TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL CHECK (status IN ('DONE','DONE_WITH_CONCERNS','BLOCKED')),
  body_md       TEXT NOT NULL DEFAULT '',
  at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CONSTRAINT report_sha_hex CHECK (length(sha) IN (40,64) AND sha NOT GLOB '*[^0-9a-f]*')
) STRICT;

CREATE TABLE reviews (
  id                  INTEGER PRIMARY KEY,
  card_id             TEXT NOT NULL REFERENCES cards(id),
  attempt             INTEGER NOT NULL CHECK (attempt >= 1),
  reviewer            TEXT NOT NULL REFERENCES agents(id),
  layer               TEXT NOT NULL CHECK (layer IN ('L0','L1','L2','L3')),
  on_behalf_of        TEXT CHECK (on_behalf_of IS NULL OR on_behalf_of = 'owner'),
  sha                 TEXT NOT NULL,
  verdict             TEXT NOT NULL CHECK (verdict IN ('accept','revise','reject')),
  items_json          TEXT NOT NULL DEFAULT '[]',
  mmbridge_session_id TEXT CHECK (mmbridge_session_id IS NULL OR (length(mmbridge_session_id) = 36
                        AND mmbridge_session_id GLOB '????????-????-????-????-????????????'
                        AND mmbridge_session_id NOT GLOB '*[^0-9a-f-]*')),
  -- mmbridge gate result for the imported session: {status:pass|warn, warnings:[{code,message,nextCommand}], baseRef, diffDigest}
  gate_json           TEXT,
  at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CONSTRAINT review_gate CHECK (gate_json IS NULL OR (mmbridge_session_id IS NOT NULL AND json_valid(gate_json)
                                AND json_extract(gate_json, '$.status') IN ('pass','warn')
                                AND json_type(gate_json, '$.warnings') = 'array'))
) STRICT;

CREATE TABLE vision_audits (
  id               INTEGER PRIMARY KEY,
  card_id          TEXT NOT NULL REFERENCES cards(id),
  attempt          INTEGER NOT NULL CHECK (attempt >= 1),
  sha              TEXT NOT NULL,
  auditor          TEXT NOT NULL REFERENCES agents(id),
  screenshots_json TEXT NOT NULL,
  verdict          TEXT NOT NULL CHECK (verdict IN ('pass','fail')),
  items_json       TEXT NOT NULL DEFAULT '[]',
  notes            TEXT NOT NULL DEFAULT '',
  at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

-- Merge / apply confirmation for the accepted sha.
CREATE TABLE merges (
  id             INTEGER PRIMARY KEY,
  card_id        TEXT NOT NULL REFERENCES cards(id),
  sha            TEXT NOT NULL,
  merged_sha     TEXT CHECK (merged_sha IS NULL OR (length(merged_sha) IN (40,64) AND merged_sha NOT GLOB '*[^0-9a-f]*')),
  applied_ref    TEXT CHECK (applied_ref IS NULL OR length(trim(applied_ref)) > 0),
  target         TEXT NOT NULL CHECK (length(trim(target)) > 0),
  verified_by    TEXT NOT NULL REFERENCES agents(id),
  verify_command TEXT NOT NULL CHECK (length(trim(verify_command)) > 0),
  -- mmbridge gate run just before merge (same shape as reviews.gate_json); NULL for non-git "applied" changes
  gate_json      TEXT CHECK (gate_json IS NULL OR (json_valid(gate_json)
                             AND json_extract(gate_json, '$.status') IN ('pass','warn')
                             AND json_type(gate_json, '$.warnings') = 'array')),
  at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CONSTRAINT merge_ref CHECK (merged_sha IS NOT NULL OR applied_ref IS NOT NULL)
) STRICT;

CREATE TABLE owner_oks (
  id          INTEGER PRIMARY KEY,
  card_id     TEXT NOT NULL REFERENCES cards(id),
  sha         TEXT NOT NULL,
  recorded_by TEXT NOT NULL REFERENCES agents(id),
  quote       TEXT NOT NULL CHECK (length(trim(quote)) > 0),
  source_ref  TEXT,
  at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE TABLE defects (
  id                INTEGER PRIMARY KEY,
  card_id           TEXT NOT NULL REFERENCES cards(id),
  attempt           INTEGER NOT NULL CHECK (attempt >= 1),
  source            TEXT NOT NULL CHECK (source IN ('review','ci','revert','owner','vision')),
  category          TEXT NOT NULL REFERENCES defect_categories(code),
  severity          TEXT NOT NULL CHECK (severity IN ('blocker','major','minor','nit')),
  description       TEXT NOT NULL CHECK (length(trim(description)) > 0),
  ref               TEXT,
  opportunity_count INTEGER NOT NULL CHECK (opportunity_count >= 1),
  review_id         INTEGER REFERENCES reviews(id),
  vision_audit_id   INTEGER REFERENCES vision_audits(id),
  recorded_by       TEXT NOT NULL REFERENCES agents(id),
  at                TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CONSTRAINT defect_provenance CHECK ((source <> 'review' OR review_id IS NOT NULL)
                                  AND (source <> 'vision' OR vision_audit_id IS NOT NULL))
) STRICT;

CREATE TABLE feedback (
  id              INTEGER PRIMARY KEY,
  from_agent      TEXT NOT NULL REFERENCES agents(id),
  to_agent        TEXT NOT NULL REFERENCES agents(id),
  kind            TEXT NOT NULL CHECK (kind IN ('objection','proposal','andon')),
  card_id         TEXT REFERENCES cards(id),
  body            TEXT NOT NULL CHECK (length(trim(body)) > 0),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  response        TEXT CHECK (response IS NULL OR response IN ('accept','partial','reject')),
  response_reason TEXT,
  responded_by    TEXT REFERENCES agents(id),
  responded_at    TEXT,
  escalated       INTEGER NOT NULL DEFAULT 0 CHECK (escalated IN (0,1)),
  escalated_at    TEXT,
  CONSTRAINT feedback_response_complete CHECK ((response IS NULL) = (responded_at IS NULL)
                                           AND (response IS NULL) = (responded_by IS NULL)),
  CONSTRAINT feedback_escalated_at CHECK ((escalated = 1) = (escalated_at IS NOT NULL))
) STRICT;

CREATE TABLE briefings (
  id           INTEGER PRIMARY KEY,
  level        TEXT NOT NULL CHECK (level IN ('L0','L1','L2')),
  author       TEXT NOT NULL REFERENCES agents(id),
  period_from  TEXT NOT NULL,
  period_to    TEXT NOT NULL,
  body_md      TEXT NOT NULL CHECK (length(trim(body_md)) > 0),
  metrics_json TEXT NOT NULL CHECK (json_valid(metrics_json)),
  at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CONSTRAINT briefing_period CHECK (period_from <= period_to)
) STRICT;

CREATE TABLE pdca_runs (
  id            INTEGER PRIMARY KEY,
  scc_run_id    TEXT NOT NULL UNIQUE,
  card_id       TEXT REFERENCES cards(id),
  problem       TEXT NOT NULL CHECK (length(trim(problem)) > 0),
  phase         TEXT NOT NULL DEFAULT 'plan' CHECK (phase IN ('plan','do','check','act','closed')),
  baseline_json TEXT CHECK (baseline_json IS NULL OR json_valid(baseline_json)),
  result_json   TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  insight       TEXT,
  at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE TABLE quota_samples (
  id      INTEGER PRIMARY KEY,
  vendor  TEXT NOT NULL CHECK (length(vendor) > 0 AND vendor NOT GLOB '*[^a-z0-9-]*'),
  account TEXT NOT NULL CHECK (length(trim(account)) > 0),
  metric  TEXT NOT NULL CHECK (length(trim(metric)) > 0),
  value   REAL NOT NULL,
  at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

-- External links (mmbridge context-tree node, handoff, run, PR, preview URL, scc run). Append-only.
-- context_node detail_json = {parentId, summary, projectKey} copied at link time: lineage survives autoCompact.
CREATE TABLE card_links (
  id          INTEGER PRIMARY KEY,
  card_id     TEXT NOT NULL REFERENCES cards(id),
  attempt     INTEGER,
  kind        TEXT NOT NULL CHECK (kind IN ('context_node','handoff','mmbridge_run','pr','preview_url','scc_run','other')),
  ref         TEXT NOT NULL CHECK (length(trim(ref)) > 0),
  detail_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail_json)),
  by_agent    TEXT NOT NULL REFERENCES agents(id),
  at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

-- ───────────── indexes ─────────────
CREATE INDEX idx_agents_status      ON agents(status);
CREATE INDEX idx_agents_name        ON agents(name);
CREATE INDEX idx_cards_state        ON cards(project, state);
CREATE INDEX idx_cards_assignee     ON cards(assignee);
CREATE INDEX idx_cards_parent       ON cards(parent_card);
CREATE INDEX idx_transitions_card   ON transitions(card_id, id);
CREATE INDEX idx_transitions_to_at  ON transitions(to_state, at);
CREATE INDEX idx_reports_card       ON reports(card_id, attempt, id);
CREATE INDEX idx_reviews_card       ON reviews(card_id, attempt, id);
CREATE INDEX idx_reviews_mmbridge   ON reviews(mmbridge_session_id) WHERE mmbridge_session_id IS NOT NULL;
CREATE INDEX idx_vision_card        ON vision_audits(card_id, attempt, id);
CREATE INDEX idx_merges_card        ON merges(card_id, sha);
CREATE INDEX idx_owner_oks_card     ON owner_oks(card_id, sha);
CREATE INDEX idx_defects_card       ON defects(card_id, attempt);
CREATE INDEX idx_defects_source_at  ON defects(source, at);
CREATE INDEX idx_feedback_open      ON feedback(to_agent, created_at) WHERE response IS NULL;
CREATE INDEX idx_briefings_level_at ON briefings(level, at);
CREATE INDEX idx_quota_lookup       ON quota_samples(vendor, account, metric, at);
CREATE INDEX idx_card_links_card    ON card_links(card_id, kind);

-- ───────────── views (single source for guards, card show, todo-render) ─────────────
-- Current attempt's reported sha = latest DONE/DONE_WITH_CONCERNS report of cards.attempt.
CREATE VIEW v_card_current AS
SELECT c.id AS card_id, c.project, c.state, c.attempt, c.assignee, c.needs_owner, c.needs_vision,
       json_array_length(c.acceptance_json) AS acceptance_count,
       r.id AS report_id, r.sha AS sha, r.status AS report_status,
       (SELECT count(*) FROM transitions t WHERE t.card_id = c.id AND t.to_state = 'revise') AS rework_count,
       (SELECT v.verdict FROM reviews v WHERE v.card_id = c.id AND v.attempt = c.attempt ORDER BY v.id DESC LIMIT 1) AS latest_review,
       (SELECT a.verdict FROM vision_audits a WHERE a.card_id = c.id AND a.attempt = c.attempt ORDER BY a.id DESC LIMIT 1) AS latest_vision,
       (SELECT g.status FROM agents g WHERE g.id = c.assignee) AS assignee_status,
       EXISTS (SELECT 1 FROM merges m WHERE m.card_id = c.id AND m.sha = r.sha) AS merge_ok,
       EXISTS (SELECT 1 FROM owner_oks o WHERE o.card_id = c.id AND o.sha = r.sha) AS owner_ok
FROM cards c
LEFT JOIN reports r ON r.id = (SELECT max(r2.id) FROM reports r2
                               WHERE r2.card_id = c.id AND r2.attempt = c.attempt
                                 AND r2.status IN ('DONE','DONE_WITH_CONCERNS'));

CREATE VIEW v_kanban AS
SELECT c.id AS card_id, c.project, c.title, c.kind, c.state, s.kanban_ko, s.ord AS state_ord,
       c.assignee, c.layer_owner, c.attempt, v.rework_count, c.needs_owner, c.needs_vision,
       (SELECT max(t.at) FROM transitions t WHERE t.card_id = c.id) AS since
FROM cards c JOIN states s ON s.name = c.state JOIN v_card_current v ON v.card_id = c.id;

-- ───────────── guards: reference tables are fixed ─────────────
CREATE TRIGGER trg_states_ins BEFORE INSERT ON states BEGIN SELECT RAISE(ABORT, 'APS-L03: reference tables change only via migrations'); END;
CREATE TRIGGER trg_states_upd BEFORE UPDATE ON states BEGIN SELECT RAISE(ABORT, 'APS-L03: reference tables change only via migrations'); END;
CREATE TRIGGER trg_states_del BEFORE DELETE ON states BEGIN SELECT RAISE(ABORT, 'APS-L03: reference tables change only via migrations'); END;
CREATE TRIGGER trg_edges_ins  BEFORE INSERT ON state_edges BEGIN SELECT RAISE(ABORT, 'APS-L03: reference tables change only via migrations'); END;
CREATE TRIGGER trg_edges_upd  BEFORE UPDATE ON state_edges BEGIN SELECT RAISE(ABORT, 'APS-L03: reference tables change only via migrations'); END;
CREATE TRIGGER trg_edges_del  BEFORE DELETE ON state_edges BEGIN SELECT RAISE(ABORT, 'APS-L03: reference tables change only via migrations'); END;
CREATE TRIGGER trg_dcat_ins   BEFORE INSERT ON defect_categories BEGIN SELECT RAISE(ABORT, 'APS-L03: reference tables change only via migrations'); END;
CREATE TRIGGER trg_dcat_upd   BEFORE UPDATE ON defect_categories BEGIN SELECT RAISE(ABORT, 'APS-L03: reference tables change only via migrations'); END;
CREATE TRIGGER trg_dcat_del   BEFORE DELETE ON defect_categories BEGIN SELECT RAISE(ABORT, 'APS-L03: reference tables change only via migrations'); END;

-- ───────────── guards: append-only ledger tables (L01 update/delete, L02 no INSERT OR REPLACE) ─────────────
CREATE TRIGGER trg_transitions_upd BEFORE UPDATE ON transitions BEGIN SELECT RAISE(ABORT, 'APS-L01: ledger rows are append-only'); END;
CREATE TRIGGER trg_transitions_del BEFORE DELETE ON transitions BEGIN SELECT RAISE(ABORT, 'APS-L01: ledger rows are append-only'); END;
CREATE TRIGGER trg_reports_upd     BEFORE UPDATE ON reports BEGIN SELECT RAISE(ABORT, 'APS-L01: ledger rows are append-only'); END;
CREATE TRIGGER trg_reports_del     BEFORE DELETE ON reports BEGIN SELECT RAISE(ABORT, 'APS-L01: ledger rows are append-only'); END;
CREATE TRIGGER trg_reviews_upd     BEFORE UPDATE ON reviews BEGIN SELECT RAISE(ABORT, 'APS-L01: ledger rows are append-only'); END;
CREATE TRIGGER trg_reviews_del     BEFORE DELETE ON reviews BEGIN SELECT RAISE(ABORT, 'APS-L01: ledger rows are append-only'); END;
CREATE TRIGGER trg_vision_upd      BEFORE UPDATE ON vision_audits BEGIN SELECT RAISE(ABORT, 'APS-L01: ledger rows are append-only'); END;
CREATE TRIGGER trg_vision_del      BEFORE DELETE ON vision_audits BEGIN SELECT RAISE(ABORT, 'APS-L01: ledger rows are append-only'); END;
CREATE TRIGGER trg_merges_upd      BEFORE UPDATE ON merges BEGIN SELECT RAISE(ABORT, 'APS-L01: ledger rows are append-only'); END;
CREATE TRIGGER trg_merges_del      BEFORE DELETE ON merges BEGIN SELECT RAISE(ABORT, 'APS-L01: ledger rows are append-only'); END;
CREATE TRIGGER trg_owner_oks_upd   BEFORE UPDATE ON owner_oks BEGIN SELECT RAISE(ABORT, 'APS-L01: ledger rows are append-only'); END;
CREATE TRIGGER trg_owner_oks_del   BEFORE DELETE ON owner_oks BEGIN SELECT RAISE(ABORT, 'APS-L01: ledger rows are append-only'); END;
CREATE TRIGGER trg_defects_upd     BEFORE UPDATE ON defects BEGIN SELECT RAISE(ABORT, 'APS-L01: ledger rows are append-only'); END;
CREATE TRIGGER trg_defects_del     BEFORE DELETE ON defects BEGIN SELECT RAISE(ABORT, 'APS-L01: ledger rows are append-only'); END;
CREATE TRIGGER trg_briefings_upd   BEFORE UPDATE ON briefings BEGIN SELECT RAISE(ABORT, 'APS-L01: ledger rows are append-only'); END;
CREATE TRIGGER trg_briefings_del   BEFORE DELETE ON briefings BEGIN SELECT RAISE(ABORT, 'APS-L01: ledger rows are append-only'); END;
CREATE TRIGGER trg_quota_upd       BEFORE UPDATE ON quota_samples BEGIN SELECT RAISE(ABORT, 'APS-L01: ledger rows are append-only'); END;
CREATE TRIGGER trg_quota_del       BEFORE DELETE ON quota_samples BEGIN SELECT RAISE(ABORT, 'APS-L01: ledger rows are append-only'); END;
CREATE TRIGGER trg_links_upd       BEFORE UPDATE ON card_links BEGIN SELECT RAISE(ABORT, 'APS-L01: ledger rows are append-only'); END;
CREATE TRIGGER trg_links_del       BEFORE DELETE ON card_links BEGIN SELECT RAISE(ABORT, 'APS-L01: ledger rows are append-only'); END;
CREATE TRIGGER trg_cards_del       BEFORE DELETE ON cards BEGIN SELECT RAISE(ABORT, 'APS-L01: ledger rows are append-only'); END;
CREATE TRIGGER trg_agents_del      BEFORE DELETE ON agents BEGIN SELECT RAISE(ABORT, 'APS-L01: ledger rows are append-only'); END;
CREATE TRIGGER trg_projects_del    BEFORE DELETE ON projects BEGIN SELECT RAISE(ABORT, 'APS-L01: ledger rows are append-only'); END;
CREATE TRIGGER trg_feedback_del    BEFORE DELETE ON feedback BEGIN SELECT RAISE(ABORT, 'APS-L01: ledger rows are append-only'); END;
CREATE TRIGGER trg_pdca_del        BEFORE DELETE ON pdca_runs BEGIN SELECT RAISE(ABORT, 'APS-L01: ledger rows are append-only'); END;

CREATE TRIGGER trg_briefings_ins BEFORE INSERT ON briefings BEGIN
  SELECT RAISE(ABORT, 'APS-L02: ledger rows cannot be replaced') WHERE EXISTS (SELECT 1 FROM briefings WHERE id = NEW.id);
END;
CREATE TRIGGER trg_quota_ins BEFORE INSERT ON quota_samples BEGIN
  SELECT RAISE(ABORT, 'APS-L02: ledger rows cannot be replaced') WHERE EXISTS (SELECT 1 FROM quota_samples WHERE id = NEW.id);
END;
CREATE TRIGGER trg_links_ins BEFORE INSERT ON card_links BEGIN
  SELECT RAISE(ABORT, 'APS-L02: ledger rows cannot be replaced') WHERE EXISTS (SELECT 1 FROM card_links WHERE id = NEW.id);
  SELECT RAISE(ABORT, 'APS-T00: unknown card or agent')
   WHERE NOT EXISTS (SELECT 1 FROM cards WHERE id = NEW.card_id) OR NOT EXISTS (SELECT 1 FROM agents WHERE id = NEW.by_agent);
END;

-- ───────────── guards: projects (card id allocation) ─────────────
CREATE TRIGGER trg_projects_ins BEFORE INSERT ON projects BEGIN
  SELECT RAISE(ABORT, 'APS-L02: ledger rows cannot be replaced')
   WHERE EXISTS (SELECT 1 FROM projects WHERE id = NEW.id OR prefix = NEW.prefix);
  SELECT RAISE(ABORT, 'APS-J01: next_seq advances only by issuing a card') WHERE NEW.next_seq <> 1;
END;
CREATE TRIGGER trg_projects_upd BEFORE UPDATE ON projects BEGIN
  SELECT RAISE(ABORT, 'APS-J02: project id, prefix and created_at are immutable')
   WHERE NEW.id IS NOT OLD.id OR NEW.prefix IS NOT OLD.prefix OR NEW.created_at IS NOT OLD.created_at;
  SELECT RAISE(ABORT, 'APS-J01: next_seq advances only by issuing a card')
   WHERE NEW.next_seq IS NOT OLD.next_seq
     AND (NEW.next_seq <> OLD.next_seq + 1
          OR NOT EXISTS (SELECT 1 FROM cards WHERE id = printf('%s-C-%04d', OLD.prefix, OLD.next_seq)));
END;

-- ───────────── guards: agents ─────────────
CREATE TRIGGER trg_agents_ins BEFORE INSERT ON agents BEGIN
  SELECT RAISE(ABORT, 'APS-L02: ledger rows cannot be replaced') WHERE EXISTS (SELECT 1 FROM agents WHERE id = NEW.id);
  SELECT RAISE(ABORT, 'APS-A01: a new agent session must start active with no close fields')
   WHERE NEW.status <> 'active' OR NEW.closed_at IS NOT NULL OR NEW.closed_by IS NOT NULL OR NEW.close_note IS NOT NULL;
END;
CREATE TRIGGER trg_agents_upd BEFORE UPDATE ON agents BEGIN
  SELECT RAISE(ABORT, 'APS-A02: a closed agent session is final; register a new agent id') WHERE OLD.status = 'closed';
  SELECT RAISE(ABORT, 'APS-A03: agent identity fields are immutable')
   WHERE NEW.id IS NOT OLD.id OR NEW.name IS NOT OLD.name OR NEW.layer IS NOT OLD.layer OR NEW.model IS NOT OLD.model
      OR NEW.vendor IS NOT OLD.vendor OR NEW.project IS NOT OLD.project OR NEW.started_at IS NOT OLD.started_at;
  SELECT RAISE(ABORT, 'APS-A04: closing a session needs close_note and closed_by = another live agent')
   WHERE NEW.status = 'closed'
     AND (length(trim(coalesce(NEW.close_note, ''))) = 0
          OR NEW.closed_by IS NULL OR NEW.closed_by = NEW.id
          OR NOT EXISTS (SELECT 1 FROM agents WHERE id = NEW.closed_by AND status <> 'closed'));
END;

-- ───────────── guards: cards ─────────────
CREATE TRIGGER trg_cards_ins BEFORE INSERT ON cards BEGIN
  SELECT RAISE(ABORT, 'APS-L02: ledger rows cannot be replaced') WHERE EXISTS (SELECT 1 FROM cards WHERE id = NEW.id);
  SELECT RAISE(ABORT, 'APS-C01: a new card must start in state issued with attempt 0')
   WHERE NEW.state <> 'issued' OR NEW.attempt <> 0;
  SELECT RAISE(ABORT, 'APS-C02: card id must be the next id of its project (<PREFIX>-C-<NNNN>)')
   WHERE NEW.id IS NOT (SELECT printf('%s-C-%04d', prefix, next_seq) FROM projects WHERE id = NEW.project);
  SELECT RAISE(ABORT, 'APS-C03: acceptance_json must be a non-empty JSON array of {id:"AC<n>",text,command?,expect?} with unique ids')
   WHERE CASE WHEN json_valid(NEW.acceptance_json)
              THEN json_type(NEW.acceptance_json) <> 'array' OR json_array_length(NEW.acceptance_json) = 0
              ELSE 1 END;
  SELECT RAISE(ABORT, 'APS-C03: acceptance_json must be a non-empty JSON array of {id:"AC<n>",text,command?,expect?} with unique ids')
   WHERE EXISTS (SELECT 1 FROM json_each(NEW.acceptance_json) j
                 WHERE CASE WHEN j.type <> 'object' THEN 1
                            ELSE json_type(j.value, '$.id') IS NOT 'text'
                              OR json_extract(j.value, '$.id') NOT GLOB 'AC[1-9]*'
                              OR substr(json_extract(j.value, '$.id'), 3) GLOB '*[^0-9]*'
                              OR json_type(j.value, '$.text') IS NOT 'text'
                              OR length(trim(json_extract(j.value, '$.text'))) = 0
                              OR coalesce(json_type(j.value, '$.command'), 'text') <> 'text'
                              OR coalesce(json_type(j.value, '$.expect'), 'text') <> 'text' END)
      OR (SELECT count(DISTINCT json_extract(value, '$.id')) FROM json_each(NEW.acceptance_json))
         <> json_array_length(NEW.acceptance_json);
  SELECT RAISE(ABORT, 'APS-C04: mech cards need a non-empty command and expect on every acceptance item')
   WHERE NEW.kind = 'mech'
     AND EXISTS (SELECT 1 FROM json_each(NEW.acceptance_json) j
                 WHERE length(trim(coalesce(json_extract(j.value, '$.command'), ''))) = 0
                    OR length(trim(coalesce(json_extract(j.value, '$.expect'), ''))) = 0);
  SELECT RAISE(ABORT, 'APS-C05: layer_owner must be a live (not closed) agent')
   WHERE NOT EXISTS (SELECT 1 FROM agents WHERE id = NEW.layer_owner AND status <> 'closed');
  SELECT RAISE(ABORT, 'APS-C06: assignee and parent_card must exist')
   WHERE (NEW.assignee IS NOT NULL AND NOT EXISTS (SELECT 1 FROM agents WHERE id = NEW.assignee))
      OR (NEW.parent_card IS NOT NULL AND NOT EXISTS (SELECT 1 FROM cards WHERE id = NEW.parent_card));
END;

CREATE TRIGGER trg_cards_issued AFTER INSERT ON cards BEGIN
  UPDATE projects SET next_seq = next_seq + 1 WHERE id = NEW.project;
  INSERT INTO transitions (card_id, from_state, to_state, by_agent, note)
  VALUES (NEW.id, NULL, 'issued', NEW.layer_owner, 'card issued');
END;

CREATE TRIGGER trg_cards_upd BEFORE UPDATE ON cards BEGIN
  SELECT RAISE(ABORT, 'APS-C07: card id, project and created_at are immutable')
   WHERE NEW.id IS NOT OLD.id OR NEW.project IS NOT OLD.project OR NEW.created_at IS NOT OLD.created_at;
  SELECT RAISE(ABORT, 'APS-C08: card state changes only by inserting into transitions')
   WHERE (NEW.state IS NOT OLD.state OR NEW.attempt IS NOT OLD.attempt)
     AND NOT EXISTS (SELECT 1 FROM transitions t
                     WHERE t.id = (SELECT max(id) FROM transitions WHERE card_id = OLD.id)
                       AND t.from_state IS OLD.state AND t.to_state IS NEW.state
                       AND NEW.attempt = OLD.attempt + (NEW.state = 'working'));
  SELECT RAISE(ABORT, 'APS-C09: card spec is frozen once work starts (editable only while issued)')
   WHERE OLD.state <> 'issued'
     AND (NEW.title IS NOT OLD.title OR NEW.kind IS NOT OLD.kind OR NEW.size IS NOT OLD.size
          OR NEW.scope IS NOT OLD.scope OR NEW.body_md IS NOT OLD.body_md
          OR NEW.acceptance_json IS NOT OLD.acceptance_json OR NEW.forbidden IS NOT OLD.forbidden
          OR NEW.needs_owner IS NOT OLD.needs_owner OR NEW.needs_vision IS NOT OLD.needs_vision
          OR NEW.layer_owner IS NOT OLD.layer_owner OR NEW.parent_card IS NOT OLD.parent_card
          OR NEW.source_ref IS NOT OLD.source_ref);
  SELECT RAISE(ABORT, 'APS-C10: assignee can change only while the card is issued or revise')
   WHERE NEW.assignee IS NOT OLD.assignee AND OLD.state NOT IN ('issued','revise');
  SELECT RAISE(ABORT, 'APS-C06: assignee and parent_card must exist')
   WHERE NEW.assignee IS NOT OLD.assignee AND NEW.assignee IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM agents WHERE id = NEW.assignee);
END;

-- ───────────── guards: transitions (ordered; first failing guard wins) ─────────────
CREATE TRIGGER trg_transitions_guard BEFORE INSERT ON transitions BEGIN
  SELECT RAISE(ABORT, 'APS-L02: ledger rows cannot be replaced') WHERE EXISTS (SELECT 1 FROM transitions WHERE id = NEW.id);
  SELECT RAISE(ABORT, 'APS-T00: unknown card or agent')
   WHERE NOT EXISTS (SELECT 1 FROM cards WHERE id = NEW.card_id) OR NOT EXISTS (SELECT 1 FROM agents WHERE id = NEW.by_agent);
  SELECT RAISE(ABORT, 'APS-T05: a closed agent session cannot perform transitions')
   WHERE (SELECT status FROM agents WHERE id = NEW.by_agent) = 'closed';
  SELECT RAISE(ABORT, 'APS-T01: from_state does not match the current card state')
   WHERE (NEW.from_state IS NULL AND EXISTS (SELECT 1 FROM transitions WHERE card_id = NEW.card_id))
      OR (NEW.from_state IS NOT NULL AND NEW.from_state IS NOT (SELECT state FROM cards WHERE id = NEW.card_id));
  SELECT RAISE(ABORT, 'APS-T02: transition not allowed by the state machine')
   WHERE NOT ((NEW.from_state IS NULL AND NEW.to_state = 'issued')
              OR EXISTS (SELECT 1 FROM state_edges WHERE from_state = NEW.from_state AND to_state = NEW.to_state));
  SELECT RAISE(ABORT, 'APS-T03: this transition requires a note')
   WHERE length(trim(NEW.note)) = 0
     AND EXISTS (SELECT 1 FROM state_edges WHERE from_state = NEW.from_state AND to_state = NEW.to_state AND note_required = 1);
  SELECT RAISE(ABORT, 'APS-T04: the assignee cannot perform manager-side transitions on its own card')
   WHERE EXISTS (SELECT 1 FROM state_edges WHERE from_state = NEW.from_state AND to_state = NEW.to_state AND actor = 'manager')
     AND EXISTS (SELECT 1 FROM cards c JOIN agents w ON w.id = c.assignee JOIN agents b ON b.id = NEW.by_agent
                 WHERE c.id = NEW.card_id AND b.name = w.name);
  -- → working
  SELECT RAISE(ABORT, 'APS-W01: working requires an assignee agent session that is not closed')
   WHERE NEW.to_state = 'working'
     AND NOT EXISTS (SELECT 1 FROM cards c JOIN agents a ON a.id = c.assignee
                     WHERE c.id = NEW.card_id AND a.status <> 'closed');
  SELECT RAISE(ABORT, 'APS-W02: size L cards cannot go to an L3 agent; split the card first')
   WHERE NEW.to_state = 'working'
     AND EXISTS (SELECT 1 FROM cards c JOIN agents a ON a.id = c.assignee
                 WHERE c.id = NEW.card_id AND c.size = 'L' AND a.layer = 'L3');
  SELECT RAISE(ABORT, 'APS-W03: card already revised 3 times; L1 must redesign it (reject, then issue a new card with parent_card)')
   WHERE NEW.from_state = 'revise' AND NEW.to_state = 'working'
     AND (SELECT count(*) FROM transitions WHERE card_id = NEW.card_id AND to_state = 'revise') >= 3;
  -- → reported
  SELECT RAISE(ABORT, 'APS-R01: reported requires a DONE or DONE_WITH_CONCERNS report for the current attempt')
   WHERE NEW.to_state = 'reported'
     AND (SELECT report_id FROM v_card_current WHERE card_id = NEW.card_id) IS NULL;
  -- R02/R03 are enforced when the report is inserted (trg_reports_ins); acceptance is frozen after issued (C09).
  -- → closed_session
  SELECT RAISE(ABORT, 'APS-S01: closed_session requires the assignee agent session to be closed')
   WHERE NEW.to_state = 'closed_session'
     AND (SELECT assignee_status FROM v_card_current WHERE card_id = NEW.card_id) IS NOT 'closed';
  -- → accepted / revise / rejected
  SELECT RAISE(ABORT, 'APS-V01: accepted requires the latest review of the current attempt to be accept')
   WHERE NEW.to_state = 'accepted'
     AND (SELECT latest_review FROM v_card_current WHERE card_id = NEW.card_id) IS NOT 'accept';
  SELECT RAISE(ABORT, 'APS-V02: revise requires a latest revise review or a latest failed vision audit on the current attempt')
   WHERE NEW.to_state = 'revise'
     AND NOT EXISTS (SELECT 1 FROM v_card_current WHERE card_id = NEW.card_id
                     AND (latest_review IS 'revise' OR latest_vision IS 'fail'));
  SELECT RAISE(ABORT, 'APS-V03: rejecting an inspected card requires a latest reject review')
   WHERE NEW.from_state = 'inspecting' AND NEW.to_state = 'rejected'
     AND (SELECT latest_review FROM v_card_current WHERE card_id = NEW.card_id) IS NOT 'reject';
  -- → done
  SELECT RAISE(ABORT, 'APS-D01: done requires an accept review on the reported sha with no later revise or reject')
   WHERE NEW.to_state = 'done'
     AND NOT EXISTS (SELECT 1 FROM v_card_current WHERE card_id = NEW.card_id AND sha IS NOT NULL AND latest_review IS 'accept');
  SELECT RAISE(ABORT, 'APS-D02: done requires a merge/apply confirmation for the reported sha')
   WHERE NEW.to_state = 'done'
     AND NOT EXISTS (SELECT 1 FROM v_card_current WHERE card_id = NEW.card_id AND merge_ok = 1);
  -- Assignee closed at done: S01 (closed_session) + A02 (closed is final) + C10 (no reassignment after) imply it.
  SELECT RAISE(ABORT, 'APS-D04: done requires the latest vision audit on the reported sha to pass (mandatory when needs_vision)')
   WHERE NEW.to_state = 'done'
     AND EXISTS (SELECT 1 FROM v_card_current WHERE card_id = NEW.card_id
                 AND ((needs_vision = 1 AND latest_vision IS NOT 'pass') OR latest_vision IS 'fail'));
  SELECT RAISE(ABORT, 'APS-D05: done requires an owner OK on the reported sha (needs_owner)')
   WHERE NEW.to_state = 'done'
     AND EXISTS (SELECT 1 FROM v_card_current WHERE card_id = NEW.card_id AND needs_owner = 1 AND owner_ok = 0);
END;

CREATE TRIGGER trg_transitions_apply AFTER INSERT ON transitions WHEN NEW.from_state IS NOT NULL BEGIN
  UPDATE cards SET state = NEW.to_state, attempt = attempt + (NEW.to_state = 'working') WHERE id = NEW.card_id;
END;

-- ───────────── guards: reports ─────────────
CREATE TRIGGER trg_reports_ins BEFORE INSERT ON reports BEGIN
  SELECT RAISE(ABORT, 'APS-L02: ledger rows cannot be replaced') WHERE EXISTS (SELECT 1 FROM reports WHERE id = NEW.id);
  SELECT RAISE(ABORT, 'APS-P01: reports can be recorded only while the card is working')
   WHERE (SELECT state FROM cards WHERE id = NEW.card_id) IS NOT 'working';
  SELECT RAISE(ABORT, 'APS-P02: report by_agent must be the card assignee (a proxy goes in recorded_by)')
   WHERE NEW.by_agent IS NOT (SELECT assignee FROM cards WHERE id = NEW.card_id)
      OR (NEW.recorded_by IS NOT NULL AND NOT EXISTS (SELECT 1 FROM agents WHERE id = NEW.recorded_by));
  SELECT RAISE(ABORT, 'APS-P03: report attempt must equal the card current attempt')
   WHERE NEW.attempt IS NOT (SELECT attempt FROM cards WHERE id = NEW.card_id);
  SELECT RAISE(ABORT, 'APS-P04: files_json must be a JSON array of non-empty path strings')
   WHERE CASE WHEN json_valid(NEW.files_json) AND json_type(NEW.files_json) = 'array'
              THEN EXISTS (SELECT 1 FROM json_each(NEW.files_json) j WHERE j.type <> 'text' OR length(trim(j.value)) = 0)
              ELSE 1 END;
  SELECT RAISE(ABORT, 'APS-P05: evidence_json must be a JSON array of {ac,command,output,ok} objects')
   WHERE CASE WHEN json_valid(NEW.evidence_json) AND json_type(NEW.evidence_json) = 'array'
              THEN EXISTS (SELECT 1 FROM json_each(NEW.evidence_json) j
                           WHERE CASE WHEN j.type <> 'object' THEN 1
                                      ELSE json_type(j.value, '$.ac') IS NOT 'text'
                                        OR json_type(j.value, '$.command') IS NOT 'text'
                                        OR length(trim(json_extract(j.value, '$.command'))) = 0
                                        OR json_type(j.value, '$.output') IS NOT 'text'
                                        OR length(trim(json_extract(j.value, '$.output'))) = 0
                                        OR coalesce(json_type(j.value, '$.ok'), '') NOT IN ('true','false') END)
              ELSE 1 END;
  SELECT RAISE(ABORT, 'APS-P06: evidence references an acceptance id that is not on the card')
   WHERE EXISTS (SELECT 1 FROM json_each(NEW.evidence_json) e
                 WHERE NOT EXISTS (SELECT 1 FROM cards c, json_each(c.acceptance_json) a
                                   WHERE c.id = NEW.card_id
                                     AND json_extract(a.value, '$.id') = json_extract(e.value, '$.ac')));
  SELECT RAISE(ABORT, 'APS-R02: evidence has fewer items than the card has acceptance criteria')
   WHERE NEW.status IN ('DONE','DONE_WITH_CONCERNS')
     AND json_array_length(NEW.evidence_json)
         < (SELECT json_array_length(acceptance_json) FROM cards WHERE id = NEW.card_id);
  SELECT RAISE(ABORT, 'APS-R03: evidence does not cover every acceptance id')
   WHERE NEW.status IN ('DONE','DONE_WITH_CONCERNS')
     AND EXISTS (SELECT 1 FROM cards c, json_each(c.acceptance_json) a
                 WHERE c.id = NEW.card_id
                   AND NOT EXISTS (SELECT 1 FROM json_each(NEW.evidence_json) e
                                   WHERE json_extract(e.value, '$.ac') = json_extract(a.value, '$.id')));
  SELECT RAISE(ABORT, 'APS-P07: status DONE requires every evidence item ok=true; use DONE_WITH_CONCERNS with risks')
   WHERE NEW.status = 'DONE'
     AND EXISTS (SELECT 1 FROM json_each(NEW.evidence_json) e WHERE json_type(e.value, '$.ok') = 'false');
  SELECT RAISE(ABORT, 'APS-P08: DONE_WITH_CONCERNS requires non-empty risks')
   WHERE NEW.status = 'DONE_WITH_CONCERNS' AND length(trim(NEW.risks)) = 0;
END;

-- ───────────── guards: reviews (+ auto defects for revise items) ─────────────
CREATE TRIGGER trg_reviews_ins BEFORE INSERT ON reviews BEGIN
  SELECT RAISE(ABORT, 'APS-L02: ledger rows cannot be replaced') WHERE EXISTS (SELECT 1 FROM reviews WHERE id = NEW.id);
  SELECT RAISE(ABORT, 'APS-V10: reviewer must be a live agent and layer must equal the reviewer layer')
   WHERE NOT EXISTS (SELECT 1 FROM agents WHERE id = NEW.reviewer AND layer = NEW.layer AND status <> 'closed');
  SELECT RAISE(ABORT, 'APS-V11: accept/revise reviews need state inspecting, accepted or merge_wait; reject needs inspecting')
   WHERE NOT EXISTS (SELECT 1 FROM cards WHERE id = NEW.card_id
                       AND (state = 'inspecting' OR (NEW.verdict <> 'reject' AND state IN ('accepted','merge_wait'))));
  SELECT RAISE(ABORT, 'APS-V12: review attempt and sha must match the current attempt reported sha')
   WHERE NOT EXISTS (SELECT 1 FROM v_card_current WHERE card_id = NEW.card_id AND attempt = NEW.attempt AND sha = NEW.sha);
  SELECT RAISE(ABORT, 'APS-V13: reviewer must be independent of the card assignee and reporters')
   WHERE EXISTS (SELECT 1 FROM agents me JOIN agents w ON w.name = me.name
                 WHERE me.id = NEW.reviewer
                   AND (w.id = (SELECT assignee FROM cards WHERE id = NEW.card_id)
                        OR w.id IN (SELECT by_agent FROM reports WHERE card_id = NEW.card_id)));
  SELECT RAISE(ABORT, 'APS-V14: items_json must be a JSON array of {severity,category,text,ref?} with known severity and category')
   WHERE CASE WHEN json_valid(NEW.items_json) AND json_type(NEW.items_json) = 'array'
              THEN EXISTS (SELECT 1 FROM json_each(NEW.items_json) j
                           WHERE CASE WHEN j.type <> 'object' THEN 1
                                      ELSE coalesce(json_extract(j.value, '$.severity'), '') NOT IN ('blocker','major','minor','nit')
                                        OR NOT EXISTS (SELECT 1 FROM defect_categories d WHERE d.code = json_extract(j.value, '$.category'))
                                        OR json_type(j.value, '$.text') IS NOT 'text'
                                        OR length(trim(json_extract(j.value, '$.text'))) = 0
                                        OR coalesce(json_type(j.value, '$.ref'), 'text') <> 'text' END)
              ELSE 1 END;
  SELECT RAISE(ABORT, 'APS-V15: revise and reject reviews need at least one item')
   WHERE NEW.verdict IN ('revise','reject') AND json_array_length(NEW.items_json) = 0;
END;

CREATE TRIGGER trg_reviews_defects AFTER INSERT ON reviews WHEN NEW.verdict = 'revise' BEGIN
  INSERT INTO defects (card_id, attempt, source, category, severity, description, ref, opportunity_count, review_id, recorded_by)
  SELECT NEW.card_id, NEW.attempt, CASE WHEN NEW.on_behalf_of = 'owner' THEN 'owner' ELSE 'review' END,
         json_extract(j.value, '$.category'), json_extract(j.value, '$.severity'), json_extract(j.value, '$.text'),
         json_extract(j.value, '$.ref'),
         (SELECT json_array_length(acceptance_json) FROM cards WHERE id = NEW.card_id), NEW.id, NEW.reviewer
  FROM json_each(NEW.items_json) j;
END;

-- ───────────── guards: vision audits (+ auto defects for fail items) ─────────────
CREATE TRIGGER trg_vision_ins BEFORE INSERT ON vision_audits BEGIN
  SELECT RAISE(ABORT, 'APS-L02: ledger rows cannot be replaced') WHERE EXISTS (SELECT 1 FROM vision_audits WHERE id = NEW.id);
  SELECT RAISE(ABORT, 'APS-X01: auditor must be a live agent')
   WHERE NOT EXISTS (SELECT 1 FROM agents WHERE id = NEW.auditor AND status <> 'closed');
  SELECT RAISE(ABORT, 'APS-X02: vision audits need state inspecting, accepted or merge_wait')
   WHERE (SELECT state FROM cards WHERE id = NEW.card_id) IS NULL
      OR (SELECT state FROM cards WHERE id = NEW.card_id) NOT IN ('inspecting','accepted','merge_wait');
  SELECT RAISE(ABORT, 'APS-X03: vision audit attempt and sha must match the current attempt reported sha')
   WHERE NOT EXISTS (SELECT 1 FROM v_card_current WHERE card_id = NEW.card_id AND attempt = NEW.attempt AND sha = NEW.sha);
  SELECT RAISE(ABORT, 'APS-X04: vision auditor must differ from the card assignee, reporters and reviewers')
   WHERE EXISTS (SELECT 1 FROM agents me JOIN agents w ON w.name = me.name
                 WHERE me.id = NEW.auditor
                   AND (w.id = (SELECT assignee FROM cards WHERE id = NEW.card_id)
                        OR w.id IN (SELECT by_agent FROM reports WHERE card_id = NEW.card_id)
                        OR w.id IN (SELECT reviewer FROM reviews WHERE card_id = NEW.card_id)));
  SELECT RAISE(ABORT, 'APS-X05: screenshots_json must be a non-empty JSON array of {theme:light|dark,viewport:mobile|desktop,path|na_reason}')
   WHERE CASE WHEN json_valid(NEW.screenshots_json) AND json_type(NEW.screenshots_json) = 'array'
                   AND json_array_length(NEW.screenshots_json) > 0
              THEN EXISTS (SELECT 1 FROM json_each(NEW.screenshots_json) j
                           WHERE CASE WHEN j.type <> 'object' THEN 1
                                      ELSE coalesce(json_extract(j.value, '$.theme'), '') NOT IN ('light','dark')
                                        OR coalesce(json_extract(j.value, '$.viewport'), '') NOT IN ('mobile','desktop')
                                        OR (length(trim(coalesce(json_extract(j.value, '$.path'), ''))) > 0)
                                         = (length(trim(coalesce(json_extract(j.value, '$.na_reason'), ''))) > 0) END)
              ELSE 1 END;
  SELECT RAISE(ABORT, 'APS-X06: a pass needs light+dark x mobile+desktop covered (path or na_reason each)')
   WHERE NEW.verdict = 'pass'
     AND (SELECT count(DISTINCT json_extract(value, '$.theme') || '/' || json_extract(value, '$.viewport'))
          FROM json_each(NEW.screenshots_json)) < 4;
  SELECT RAISE(ABORT, 'APS-X07: items_json must be a JSON array of {severity,category,text,ref?} with known severity and category')
   WHERE CASE WHEN json_valid(NEW.items_json) AND json_type(NEW.items_json) = 'array'
              THEN EXISTS (SELECT 1 FROM json_each(NEW.items_json) j
                           WHERE CASE WHEN j.type <> 'object' THEN 1
                                      ELSE coalesce(json_extract(j.value, '$.severity'), '') NOT IN ('blocker','major','minor','nit')
                                        OR NOT EXISTS (SELECT 1 FROM defect_categories d WHERE d.code = json_extract(j.value, '$.category'))
                                        OR json_type(j.value, '$.text') IS NOT 'text'
                                        OR length(trim(json_extract(j.value, '$.text'))) = 0 END)
              ELSE 1 END;
  SELECT RAISE(ABORT, 'APS-X08: a failed vision audit needs at least one finding in items_json')
   WHERE NEW.verdict = 'fail' AND json_array_length(NEW.items_json) = 0;
END;

CREATE TRIGGER trg_vision_defects AFTER INSERT ON vision_audits WHEN NEW.verdict = 'fail' BEGIN
  INSERT INTO defects (card_id, attempt, source, category, severity, description, ref, opportunity_count, vision_audit_id, recorded_by)
  SELECT NEW.card_id, NEW.attempt, 'vision', json_extract(j.value, '$.category'), json_extract(j.value, '$.severity'),
         json_extract(j.value, '$.text'), json_extract(j.value, '$.ref'),
         (SELECT json_array_length(acceptance_json) FROM cards WHERE id = NEW.card_id), NEW.id, NEW.auditor
  FROM json_each(NEW.items_json) j;
END;

-- ───────────── guards: merges, owner OKs ─────────────
CREATE TRIGGER trg_merges_ins BEFORE INSERT ON merges BEGIN
  SELECT RAISE(ABORT, 'APS-L02: ledger rows cannot be replaced') WHERE EXISTS (SELECT 1 FROM merges WHERE id = NEW.id);
  SELECT RAISE(ABORT, 'APS-M01: merge confirmation needs state accepted or merge_wait')
   WHERE (SELECT state FROM cards WHERE id = NEW.card_id) IS NULL
      OR (SELECT state FROM cards WHERE id = NEW.card_id) NOT IN ('accepted','merge_wait');
  SELECT RAISE(ABORT, 'APS-M02: merge sha must be the reported sha and carry an accept review')
   WHERE NOT EXISTS (SELECT 1 FROM v_card_current v JOIN reviews r
                       ON r.card_id = v.card_id AND r.attempt = v.attempt AND r.sha = v.sha AND r.verdict = 'accept'
                     WHERE v.card_id = NEW.card_id AND v.sha = NEW.sha);
  SELECT RAISE(ABORT, 'APS-M03: merge must be verified by a live agent other than the assignee')
   WHERE NOT EXISTS (SELECT 1 FROM agents WHERE id = NEW.verified_by AND status <> 'closed')
      OR EXISTS (SELECT 1 FROM cards c JOIN agents w ON w.id = c.assignee JOIN agents b ON b.id = NEW.verified_by
                 WHERE c.id = NEW.card_id AND b.name = w.name);
END;

CREATE TRIGGER trg_owner_oks_ins BEFORE INSERT ON owner_oks BEGIN
  SELECT RAISE(ABORT, 'APS-L02: ledger rows cannot be replaced') WHERE EXISTS (SELECT 1 FROM owner_oks WHERE id = NEW.id);
  SELECT RAISE(ABORT, 'APS-O01: owner OK needs state inspecting, accepted or merge_wait')
   WHERE (SELECT state FROM cards WHERE id = NEW.card_id) IS NULL
      OR (SELECT state FROM cards WHERE id = NEW.card_id) NOT IN ('inspecting','accepted','merge_wait');
  SELECT RAISE(ABORT, 'APS-O02: owner OK sha must be the current attempt reported sha')
   WHERE NOT EXISTS (SELECT 1 FROM v_card_current WHERE card_id = NEW.card_id AND sha = NEW.sha);
  SELECT RAISE(ABORT, 'APS-O03: owner OK must be recorded by a live L0 or L1 agent')
   WHERE NOT EXISTS (SELECT 1 FROM agents WHERE id = NEW.recorded_by AND layer IN ('L0','L1') AND status <> 'closed');
END;

-- ───────────── guards: defects ─────────────
CREATE TRIGGER trg_defects_ins BEFORE INSERT ON defects BEGIN
  SELECT RAISE(ABORT, 'APS-L02: ledger rows cannot be replaced') WHERE EXISTS (SELECT 1 FROM defects WHERE id = NEW.id);
  SELECT RAISE(ABORT, 'APS-F01: opportunity_count must equal the card acceptance item count')
   WHERE NEW.opportunity_count IS NOT (SELECT json_array_length(acceptance_json) FROM cards WHERE id = NEW.card_id);
  SELECT RAISE(ABORT, 'APS-F02: unknown defect category')
   WHERE NOT EXISTS (SELECT 1 FROM defect_categories WHERE code = NEW.category);
  SELECT RAISE(ABORT, 'APS-F03: defect attempt must be an attempt the card has had')
   WHERE NEW.attempt > (SELECT attempt FROM cards WHERE id = NEW.card_id);
  SELECT RAISE(ABORT, 'APS-F04: recorded_by, review_id and vision_audit_id must exist and belong to the card')
   WHERE NOT EXISTS (SELECT 1 FROM agents WHERE id = NEW.recorded_by)
      OR (NEW.review_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM reviews WHERE id = NEW.review_id AND card_id = NEW.card_id))
      OR (NEW.vision_audit_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM vision_audits WHERE id = NEW.vision_audit_id AND card_id = NEW.card_id));
END;

-- ───────────── guards: feedback (escalation itself is CLI-side) ─────────────
CREATE TRIGGER trg_feedback_ins BEFORE INSERT ON feedback BEGIN
  SELECT RAISE(ABORT, 'APS-L02: ledger rows cannot be replaced') WHERE EXISTS (SELECT 1 FROM feedback WHERE id = NEW.id);
  SELECT RAISE(ABORT, 'APS-K00: new feedback starts unanswered and unescalated, between registered agents')
   WHERE NEW.response IS NOT NULL OR NEW.escalated <> 0
      OR NOT EXISTS (SELECT 1 FROM agents WHERE id = NEW.from_agent)
      OR NOT EXISTS (SELECT 1 FROM agents WHERE id = NEW.to_agent);
END;
CREATE TRIGGER trg_feedback_upd BEFORE UPDATE ON feedback BEGIN
  SELECT RAISE(ABORT, 'APS-K03: feedback from/to/kind/card/body/created_at are immutable')
   WHERE NEW.id IS NOT OLD.id OR NEW.from_agent IS NOT OLD.from_agent OR NEW.to_agent IS NOT OLD.to_agent
      OR NEW.kind IS NOT OLD.kind OR NEW.card_id IS NOT OLD.card_id OR NEW.body IS NOT OLD.body
      OR NEW.created_at IS NOT OLD.created_at;
  SELECT RAISE(ABORT, 'APS-K01: a feedback response is recorded once')
   WHERE OLD.response IS NOT NULL
     AND (NEW.response IS NOT OLD.response OR NEW.response_reason IS NOT OLD.response_reason
          OR NEW.responded_by IS NOT OLD.responded_by OR NEW.responded_at IS NOT OLD.responded_at);
  SELECT RAISE(ABORT, 'APS-K02: partial or reject responses need a reason')
   WHERE NEW.response IN ('partial','reject') AND length(trim(coalesce(NEW.response_reason, ''))) = 0;
  SELECT RAISE(ABORT, 'APS-K04: escalation cannot be cleared')
   WHERE OLD.escalated = 1 AND (NEW.escalated <> 1 OR NEW.escalated_at IS NOT OLD.escalated_at);
END;

-- ───────────── guards: PDCA (Check cannot be skipped) ─────────────
CREATE TRIGGER trg_pdca_ins BEFORE INSERT ON pdca_runs BEGIN
  SELECT RAISE(ABORT, 'APS-L02: ledger rows cannot be replaced')
   WHERE EXISTS (SELECT 1 FROM pdca_runs WHERE id = NEW.id OR scc_run_id = NEW.scc_run_id);
  SELECT RAISE(ABORT, 'APS-Q00: a PDCA run starts in phase plan') WHERE NEW.phase <> 'plan';
END;
CREATE TRIGGER trg_pdca_upd BEFORE UPDATE ON pdca_runs BEGIN
  SELECT RAISE(ABORT, 'APS-Q05: PDCA run identity (scc_run_id, card_id, problem, at) is immutable')
   WHERE NEW.id IS NOT OLD.id OR NEW.scc_run_id IS NOT OLD.scc_run_id OR NEW.card_id IS NOT OLD.card_id
      OR NEW.problem IS NOT OLD.problem OR NEW.at IS NOT OLD.at;
  SELECT RAISE(ABORT, 'APS-Q01: PDCA phase must advance plan->do->check->act->closed (Check cannot be skipped)')
   WHERE NEW.phase IS NOT OLD.phase
     AND (OLD.phase || '>' || NEW.phase) NOT IN ('plan>do','do>check','check>act','act>closed');
  SELECT RAISE(ABORT, 'APS-Q02: entering check requires baseline_json')
   WHERE NEW.phase = 'check' AND OLD.phase = 'do' AND NEW.baseline_json IS NULL;
  SELECT RAISE(ABORT, 'APS-Q03: leaving check requires result_json (re-measured metrics)')
   WHERE NEW.phase = 'act' AND NEW.result_json IS NULL;
  SELECT RAISE(ABORT, 'APS-Q04: closing a PDCA run requires an insight')
   WHERE NEW.phase = 'closed' AND length(trim(coalesce(NEW.insight, ''))) = 0;
  SELECT RAISE(ABORT, 'APS-Q06: baseline is frozen from check on; result is frozen from act on')
   WHERE (OLD.phase IN ('check','act','closed') AND NEW.baseline_json IS NOT OLD.baseline_json)
      OR (OLD.phase IN ('act','closed') AND NEW.result_json IS NOT OLD.result_json);
END;

PRAGMA user_version = 1;
COMMIT;
