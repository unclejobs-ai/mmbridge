-- T1 APS slimming (harness review 2026-10-17: A1, D1). 0001–0005 remain frozen.
-- - cards: A1 fields direction_ref, design_authority, review_budget (1..3, default 2), risk_tier (low|normal|high);
--   frozen with the rest of the spec once work starts (C09), direction_ref shape checked (C11).
-- - review budget: revise→working is refused once the card's review rounds (moves to revise: one per reported sha,
--   review revise or vision fail) reach review_budget, unless the owner's decision for the latest round is recorded
--   in the new append-only budget_overrides table (B01–B04). Reviews themselves are never refused. Overrides are
--   kept out of owner_oks on purpose: v_card_current.owner_ok (D05, ship approval) matches owner_oks by sha only, so
--   an override recorded there would also approve shipping a re-reported identical sha.
-- - rejected→inspecting (manager, note): re-judge a wrongly rejected card that has a reported sha (T06).
-- - review cards are retired for new cards (C12); reviews are recorded on the parent card with `aps review`.
-- - worker_runs.role: 'work' (the assignee's run, N01/N02 as before) or 'verify' (a reviewer lane on the same card,
--   N05); N01 counts live runs per role (verify: per agent).
-- Every recreated trigger copies the latest body (0001 transitions/cards_upd, 0004 cards_ins, 0002 worker_runs_ins)
-- and only adds guards.
BEGIN IMMEDIATE;

-- ───────────── A1 card fields ─────────────
ALTER TABLE cards ADD COLUMN direction_ref TEXT;
ALTER TABLE cards ADD COLUMN design_authority TEXT
  CHECK (design_authority IS NULL OR (length(design_authority) BETWEEN 1 AND 64
                                      AND design_authority NOT GLOB '*[^A-Za-z0-9._:@/-]*'));
ALTER TABLE cards ADD COLUMN review_budget INTEGER NOT NULL DEFAULT 2 CHECK (review_budget BETWEEN 1 AND 3);
ALTER TABLE cards ADD COLUMN risk_tier TEXT NOT NULL DEFAULT 'normal' CHECK (risk_tier IN ('low','normal','high'));

