-- Review-only acceptance items (issue #15, P05/R02/R03 scope).
-- An acceptance item may carry "reviewOnly": true — its satisfaction is judged by the review,
-- not by report evidence. 0001 is frozen; this migration widens C03/C04 and R02/R03 in place.
-- Guard messages are unchanged (docs/aps/DESIGN.md §5.1 rows keep their exact text).
BEGIN IMMEDIATE;

DROP TRIGGER trg_cards_ins;
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
END;

DROP TRIGGER trg_reports_ins;
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
  -- Coverage counts only items the report must prove; reviewOnly items are the review's to judge,
  -- so a card whose every AC is reviewOnly may report an empty evidence array.
  SELECT RAISE(ABORT, 'APS-R02: evidence has fewer items than the card has acceptance criteria')
   WHERE NEW.status IN ('DONE','DONE_WITH_CONCERNS')
     AND json_array_length(NEW.evidence_json)
         < (SELECT count(*) FROM cards c, json_each(c.acceptance_json) a
            WHERE c.id = NEW.card_id AND coalesce(json_extract(a.value, '$.reviewOnly'), 0) = 0);
  SELECT RAISE(ABORT, 'APS-R03: evidence does not cover every acceptance id')
   WHERE NEW.status IN ('DONE','DONE_WITH_CONCERNS')
     AND EXISTS (SELECT 1 FROM cards c, json_each(c.acceptance_json) a
                 WHERE c.id = NEW.card_id
                   AND coalesce(json_extract(a.value, '$.reviewOnly'), 0) = 0
                   AND NOT EXISTS (SELECT 1 FROM json_each(NEW.evidence_json) e
                                   WHERE json_extract(e.value, '$.ac') = json_extract(a.value, '$.id')));
  SELECT RAISE(ABORT, 'APS-P07: status DONE requires every evidence item ok=true; use DONE_WITH_CONCERNS with risks')
   WHERE NEW.status = 'DONE'
     AND EXISTS (SELECT 1 FROM json_each(NEW.evidence_json) e WHERE json_type(e.value, '$.ok') = 'false');
  SELECT RAISE(ABORT, 'APS-P08: DONE_WITH_CONCERNS requires non-empty risks')
   WHERE NEW.status = 'DONE_WITH_CONCERNS' AND length(trim(NEW.risks)) = 0;
END;

PRAGMA user_version = 4;
COMMIT;
