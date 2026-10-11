// One executed rejection per card-lifecycle guard. Each case builds the state where every earlier guard passes.
import test from 'node:test';
import {
  AC2,
  CARD,
  EVIDENCE2,
  ITEM,
  SHA,
  SHA2,
  SHOTS4,
  closeAgent,
  merge,
  move,
  rejects,
  report,
  review,
  seed,
  toInspecting,
  toMergeWait,
} from './fixture.ts';

const tr = (from: string | null, to: string, by: string, note = '', card = CARD) =>
  `INSERT INTO transitions(card_id,from_state,to_state,by_agent,note) VALUES('${card}',${from === null ? 'NULL' : `'${from}'`},'${to}','${by}','${note}')`;
const newCard = (fields: {
  id?: string;
  kind?: string;
  size?: string;
  acceptance?: string;
  owner?: string;
  assignee?: string;
  state?: string;
}) =>
  `INSERT INTO cards(id,project,title,kind,size,scope,acceptance_json,forbidden,needs_owner,needs_vision,layer_owner,assignee${fields.state ? ',state' : ''})
   VALUES('${fields.id ?? 'SS-C-0002'}','ss','c2','${fields.kind ?? 'mech'}','${fields.size ?? 'S'}','scope','${fields.acceptance ?? AC2}','none',0,0,
          '${fields.owner ?? 'mgr'}',${fields.assignee === undefined ? "'w2'" : fields.assignee}${fields.state ? `,'${fields.state}'` : ''})`;
const reportSql = (o: {
  attempt?: number;
  by?: string;
  files?: string;
  evidence?: string;
  status?: string;
  risks?: string;
}) =>
  `INSERT INTO reports(card_id,attempt,by_agent,sha,branch,files_json,evidence_json,status,risks)
   VALUES('${CARD}',${o.attempt ?? 1},'${o.by ?? 'w1'}','${SHA}','feat/x','${o.files ?? '["a.ts"]'}','${o.evidence ?? EVIDENCE2}',
          '${o.status ?? 'DONE'}','${o.risks ?? ''}')`;
const reviewSql = (o: { reviewer?: string; layer?: string; sha?: string; verdict?: string; items?: string }) =>
  `INSERT INTO reviews(card_id,attempt,reviewer,layer,sha,verdict,items_json)
   VALUES('${CARD}',1,'${o.reviewer ?? 'rev'}','${o.layer ?? 'L1'}','${o.sha ?? SHA}','${o.verdict ?? 'accept'}','${o.items ?? '[]'}')`;
const visionSql = (o: { auditor?: string; sha?: string; shots?: string; verdict?: string; items?: string }) =>
  `INSERT INTO vision_audits(card_id,attempt,sha,auditor,screenshots_json,verdict,items_json)
   VALUES('${CARD}',1,'${o.sha ?? SHA}','${o.auditor ?? 'viz'}','${o.shots ?? SHOTS4}','${o.verdict ?? 'pass'}','${o.items ?? '[]'}')`;
const ownerOkSql = (sha = SHA, by = 'l0') =>
  `INSERT INTO owner_oks(card_id,sha,recorded_by,quote) VALUES('${CARD}','${sha}','${by}','OK')`;

test('cards: C01–C10', () => {
  const db = seed();
  rejects(db, 'C01', newCard({ state: 'done' }));
  rejects(db, 'C02', newCard({ id: 'SS-C-0009' }));
  rejects(db, 'C03', newCard({ acceptance: '[]' }));
  rejects(db, 'C04', newCard({ acceptance: '[{"id":"AC1","text":"no command"}]' }));
  rejects(db, 'C06', newCard({ assignee: "'ghost'" }));
  rejects(db, 'C07', `UPDATE cards SET created_at='2000-01-01' WHERE id='${CARD}'`);
  rejects(db, 'C08', `UPDATE cards SET state='working', attempt=1 WHERE id='${CARD}'`);
  closeAgent(db, 'w1b');
  rejects(db, 'C05', newCard({ owner: 'w1b' }));
  move(db, 'issued', 'working', 'w1');
  rejects(db, 'C09', `UPDATE cards SET title='moved goalposts' WHERE id='${CARD}'`);
  rejects(db, 'C10', `UPDATE cards SET assignee='w2' WHERE id='${CARD}'`);
});