-- ───────────── review budget overrides (owner decision per exhausted round) ─────────────
CREATE TABLE budget_overrides (
  id                   INTEGER PRIMARY KEY,
  card_id              TEXT NOT NULL REFERENCES cards(id),
  attempt              INTEGER NOT NULL CHECK (attempt >= 1),
  revise_transition_id INTEGER NOT NULL REFERENCES transitions(id),
  recorded_by          TEXT NOT NULL REFERENCES agents(id),
  note                 TEXT NOT NULL CHECK (length(trim(note)) > 0),
  at                   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE INDEX idx_budget_overrides_card ON budget_overrides(card_id, revise_transition_id);
CREATE TRIGGER trg_budget_overrides_upd BEFORE UPDATE ON budget_overrides BEGIN SELECT RAISE(ABORT, 'APS-L01: ledger rows are append-only'); END;
CREATE TRIGGER trg_budget_overrides_del BEFORE DELETE ON budget_overrides BEGIN SELECT RAISE(ABORT, 'APS-L01: ledger rows are append-only'); END;
-- An override answers exactly one exhausted round: the card's latest move to revise, on its current attempt.
CREATE TRIGGER trg_budget_overrides_ins BEFORE INSERT ON budget_overrides BEGIN
  SELECT RAISE(ABORT, 'APS-L02: ledger rows cannot be replaced') WHERE EXISTS (SELECT 1 FROM budget_overrides WHERE id = NEW.id);
  SELECT RAISE(ABORT, 'APS-B02: budget override needs state revise, the current attempt and the card''s latest move to revise')
   WHERE NOT EXISTS (SELECT 1 FROM cards WHERE id = NEW.card_id AND state = 'revise' AND attempt = NEW.attempt)
      OR NEW.revise_transition_id IS NOT (SELECT max(id) FROM transitions
                                          WHERE card_id = NEW.card_id AND to_state = 'revise');
  SELECT RAISE(ABORT, 'APS-B03: budget override must be recorded by a live L0 or L1 agent')
   WHERE NOT EXISTS (SELECT 1 FROM agents WHERE id = NEW.recorded_by AND layer IN ('L0','L1') AND status <> 'closed');
  SELECT RAISE(ABORT, 'APS-B04: budget override must be recorded by an agent independent of the card assignee and reporters')
   WHERE EXISTS (SELECT 1 FROM agents me JOIN agents w ON w.name = me.name
                 WHERE me.id = NEW.recorded_by
                   AND (w.id = (SELECT assignee FROM cards WHERE id = NEW.card_id)
                        OR w.id IN (SELECT by_agent FROM reports WHERE card_id = NEW.card_id)));
END;

-- ───────────── worker run role ─────────────
ALTER TABLE worker_runs ADD COLUMN role TEXT NOT NULL DEFAULT 'work' CHECK (role IN ('work','verify'));

DROP VIEW v_run_current;
CREATE VIEW v_run_current AS
SELECT r.id AS run_id, r.card_id, r.attempt, r.agent_id, r.harness, r.kind, r.model,
       r.worktree, r.branch, r.packet_dir, e.status, e.at AS since,
       json_extract(l.detail_json,'$.workspace_id') AS workspace_id,
       json_extract(l.detail_json,'$.tab_id') AS tab_id,
       json_extract(l.detail_json,'$.pane_id') AS pane_id,
       json_extract(l.detail_json,'$.terminal_id') AS terminal_id,
       json_extract(l.detail_json,'$.pid') AS pid,
       json_extract(l.detail_json,'$.session_ref') AS session_ref,
       r.role
FROM worker_runs r
LEFT JOIN run_events e ON e.id = (SELECT max(id) FROM run_events WHERE run_id = r.id)
LEFT JOIN run_events l ON l.id = (SELECT max(id) FROM run_events WHERE run_id = r.id AND status = 'launched');

DROP TRIGGER trg_worker_runs_ins;
CREATE TRIGGER trg_worker_runs_ins BEFORE INSERT ON worker_runs BEGIN
  SELECT RAISE(ABORT, 'APS-L02: ledger rows cannot be replaced')
   WHERE EXISTS (SELECT 1 FROM worker_runs WHERE id = NEW.id);
  SELECT RAISE(ABORT, 'APS-T00: unknown card or agent')
   WHERE NOT EXISTS (SELECT 1 FROM cards WHERE id = NEW.card_id)
      OR NOT EXISTS (SELECT 1 FROM agents WHERE id = NEW.agent_id)
      OR NOT EXISTS (SELECT 1 FROM agents WHERE id = NEW.created_by);
  SELECT RAISE(ABORT, 'APS-T05: a closed agent session cannot perform transitions')
   WHERE EXISTS (SELECT 1 FROM agents WHERE id IN (NEW.agent_id,NEW.created_by) AND status = 'closed');
  -- One live work run per card; one live verify run per card and reviewer session. Work and verify runs coexist.
  SELECT RAISE(ABORT, 'APS-N01: card already has a live run')
   WHERE EXISTS (SELECT 1 FROM v_run_current WHERE card_id = NEW.card_id
                 AND (status IS NULL OR status IN ('intent','launched','reported'))
                 AND role IS NEW.role AND (NEW.role = 'work' OR agent_id = NEW.agent_id));
  SELECT RAISE(ABORT, 'APS-N02: run must match the card''s working attempt and assignee')
   WHERE NEW.role IS NOT 'verify'
     AND NOT EXISTS (SELECT 1 FROM cards WHERE id = NEW.card_id AND state = 'working'
                    AND attempt = NEW.attempt AND assignee = NEW.agent_id);
  SELECT RAISE(ABORT, 'APS-N05: verify run needs a reviewable card (closed_session..merge_wait) on its current attempt and an agent independent of the assignee and reporters')
   WHERE NEW.role = 'verify'
     AND (NOT EXISTS (SELECT 1 FROM cards WHERE id = NEW.card_id AND attempt = NEW.attempt
                        AND state IN ('closed_session','inspecting','accepted','merge_wait'))
          OR EXISTS (SELECT 1 FROM agents me JOIN agents w ON w.name = me.name
                     WHERE me.id = NEW.agent_id
                       AND (w.id = (SELECT assignee FROM cards WHERE id = NEW.card_id)
                            OR w.id IN (SELECT by_agent FROM reports WHERE card_id = NEW.card_id))));
END;

-- ───────────── state machine: rejected → inspecting (manager, note) ─────────────
DROP TRIGGER trg_edges_ins;
INSERT INTO state_edges VALUES ('rejected','inspecting','manager',1);
CREATE TRIGGER trg_edges_ins  BEFORE INSERT ON state_edges BEGIN SELECT RAISE(ABORT, 'APS-L03: reference tables change only via migrations'); END;

-- ───────────── cards insert: 0004 body + C11 direction_ref shape + C12 review cards retired ─────────────
DROP TRIGGER trg_cards_ins;
CREATE TRIGGER trg_cards_ins BEFORE INSERT ON cards BEGIN
  SELECT RAISE(ABORT, 'APS-L02: ledger rows cannot be replaced') WHERE EXISTS (SELECT 1 FROM cards WHERE id = NEW.id);
  SELECT RAISE(ABORT, 'APS-C01: a new card must start in state issued with attempt 0')
   WHERE NEW.state <> 'issued' OR NEW.attempt <> 0;
  SELECT RAISE(ABORT, 'APS-C02: card id must be the next id of its project (<PREFIX>-C-<NNNN>)')
   WHERE NEW.id IS NOT (SELECT printf('%s-C-%04d', prefix, next_seq) FROM projects WHERE id = NEW.project);
  SELECT RAISE(ABORT, 'APS-C12: review cards are retired; record the review on the parent card (aps review <parent>)')
   WHERE NEW.kind = 'review';
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
                              OR coalesce(json_type(j.value, '$.expect'), 'text') <> 'text'
                              OR (json_type(j.value, '$.reviewOnly') IS NOT NULL
                                  AND json_type(j.value, '$.reviewOnly') NOT IN ('true','false')) END)
      OR (SELECT count(DISTINCT json_extract(value, '$.id')) FROM json_each(NEW.acceptance_json))
         <> json_array_length(NEW.acceptance_json);
  -- reviewOnly items are judged by the review, so mech cards cannot be forced to invent a command for them.
  SELECT RAISE(ABORT, 'APS-C04: mech cards need a non-empty command and expect on every acceptance item')
   WHERE NEW.kind = 'mech'
     AND EXISTS (SELECT 1 FROM json_each(NEW.acceptance_json) j
                 WHERE coalesce(json_extract(j.value, '$.reviewOnly'), 0) = 0
                   AND (length(trim(coalesce(json_extract(j.value, '$.command'), ''))) = 0
                     OR length(trim(coalesce(json_extract(j.value, '$.expect'), ''))) = 0));
  SELECT RAISE(ABORT, 'APS-C05: layer_owner must be a live (not closed) agent')
   WHERE NOT EXISTS (SELECT 1 FROM agents WHERE id = NEW.layer_owner AND status <> 'closed');
  SELECT RAISE(ABORT, 'APS-C06: assignee and parent_card must exist')
   WHERE (NEW.assignee IS NOT NULL AND NOT EXISTS (SELECT 1 FROM agents WHERE id = NEW.assignee))
      OR (NEW.parent_card IS NOT NULL AND NOT EXISTS (SELECT 1 FROM cards WHERE id = NEW.parent_card));
  -- <path>@<full sha> pins a design document at a commit; an http(s) URL names an external direction. A URL needs an
  -- authority (text up to the first / ? #) that starts with a letter or digit and holds only host and port characters:
  -- an empty host (https://#, http://?, https:///) is refused, and so is userinfo, which never belongs in the ledger.
  SELECT RAISE(ABORT, 'APS-C11: direction_ref must be <path>@<full 40- or 64-hex sha> or an http(s) URL, without whitespace')
   WHERE NEW.direction_ref IS NOT NULL
     AND (NEW.direction_ref GLOB '*[ ' || char(9, 10, 13) || ']*'
          OR NOT (((NEW.direction_ref GLOB 'https://*' OR NEW.direction_ref GLOB 'http://*')
                   AND (SELECT authority GLOB '[A-Za-z0-9]*' AND authority NOT GLOB '*[^A-Za-z0-9.:-]*'
                        FROM (SELECT substr(rest, 1, instr(replace(replace(rest, '?', '/'), '#', '/') || '/', '/') - 1)
                                     AS authority
                              FROM (SELECT substr(NEW.direction_ref, instr(NEW.direction_ref, '://') + 3) AS rest))))
                  OR (NEW.direction_ref NOT GLOB '*://*'
                      AND ((length(NEW.direction_ref) > 41 AND substr(NEW.direction_ref, -41, 1) = '@'
                            AND substr(NEW.direction_ref, -40) NOT GLOB '*[^0-9a-f]*')
                        OR (length(NEW.direction_ref) > 65 AND substr(NEW.direction_ref, -65, 1) = '@'
                            AND substr(NEW.direction_ref, -64) NOT GLOB '*[^0-9a-f]*')))));
END;

-- ───────────── cards update: 0001 body; C09 freezes the A1 fields; C11/C12 also hold for edits while issued ─────────────
DROP TRIGGER trg_cards_upd;
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
          OR NEW.source_ref IS NOT OLD.source_ref
          OR NEW.direction_ref IS NOT OLD.direction_ref OR NEW.design_authority IS NOT OLD.design_authority
          OR NEW.review_budget IS NOT OLD.review_budget OR NEW.risk_tier IS NOT OLD.risk_tier);
  SELECT RAISE(ABORT, 'APS-C10: assignee can change only while the card is issued or revise')
   WHERE NEW.assignee IS NOT OLD.assignee AND OLD.state NOT IN ('issued','revise');
  SELECT RAISE(ABORT, 'APS-C06: assignee and parent_card must exist')
   WHERE NEW.assignee IS NOT OLD.assignee AND NEW.assignee IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM agents WHERE id = NEW.assignee);
  SELECT RAISE(ABORT, 'APS-C12: review cards are retired; record the review on the parent card (aps review <parent>)')
   WHERE NEW.kind = 'review' AND OLD.kind IS NOT 'review';
  SELECT RAISE(ABORT, 'APS-C11: direction_ref must be <path>@<full 40- or 64-hex sha> or an http(s) URL, without whitespace')
   WHERE NEW.direction_ref IS NOT OLD.direction_ref AND NEW.direction_ref IS NOT NULL
     AND (NEW.direction_ref GLOB '*[ ' || char(9, 10, 13) || ']*'
          OR NOT (((NEW.direction_ref GLOB 'https://*' OR NEW.direction_ref GLOB 'http://*')
                   AND (SELECT authority GLOB '[A-Za-z0-9]*' AND authority NOT GLOB '*[^A-Za-z0-9.:-]*'
                        FROM (SELECT substr(rest, 1, instr(replace(replace(rest, '?', '/'), '#', '/') || '/', '/') - 1)
                                     AS authority
                              FROM (SELECT substr(NEW.direction_ref, instr(NEW.direction_ref, '://') + 3) AS rest))))
                  OR (NEW.direction_ref NOT GLOB '*://*'
                      AND ((length(NEW.direction_ref) > 41 AND substr(NEW.direction_ref, -41, 1) = '@'
                            AND substr(NEW.direction_ref, -40) NOT GLOB '*[^0-9a-f]*')
                        OR (length(NEW.direction_ref) > 65 AND substr(NEW.direction_ref, -65, 1) = '@'
                            AND substr(NEW.direction_ref, -64) NOT GLOB '*[^0-9a-f]*')))));
