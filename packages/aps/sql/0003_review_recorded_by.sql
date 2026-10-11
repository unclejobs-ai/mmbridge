-- Proxy-recorded reviews. 0001 and 0002 remain frozen.
BEGIN IMMEDIATE;

ALTER TABLE reviews ADD COLUMN recorded_by TEXT REFERENCES agents(id);

DROP TRIGGER trg_reviews_ins;
CREATE TRIGGER trg_reviews_ins BEFORE INSERT ON reviews BEGIN
  SELECT RAISE(ABORT, 'APS-L02: ledger rows cannot be replaced') WHERE EXISTS (SELECT 1 FROM reviews WHERE id = NEW.id);
  SELECT RAISE(ABORT, 'APS-V10: reviewer must be a live agent and layer must equal the reviewer layer')
   WHERE (NEW.recorded_by IS NULL
          AND NOT EXISTS (SELECT 1 FROM agents WHERE id = NEW.reviewer AND layer = NEW.layer AND status <> 'closed'))
      OR (NEW.recorded_by IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM agents WHERE id = NEW.reviewer AND layer = NEW.layer));
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
  SELECT RAISE(ABORT, 'APS-V16: proxy review must be recorded by a live L0 or L1 agent other than the reviewer, assignee and reporters')
   WHERE NEW.recorded_by IS NOT NULL
     AND (NOT EXISTS (SELECT 1 FROM agents WHERE id = NEW.recorded_by AND layer IN ('L0','L1') AND status <> 'closed')
          OR EXISTS (SELECT 1 FROM agents me JOIN agents w ON w.name = me.name
                     WHERE me.id = NEW.recorded_by
                       AND (w.id = NEW.reviewer
                            OR w.id = (SELECT assignee FROM cards WHERE id = NEW.card_id)
                            OR w.id IN (SELECT by_agent FROM reports WHERE card_id = NEW.card_id))));
END;

PRAGMA user_version = 3;
COMMIT;