test('transitions: T00–T05', () => {
  const db = seed();
  rejects(db, 'T00', tr('issued', 'working', 'w1', '', 'SS-C-0404'));
  closeAgent(db, 'w2');
  rejects(db, 'T05', tr('issued', 'working', 'w2'));
  rejects(db, 'T01', tr('working', 'reported', 'w1'));
  rejects(db, 'T02', tr('issued', 'done', 'mgr'));
  rejects(db, 'T03', tr('issued', 'rejected', 'mgr'));
  rejects(db, 'T04', tr('issued', 'rejected', 'w1b', 'same worker, other session'));
});

test('working: W01–W03', () => {
  const db = seed({ size: 'L' });
  rejects(db, 'W02', tr('issued', 'working', 'w1'));
  db.exec(newCard({ assignee: 'NULL' }));
  rejects(db, 'W01', tr('issued', 'working', 'mgr', '', 'SS-C-0002'));

  const loop = seed();
  const workers = ['w1', 'w2', 'w3', 'w4'];
  loop.exec(
    `INSERT INTO agents(id,name,layer,model,vendor) VALUES('w3','glm','L3','glm-5.3','zhipu'),('w4','ds','L3','ds-4.1','deepseek')`,
  );
  for (const worker of workers.slice(0, 3)) {
    if (worker !== 'w1') loop.exec(`UPDATE cards SET assignee='${worker}' WHERE id='${CARD}'`);
    toInspecting(loop, worker);
    const attempt = (loop.prepare('SELECT attempt FROM cards').get() as { attempt: number }).attempt;
    loop.exec(`INSERT INTO reviews(card_id,attempt,reviewer,layer,sha,verdict,items_json)
               VALUES('${CARD}',${attempt},'rev','L1','${SHA}','revise','${ITEM}')`);
    move(loop, 'inspecting', 'revise', 'mgr');
  }
  loop.exec(`UPDATE cards SET assignee='w4' WHERE id='${CARD}'`);
  rejects(loop, 'W03', tr('revise', 'working', 'w4'));
});

test('reports: R01–R03, P01–P08', () => {
  const db = seed();
  rejects(db, 'P01', reportSql({}));
  move(db, 'issued', 'working', 'w1');
  rejects(db, 'R01', tr('working', 'reported', 'w1'));
  rejects(db, 'P02', reportSql({ by: 'w2' }));
  rejects(db, 'P03', reportSql({ attempt: 2 }));
  rejects(db, 'P04', reportSql({ files: '{}' }));
  rejects(db, 'P05', reportSql({ evidence: '[{"ac":"AC1","command":"c","output":"o"}]' }));
  rejects(db, 'P06', reportSql({ evidence: '[{"ac":"AC9","command":"c","output":"o","ok":true}]' }));
  rejects(db, 'R02', reportSql({ evidence: '[{"ac":"AC1","command":"c","output":"o","ok":true}]' }));
  rejects(
    db,
    'R03',
    reportSql({
      evidence: '[{"ac":"AC1","command":"c","output":"o","ok":true},{"ac":"AC1","command":"c","output":"o","ok":true}]',
    }),
  );
  const oneFailed = EVIDENCE2.replace('"ok":true}]', '"ok":false}]');
  rejects(db, 'P07', reportSql({ evidence: oneFailed }));
  rejects(db, 'P08', reportSql({ evidence: oneFailed, status: 'DONE_WITH_CONCERNS' }));
});

test('session close: S01', () => {
  const db = seed();
  move(db, 'issued', 'working', 'w1');
  report(db);
  move(db, 'working', 'reported', 'w1');
  rejects(db, 'S01', tr('reported', 'closed_session', 'mgr'));
});

test('verdict transitions: V01–V03', () => {
  const db = seed();
  toInspecting(db);
  rejects(db, 'V01', tr('inspecting', 'accepted', 'mgr'));
  rejects(db, 'V02', tr('inspecting', 'revise', 'mgr'));
  review(db, 'accept');
  rejects(db, 'V03', tr('inspecting', 'rejected', 'mgr'));
});