END;

-- ───────────── transitions: 0001 body + T06 (reopen) + B01 (review budget) ─────────────
DROP TRIGGER trg_transitions_guard;
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
  -- rejected → inspecting re-judges the current attempt's reported sha; without one no review could ever land.
  SELECT RAISE(ABORT, 'APS-T06: reopening a rejected card needs a reported sha on its current attempt')
   WHERE NEW.from_state = 'rejected' AND NEW.to_state = 'inspecting'
     AND (SELECT sha FROM v_card_current WHERE card_id = NEW.card_id) IS NULL;
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
  -- A review round is one move to revise (one per attempt's reported sha, from a revise review or a failed vision
  -- audit). Reviews stay recordable past the budget; only the next rework waits for the owner's decision, which is a
  -- budget_overrides row for the latest move to revise (B02 pins it to that round).
  SELECT RAISE(ABORT, 'APS-B01: review budget exhausted; owner decision required (aps budget-override in revise, then rework)')
   WHERE NEW.from_state = 'revise' AND NEW.to_state = 'working'
     AND (SELECT count(*) FROM transitions WHERE card_id = NEW.card_id AND to_state = 'revise')
         >= coalesce((SELECT review_budget FROM cards WHERE id = NEW.card_id), 0)
     AND NOT EXISTS (SELECT 1 FROM budget_overrides b
                     WHERE b.card_id = NEW.card_id
                       AND b.revise_transition_id = (SELECT max(id) FROM transitions
                                                     WHERE card_id = NEW.card_id AND to_state = 'revise'));
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

PRAGMA user_version = 6;
COMMIT;