test('reviews: V10–V15', () => {
  const db = seed();
  move(db, 'issued', 'working', 'w1');
  report(db);
  move(db, 'working', 'reported', 'w1');
  rejects(db, 'V10', reviewSql({ layer: 'L2' }));
  rejects(db, 'V11', reviewSql({}));
  closeAgent(db, 'w1');
  move(db, 'reported', 'closed_session', 'mgr');
  move(db, 'closed_session', 'inspecting', 'mgr');
  rejects(db, 'V12', reviewSql({ sha: SHA2 }));
  rejects(db, 'V13', reviewSql({ reviewer: 'w1b', layer: 'L3' }));
  rejects(db, 'V14', reviewSql({ items: '[{"severity":"fatal","category":"correctness","text":"x"}]' }));
  rejects(db, 'V15', reviewSql({ verdict: 'revise' }));
});

test('vision audits: X01–X08', () => {
  const db = seed({ needsVision: 1 });
  move(db, 'issued', 'working', 'w1');
  report(db);
  closeAgent(db, 'w2');
  rejects(db, 'X01', visionSql({ auditor: 'w2' }));
  rejects(db, 'X02', visionSql({}));
  move(db, 'working', 'reported', 'w1');
  closeAgent(db, 'w1');
  move(db, 'reported', 'closed_session', 'mgr');
  move(db, 'closed_session', 'inspecting', 'mgr');
  rejects(db, 'X03', visionSql({ sha: SHA2 }));
  review(db, 'accept');
  rejects(db, 'X04', visionSql({ auditor: 'rev' }));
  rejects(db, 'X05', visionSql({ shots: '[]' }));
  rejects(db, 'X06', visionSql({ shots: JSON.stringify(JSON.parse(SHOTS4).slice(0, 2)) }));
  rejects(db, 'X07', visionSql({ verdict: 'fail', items: '[{"severity":"major","category":"vibes","text":"x"}]' }));
  rejects(db, 'X08', visionSql({ verdict: 'fail' }));
});

test('merges and owner OKs: M01–M03, O01–O04', () => {
  const db = seed({ needsOwner: 1 });
  move(db, 'issued', 'working', 'w1');
  rejects(db, 'O01', ownerOkSql());
  report(db);
  move(db, 'working', 'reported', 'w1');
  closeAgent(db, 'w1');
  move(db, 'reported', 'closed_session', 'mgr');
  move(db, 'closed_session', 'inspecting', 'mgr');
  rejects(
    db,
    'M01',
    `INSERT INTO merges(card_id,sha,merged_sha,target,verified_by,verify_command)
                      VALUES('${CARD}','${SHA}','${'c'.repeat(40)}','origin/main','mgr','git merge-base')`,
  );
  rejects(db, 'O02', ownerOkSql(SHA2));
  rejects(db, 'O03', ownerOkSql(SHA, 'mgr'));
  db.exec("INSERT INTO agents(id,name,layer,model,vendor) VALUES('w1-owner','devin','L1','local','local')");
  rejects(db, 'O04', ownerOkSql(SHA, 'w1-owner'));
  review(db, 'accept');
  move(db, 'inspecting', 'accepted', 'mgr');
  rejects(
    db,
    'M02',
    `INSERT INTO merges(card_id,sha,merged_sha,target,verified_by,verify_command)
                      VALUES('${CARD}','${SHA2}','${'c'.repeat(40)}','origin/main','mgr','git merge-base')`,
  );
  rejects(
    db,
    'M03',
    `INSERT INTO merges(card_id,sha,merged_sha,target,verified_by,verify_command)
                      VALUES('${CARD}','${SHA}','${'c'.repeat(40)}','origin/main','w1b','git merge-base')`,
  );
});

test('done: D01, D02, D04, D05', () => {
  const plain = seed();
  toMergeWait(plain);
  rejects(plain, 'D02', tr('merge_wait', 'done', 'mgr'));
  merge(plain);
  review(plain, 'revise');
  rejects(plain, 'D01', tr('merge_wait', 'done', 'mgr'));

  const visual = seed({ needsVision: 1 });
  toMergeWait(visual);
  merge(visual);
  rejects(visual, 'D04', tr('merge_wait', 'done', 'mgr'));

  const owned = seed({ needsOwner: 1 });
  toMergeWait(owned);
  merge(owned);
  rejects(owned, 'D05', tr('merge_wait', 'done', 'mgr'));
});
