import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { openApsDb } from '@mmbridge/aps';
import { SessionStore } from '@mmbridge/session-store';

const bin = resolve(import.meta.dirname, '../dist/bin/mmbridge.js');
const SHA = 'a'.repeat(40);
function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'aps-cli-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const dbPath = join(home, 'aps.db');
  const env = {
    ...process.env,
    HOME: home,
    APS_DB: dbPath,
    MMBRIDGE_APS_DB: '',
    APS_AGENT: 'bootstrap',
    NODE_NO_WARNINGS: '1',
  };
  function run(args: string[], status = 0, json = true) {
    const result = spawnSync(process.execPath, [bin, 'aps', ...args, ...(json ? ['--json'] : [])], {
      cwd: home,
      env,
      encoding: 'utf8',
    });
    assert.equal(result.status, status, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return { ...result, value: json && result.stdout.trim() ? JSON.parse(result.stdout) : null };
  }
  run(['init']);
  run(['project', 'add', 'test', '--prefix', 'TS', '--name', 'Test']);
  const manager = run(['agent', 'new', '--name', 'manager', '--layer', 'L1', '--model', 'sol', '--vendor', 'test'])
    .value.id;
  const worker = run(['agent', 'new', '--name', 'worker', '--layer', 'L2', '--model', 'sol', '--vendor', 'test']).value
    .id;
  const vision = run(['agent', 'new', '--name', 'vision', '--layer', 'L2', '--model', 'opus', '--vendor', 'test']).value
    .id;
  env.APS_AGENT = manager;
  function file(name: string, value: unknown) {
    const path = join(home, name);
    writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
    return path;
  }
  const acceptance = file('acceptance.json', [{ id: 'AC1', text: 'Works', command: 'echo yes', expect: 'yes' }]);
  const evidence = file('evidence.json', [{ ac: 'AC1', command: 'echo yes', output: 'yes', ok: true }]);
  function card(extra: string[] = []) {
    return run([
      'card',
      'new',
      '--project',
      'test',
      '--title',
      'Example',
      '--kind',
      'mech',
      '--size',
      'S',
      '--scope',
      'CLI',
      '--acceptance',
      acceptance,
      '--forbidden',
      'paid calls',
      '--owner',
      manager,
      '--assignee',
      worker,
      ...extra,
    ]).value[0].card;
  }
  function working(extra: string[] = []) {
    const id = card(extra);
    run(['start', id, '--assignee', worker]);
    return id;
  }
  function report(id: string, extra: string[] = []) {
    return run([
      'report',
      id,
      '--by',
      worker,
      '--sha',
      SHA,
      '--branch',
      'feature',
      '--files',
      '[]',
      '--evidence',
      evidence,
      '--status',
      'DONE',
      ...extra,
    ]);
  }
  function reported(extra: string[] = []) {
    const id = working(extra);
    report(id);
    return id;
  }
  function inspecting(extra: string[] = []) {
    const id = reported(extra);
    run(['close-session', worker, '--note', 'pane ended']);
    return id;
  }
  function accepted(extra: string[] = []) {
    const id = inspecting(extra);
    run(['review', id, '--verdict', 'accept']);
    return id;
  }
  return {
    home,
    dbPath,
    env,
    run,
    manager,
    worker,
    vision,
    file,
    acceptance,
    evidence,
    card,
    working,
    report,
    reported,
    inspecting,
    accepted,
  };
}

function paneFixture(t: TestContext, response: unknown, exit = 0) {
  const f = fixture(t);
  const binDir = join(f.home, 'bin');
  mkdirSync(binDir);
  writeFileSync(
    join(binDir, 'herdr'),
    `#!/bin/sh
[ "$#" -eq 3 ] && [ "$1" = pane ] && [ "$2" = get ] && [ "$3" = w12:p3 ] || exit 99
printf '%s\\n' '${JSON.stringify(response)}'${exit === 0 ? '' : ' >&2'}
exit ${exit}
`,
    { mode: 0o755 },
  );
  f.env.PATH = `${binDir}:${f.env.PATH}`;
  const worker = f.run([
    'agent',
    'new',
    '--name',
    'pane',
    '--layer',
    'L2',
    '--model',
    'test',
    '--vendor',
    'test',
    '--herdr-pane',
    'w12:p3',
  ]).value.id;
  const id = f.card(['--assignee', worker]);
  f.run(['start', id, '--assignee', worker]);
  f.report(id, ['--by', worker]);
  function snapshot() {
    const db = openApsDb(f.dbPath);
    try {
      return {
        agent: db.prepare('SELECT * FROM agents WHERE id=?').get(worker),
        card: db.prepare('SELECT * FROM cards WHERE id=?').get(id),
        transitions: db.prepare('SELECT * FROM transitions WHERE card_id=? ORDER BY id').all(id),
      };
    } finally {
      db.close();
    }
  }
  return { ...f, worker, id, snapshot };
}

test('H01 refuses when pane has a detected agent', (t) => {
  const f = paneFixture(t, {
    result: {
      type: 'pane_info',
      pane: {
        pane_id: 'w12:p3',
        terminal_id: 'terminal-1',
        tab_id: 'w12:t1',
        workspace_id: 'w12',
        agent: 'omp',
        agent_status: 'done',
      },
    },
  });
  const before = f.snapshot();
  assert.match(
    f.run(['close-session', f.worker, '--note', 'ended'], 3).stderr,
    /APS-H01: herdr pane w12:p3 is still open/,
  );
  assert.deepEqual(f.snapshot(), before);
});

test('H01 refuses when pane is a bare shell', (t) => {
  const f = paneFixture(t, {
    result: {
      type: 'pane_info',
      pane: { pane_id: 'w12:p3', terminal_id: 'terminal-1', tab_id: 'w12:t1', workspace_id: 'w12' },
    },
  });
  const before = f.snapshot();
  assert.match(
    f.run(['close-session', f.worker, '--note', 'ended'], 3).stderr,
    /APS-H01: herdr pane w12:p3 is still open/,
  );
  assert.deepEqual(f.snapshot(), before);
  assert.match(
    f.run(['close-session', f.worker, '--note', 'abandoned', '--abandon'], 3).stderr,
    /APS-H01: herdr pane w12:p3 is still open/,
  );
  assert.deepEqual(f.snapshot(), before);
});

test('H01 passes when pane_not_found', (t) => {
  const f = paneFixture(t, { error: { code: 'pane_not_found' } }, 1);
  const closed = f.run(['close-session', f.worker, '--note', 'pane ended']).value;
  assert.equal(closed[0].to, 'closed_session');
  const after = f.snapshot();
  assert.equal(after.agent?.status, 'closed');
  assert.equal(after.agent?.closed_by, f.manager);
  assert.equal(after.agent?.close_note, 'pane ended');
  assert.equal(after.card?.state, 'closed_session');
});

test('H01 fails closed on herdr server_not_running on stderr', (t) => {
  const f = paneFixture(t, { error: { code: 'server_not_running' } }, 1);
  const before = f.snapshot();
  assert.match(
    f.run(['close-session', f.worker, '--note', 'ended'], 1).stderr,
    /cannot confirm pane ended: herdr pane get failed/,
  );
  assert.deepEqual(f.snapshot(), before);
});

test('aps init/project add/agent new: persisted records, generated IDs, text output', (t) => {
  const f = fixture(t);
  assert.equal(f.run(['init']).value.user_version, 2);
  const result = f.run(
    ['agent', 'new', '--name', 'New Worker', '--layer', 'L3', '--model', 'test', '--vendor', 'test'],
    0,
    false,
  );
  assert.match(result.stdout, /^new-worker-\d{14}/);
  f.run(['agent', 'new', '--name', 'bad', '--layer', 'L9', '--model', 'test', '--vendor', 'test'], 2);
  assert.match(f.run(['project', 'add', 'other', '--prefix', 'TS', '--name', 'duplicate'], 3).stderr, /APS-L02:/);
});
test('agent list: default excludes closed; status, project and layer filter', (t) => {
  const f = fixture(t);
  const listed = f.run([
    'agent',
    'new',
    '--name',
    'listed',
    '--layer',
    'L3',
    '--model',
    'flash',
    '--vendor',
    'test',
    '--project',
    'test',
    '--herdr-pane',
    'w9:p2',
  ]).value.id as string;
  const idler = f.run(['agent', 'new', '--name', 'idler', '--layer', 'L0', '--model', 'opus', '--vendor', 'test']).value
    .id as string;
  const gone = f.run([
    'agent',
    'new',
    '--name',
    'gone',
    '--layer',
    'L2',
    '--model',
    'haiku',
    '--vendor',
    'test',
    '--project',
    'test',
  ]).value.id as string;
  f.run(['close-session', gone, '--note', 'pane ended']);
  const db = openApsDb(f.dbPath);
  try {
    db.prepare("UPDATE agents SET status='idle' WHERE id=?").run(idler);
  } finally {
    db.close();
  }
  const ids = (rows: { id: string }[]) => rows.map((row) => row.id);
  const open = f.run(['agent', 'list']).value as {
    id: string;
    layer: string;
    project: string | null;
    status: string;
    started_at: string;
  }[];
  assert.equal(ids(open).includes(gone), false);
  assert.ok(ids(open).includes(listed));
  assert.ok(ids(open).includes(idler));
  assert.ok(open.every((row) => row.status !== 'closed'));
  const cmp = (a: string | null, b: string | null) => (a === b ? 0 : a === null ? -1 : b === null ? 1 : a < b ? -1 : 1);
  for (let i = 1; i < open.length; i++) {
    const prev = open[i - 1];
    const row = open[i];
    const order =
      cmp(prev.layer, row.layer) ||
      cmp(prev.project, row.project) ||
      cmp(prev.started_at, row.started_at) ||
      cmp(prev.id, row.id);
    assert.ok(order <= 0, `${prev.id} before ${row.id}`);
  }
  const closed = f.run(['agent', 'list', '--status', 'closed']).value as {
    id: string;
    name: string;
    status: string;
    close_note: string;
  }[];
  assert.deepEqual(ids(closed), [gone]);
  assert.equal(closed[0].status, 'closed');
  assert.equal(closed[0].close_note, 'pane ended');
  for (const key of [
    'id',
    'name',
    'layer',
    'model',
    'vendor',
    'project',
    'herdr_pane',
    'status',
    'started_at',
    'closed_at',
    'close_note',
  ])
    assert.equal(key in closed[0], true, key);
  assert.deepEqual(ids(f.run(['agent', 'list', '--project', 'test']).value), [listed]);
  assert.deepEqual(ids(f.run(['agent', 'list', '--layer', 'L0']).value), [idler]);
  assert.deepEqual(ids(f.run(['agent', 'list', '--status', 'all', '--project', 'test']).value), [gone, listed]);
  const active = ids(f.run(['agent', 'list', '--status', 'active']).value);
  assert.equal(active.includes(idler), false);
  assert.equal(active.includes(gone), false);
  assert.ok(active.includes(listed));
  assert.equal(
    f.run(['agent', 'list', '--project', 'test'], 0, false).stdout.trim(),
    `${listed} L3 active flash test w9:p2`,
  );
  assert.equal(f.run(['agent', 'list', '--status', 'idle'], 0, false).stdout.trim(), `${idler} L0 idle opus - -`);
  assert.match(f.run(['agent', 'list', '--status', 'nope'], 2).stderr, /--status must be/);
  f.run(['agent', 'list', '--layer', 'L9'], 2);
});
test('card new/show/list/as-prompt: full acceptance and when-done payload', (t) => {
  const f = fixture(t);
  const id = f.card();
  assert.equal(id, 'TS-C-0001');
  assert.equal(f.run(['card', 'show', id]).value.current.state, 'issued');
  assert.equal(f.run(['card', 'list', '--project', 'test', '--state', 'issued']).value.length, 1);
  const prompt = f.run(['card', 'show', id, '--as-prompt'], 0, false).stdout;
  for (const text of [
    'Goal',
    'Scope',
    'Details',
    'Acceptance',
    'Forbidden',
    'When done',
    'AC1',
    'echo yes',
    '"ok": false',
    'COMPLETION-REPORT',
  ])
    assert.ok(prompt.includes(text), text);
  f.run(['card', 'show', id, '--as-prompt'], 2);
  const invalid = f.file('bad-ac.json', []);
  assert.match(
    f.run(
      [
        'card',
        'new',
        '--project',
        'test',
        '--title',
        'Bad',
        '--kind',
        'mech',
        '--size',
        'S',
        '--scope',
        'scope',
        '--acceptance',
        invalid,
        '--forbidden',
        'none',
        '--owner',
        f.manager,
      ],
      3,
    ).stderr,
    /APS-C03:/,
  );
});
test('start returns transition text and rejects size L assigned to L3 atomically', (t) => {
  const f = fixture(t);
  const id = f.card();
  assert.match(f.run(['start', id, '--assignee', f.worker], 0, false).stdout, /issued→working.*attempt 1/);
  const l3 = f.run(['agent', 'new', '--name', 'junior', '--layer', 'L3', '--model', 'test', '--vendor', 'test']).value
    .id;
  const large = f.card(['--size', 'L']);
  assert.match(f.run(['start', large, '--assignee', l3], 3).stderr, /APS-W02:/);
  assert.equal(f.run(['card', 'show', large]).value.assignee, f.worker);
});
test('report success, BLOCKED insert, input exit 2 and evidence rejection exit 3', (t) => {
  const f = fixture(t);
  const id = f.working();
  assert.ok(f.report(id, ['--status', 'BLOCKED']).value.id);
  const empty = f.file('empty.json', []);
  assert.match(
    f.run(
      [
        'report',
        id,
        '--by',
        f.worker,
        '--sha',
        SHA,
        '--branch',
        'branch',
        '--files',
        '[]',
        '--evidence',
        empty,
        '--status',
        'DONE',
      ],
      3,
    ).stderr,
    /APS-R02:/,
  );
  assert.equal(f.run(['card', 'show', id]).value.state, 'working');
  f.run(['report', id, '--sha', 'bad'], 2);
  assert.equal(f.report(id).value[0].to, 'reported');
});
test('close-session closes reported cards; refuses working then abandons with note', (t) => {
  const f = fixture(t);
  const id = f.working();
  f.run(['close-session', f.worker, '--note', 'done'], 2);
  const closed = f.run(['close-session', f.worker, '--note', 'abandoned', '--abandon']).value;
  assert.equal(closed[0].to, 'issued');
  assert.equal(f.run(['card', 'show', id]).value.state, 'issued');
  assert.match(f.run(['close-session', f.worker, '--note', 'again'], 3).stderr, /APS-A02:/);
});
test('review accept advances to merge_wait and persists independent reviewer', (t) => {
  const f = fixture(t);
  const id = f.inspecting();
  const transitions = f.run(['review', id, '--verdict', 'accept']).value;
  assert.deepEqual(
    transitions.map((row: Record<string, unknown>) => row.to),
    ['inspecting', 'accepted', 'merge_wait'],
  );
  assert.equal(f.run(['card', 'show', id]).value.current.latest_review, 'accept');
});
test('review --partial records the first accept without advancing', (t) => {
  const f = fixture(t);
  const id = f.inspecting();
  const partial = f.run(['review', id, '--verdict', 'accept', '--partial']).value;
  assert.deepEqual(
    partial.map((row: Record<string, unknown>) => row.to),
    ['inspecting'],
  );
  assert.equal(f.run(['card', 'show', id]).value.state, 'inspecting');
  const again = f.run(['review', id, '--verdict', 'accept', '--partial', '--by', f.vision]).value;
  assert.deepEqual(again, []);
  assert.equal(f.run(['card', 'show', id]).value.state, 'inspecting');
  const advanced = f.run(['review', id, '--verdict', 'accept', '--by', f.manager]).value;
  assert.deepEqual(
    advanced.map((row: Record<string, unknown>) => row.to),
    ['accepted', 'merge_wait'],
  );
  assert.equal(f.run(['card', 'show', id]).value.state, 'merge_wait');
});
test('review --partial refuses revise and leaves the card unmoved', (t) => {
  const f = fixture(t);
  const id = f.inspecting();
  const items = f.file('items.json', [{ severity: 'major', category: 'test', text: 'Missing test' }]);
  assert.match(
    f.run(['review', id, '--verdict', 'revise', '--partial', '--items', items], 2).stderr,
    /partial requires verdict accept/,
  );
  assert.equal(f.run(['card', 'show', id]).value.state, 'closed_session');
});
test('review revise/reject stores findings and rework prompt', (t) => {
  const f = fixture(t);
  const id = f.inspecting();
  const items = f.file('items.json', [{ severity: 'major', category: 'test', text: 'Missing test' }]);
  f.run(['review', id, '--verdict', 'revise', '--items', items]);
  assert.match(f.run(['card', 'show', id, '--as-prompt'], 0, false).stdout, /REWORK 1 of 3[\s\S]*Missing test/);
  f.run(['reject', id, '--note', 'redesign']);
  assert.equal(f.run(['card', 'show', id]).value.state, 'rejected');
});
test('review invalid finding rejects and rolls back inspecting transition', (t) => {
  const f = fixture(t);
  const id = f.inspecting();
  assert.match(f.run(['review', id, '--verdict', 'revise'], 3).stderr, /APS-V15:/);
  assert.equal(f.run(['card', 'show', id]).value.state, 'closed_session');
});
test('review imports lowercase local session, gate, findings, run and handoff', async (t) => {
  const f = fixture(t);
  const id = f.inspecting();
  const store = new SessionStore(join(f.home, '.mmbridge'));
  const session = await store.save({
    tool: 'codex',
    mode: 'review',
    projectDir: f.home,
    workspace: f.home,
    head: { sha: SHA, branch: 'feature' },
    runId: 'run-one',
    handoffId: 'handoff-one',
    handoffPath: join(f.home, 'handoff.md'),
    findings: [
      { severity: 'WARNING', file: 'x.ts', line: 3, message: 'Keep' },
      { severity: 'INFO', file: 'y.ts', line: null, message: 'Dismiss' },
    ],
    findingDecisions: [{ key: 'INFO:y.ts::Dismiss', status: 'dismissed', updatedAt: new Date().toISOString() }],
  });
  f.run(['review', id, '--verdict', 'accept', '--from-session', session.id.toUpperCase()]);
  const db = openApsDb(f.dbPath);
  t.after(() => db.close());
  const review = db.prepare('SELECT * FROM reviews').get();
  assert.ok(review);
  assert.equal(review.mmbridge_session_id, session.id);
  assert.equal(JSON.parse(String(review.items_json)).length, 1);
  assert.equal(JSON.parse(String(review.items_json))[0].severity, 'major');
  assert.equal(JSON.parse(String(review.items_json))[0].ref, 'x.ts:3');
  assert.ok(['pass', 'warn'].includes(JSON.parse(String(review.gate_json)).status));
  assert.deepEqual(
    db
      .prepare('SELECT kind FROM card_links ORDER BY id')
      .all()
      .map((row) => row.kind),
    ['mmbridge_run', 'handoff'],
  );
});
test('vision/owner-ok/merge/done: complete protected lifecycle', (t) => {
  const f = fixture(t);
  const id = f.accepted(['--needs-owner', '1', '--needs-vision', '1']);
  const shots = f.file(
    'shots.json',
    ['light', 'dark'].flatMap((theme) =>
      ['mobile', 'desktop'].map((viewport) => ({ theme, viewport, na_reason: 'CLI has no visual UI' })),
    ),
  );
  assert.match(f.run(['done', id], 3).stderr, /APS-D02:/);
  f.run(['merge', id, '--applied-ref', 'verified-ledger-change', '--target', 'test']);
  assert.match(f.run(['done', id], 3).stderr, /APS-D04:/);
  f.run(['vision', id, '--by', f.vision, '--verdict', 'pass', '--shots', shots]);
  assert.match(f.run(['done', id], 3).stderr, /APS-D05:/);
  f.run(['owner-ok', id, '--quote', 'Approved']);
  assert.equal(f.run(['done', id]).value[0].to, 'done');
});
test('vision fail moves to revise and records defects', (t) => {
  const f = fixture(t);
  const id = f.accepted();
  const shots = f.file('shots.json', [{ theme: 'light', viewport: 'mobile', path: 'shot.png' }]);
  const items = f.file('items.json', [{ severity: 'major', category: 'visual', text: 'Bad layout' }]);
  assert.equal(
    f.run(['vision', id, '--by', f.vision, '--verdict', 'fail', '--shots', shots, '--items', items]).value[0].to,
    'revise',
  );
});
test('return/reject manager transitions preserve notes', (t) => {
  const f = fixture(t);
  const id = f.working();
  f.run(['return', id, '--note', 'reassign']);
  f.run(['reject', id, '--note', 'cancel']);
  assert.equal(f.run(['card', 'show', id]).value.history.at(-1).note, 'cancel');
});
test('todo-render writes ordered Korean state tables atomically', (t) => {
  const f = fixture(t);
  const id = f.card();
  const out = join(f.home, 'todo.md');
  f.run(['todo-render', '--out', out]);
  const md = readFileSync(out, 'utf8');
  assert.match(md, /## 발행/);
  assert.ok(md.includes(id));
  assert.ok(md.indexOf('## 발행') < md.indexOf('## 완료'));
  assert.ok(f.run(['todo-render']).value.markdown.includes('| id |'));
});
test('brief/metrics/chart and defect add compute measured ledger values', (t) => {
  const f = fixture(t);
  const id = f.accepted();
  f.run(['defect', 'add', id, '--source', 'ci', '--category', 'test', '--severity', 'minor', '--text', 'test gap']);
  const metrics = f.run(['metrics']).value;
  assert.equal(metrics.wip, 1);
  assert.equal(metrics.reported, 1);
  assert.equal(metrics.opportunities, 1);
  assert.equal(metrics.dpmo, 1_000_000);
  assert.equal(metrics.passByModel[0].pass_rate, 1);
  const briefing = f.run(['brief', '--level', 'L1', '--save']).value;
  assert.ok(briefing.id);
  assert.match(briefing.markdown, /# APS L1 briefing/);
  for (const metric of ['rework', 'pass', 'cycle'])
    assert.equal(f.run(['chart', '--metric', metric, '--days', '14']).value.points.length, 14);
  assert.equal(f.run(['chart', '--metric', 'pass']).value.centre, 1);
  f.run(['chart', '--metric', 'unknown'], 2);
  f.run(['metrics', '--since', 'invalid'], 2);
});
test('feedback new/respond applies response guard and warns on overdue feedback', (t) => {
  const f = fixture(t);
  const id = f.run(['feedback', 'new', '--to', f.worker, '--kind', 'proposal', '--body', 'Consider this']).value.id;
  assert.match(f.run(['feedback', 'respond', String(id), '--response', 'partial'], 3).stderr, /APS-K02:/);
  f.run(['feedback', 'respond', String(id), '--response', 'accept']);
  const db = openApsDb(f.dbPath);
  db.prepare(
    "INSERT INTO feedback(from_agent,to_agent,kind,body,created_at) VALUES(?,?,'andon','late',strftime('%Y-%m-%dT%H:%M:%fZ','now','-31 minutes'))",
  ).run(f.manager, f.worker);
  db.close();
  const output = f.run(['metrics']);
  assert.match(output.stderr, /APS-K10: feedback 2 unanswered for > 30 min; escalated/);
  assert.doesNotMatch(f.run(['metrics']).stderr, /APS-K10/);
});
test('K10 escalation commits and warns even when the command fails', (t) => {
  const f = fixture(t);
  for (const failure of [
    { args: ['done', 'TS-C-9999'], status: 2, message: /card TS-C-9999 not found/ },
    { args: ['done', f.card()], status: 3, message: /APS-T02:/ },
  ]) {
    const db = openApsDb(f.dbPath);
    const id = db
      .prepare(
        "INSERT INTO feedback(from_agent,to_agent,kind,body,created_at) VALUES(?,?,'andon','late',strftime('%Y-%m-%dT%H:%M:%fZ','now','-31 minutes'))",
      )
      .run(f.manager, f.worker).lastInsertRowid;
    db.close();
    const output = f.run(failure.args, failure.status);
    assert.ok(output.stderr.includes(`APS-K10: feedback ${id} unanswered for > 30 min; escalated`));
    assert.match(output.stderr, failure.message);
    const persisted = openApsDb(f.dbPath);
    const row = persisted.prepare('SELECT escalated, escalated_at FROM feedback WHERE id=?').get(id);
    assert.equal(row?.escalated, 1);
    assert.ok(row?.escalated_at);
    persisted.close();
    assert.doesNotMatch(f.run(['metrics']).stderr, /APS-K10/);
  }
});
test('owner OK refuses a new L1 session with the assignee name', (t) => {
  const f = fixture(t);
  const id = f.accepted(['--needs-owner', '1']);
  const self = f.run(['agent', 'new', '--name', 'worker', '--layer', 'L1', '--model', 'local', '--vendor', 'local'])
    .value.id;
  assert.match(
    f.run(['owner-ok', id, '--quote', 'self-recorded', '--by', self], 3).stderr,
    /APS-O04: owner OK must be recorded by an agent independent of the card assignee and reporters/,
  );
  const db = openApsDb(f.dbPath);
  assert.equal(db.prepare('SELECT count(*) AS n FROM owner_oks').get()?.n, 0);
  db.close();
  f.run(['owner-ok', id, '--quote', 'independently recorded']);
});
test('doctor rejects missing trigger before writes', (t) => {
  const f = fixture(t);
  assert.deepEqual(f.run(['doctor']).value.integrity, ['ok']);
  const db = openApsDb(f.dbPath);
  db.exec('DROP TRIGGER trg_states_ins');
  db.close();
  assert.match(f.run(['doctor'], 3).stderr, /APS-DOCTOR:.*trg_states_ins/);
  f.run(['project', 'add', 'refused', '--prefix', 'RF', '--name', 'Refused'], 3);
});
test('TS guards H02/H04 and newer schema refuse without mutation', async (t) => {
  const f = fixture(t);
  const id = f.reported();
  f.run(['close-session', f.worker, '--note', 'ended']);
  const uuid = '00000000-0000-4000-8000-000000000000';
  assert.match(
    f.run(['review', id, '--verdict', 'accept', '--from-session', uuid], 3).stderr,
    /APS-H04: mmbridge session .* not found/,
  );
  const store = new SessionStore(join(f.home, '.mmbridge'));
  await store.save({
    id: uuid,
    tool: 'codex',
    mode: 'review',
    projectDir: f.home,
    workspace: f.home,
    head: { sha: 'b'.repeat(40), branch: 'test' },
  });
  assert.match(
    f.run(['review', id, '--verdict', 'accept', '--from-session', uuid], 3).stderr,
    /APS-H02:.*head.sha b+ != reported sha a+/,
  );
  assert.equal(f.run(['card', 'show', id]).value.state, 'closed_session');
  const newer = openApsDb(f.dbPath);
  newer.exec('PRAGMA user_version=99');
  newer.close();
  assert.match(f.run(['init'], 3).stderr, /APS-U01: ledger schema v99 is newer than this build \(max v2\)/);
});
test('missing actor and unreadable JSON are input errors', (t) => {
  const f = fixture(t);
  f.env.APS_AGENT = '';
  f.run(['init'], 2);
  f.env.APS_AGENT = f.manager;
  f.run(
    [
      'card',
      'new',
      '--project',
      'test',
      '--title',
      'bad',
      '--kind',
      'mech',
      '--size',
      'S',
      '--scope',
      'scope',
      '--acceptance',
      '/does-not-exist',
      '--forbidden',
      'none',
      '--owner',
      f.manager,
    ],
    2,
  );
  f.run(['start'], 2);
});
test('git merge H03/H05 rejections, fast-forward target and pre-merge gate', (t) => {
  const f = fixture(t);
  const git = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: f.home, env: f.env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(['init', '-q', '-b', 'main']);
  git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'base']);
  const base = git(['rev-parse', 'HEAD']);
  git(['branch', 'behind']);
  git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'change']);
  const commit = git(['rev-parse', 'HEAD']);
  const id = f.working();
  f.report(id, ['--sha', commit]);
  f.run(['close-session', f.worker, '--note', 'ended']);
  f.run(['review', id, '--verdict', 'accept']);
  assert.match(
    f.run(['merge', id, '--merged-sha', base, '--target', 'main'], 3).stderr,
    /APS-H03: .* does not contain .* \(git merge-base --is-ancestor failed\)/,
  );
  for (const target of ['no-such-branch', 'behind']) {
    assert.equal(
      f.run(['merge', id, '--merged-sha', commit, '--target', target], 3).stderr.trim(),
      `[mmbridge] APS-H05: target ${target} does not contain ${commit} (unresolved or not an ancestor)`,
    );
  }
  const rejected = openApsDb(f.dbPath);
  assert.equal(rejected.prepare('SELECT count(*) AS n FROM merges').get()?.n, 0);
  rejected.close();
  f.run(['merge', id, '--merged-sha', commit, '--target', 'main', '--gate']);
  const db = openApsDb(f.dbPath);
  const merge = db.prepare('SELECT * FROM merges').get();
  assert.ok(merge);
  assert.equal(merge.merged_sha, commit);
  assert.equal(
    merge.verify_command,
    `git merge-base --is-ancestor ${commit} ${commit} && git rev-parse --verify main^{commit} && git merge-base --is-ancestor ${commit} ${commit}`,
  );
  assert.ok(['pass', 'warn'].includes(JSON.parse(String(merge.gate_json)).status));
  db.close();
  f.run(['done', id]);
});
test('git merge H05 accepts a real no-ff merge on main', (t) => {
  const f = fixture(t);
  const git = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: f.home, env: f.env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const identity = ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid'];
  git(['init', '-q', '-b', 'main']);
  git([...identity, 'commit', '--allow-empty', '-qm', 'base']);
  git(['switch', '-qc', 'feature']);
  git([...identity, 'commit', '--allow-empty', '-qm', 'feature']);
  const reported = git(['rev-parse', 'HEAD']);
  const id = f.working();
  f.report(id, ['--sha', reported]);
  f.run(['close-session', f.worker, '--note', 'ended']);
  f.run(['review', id, '--verdict', 'accept']);
  git(['switch', '-q', 'main']);
  git([...identity, 'merge', '-q', '--no-ff', 'feature', '-m', 'merge feature']);
  const merged = git(['rev-parse', 'HEAD']);
  assert.notEqual(merged, reported);
  f.run(['merge', id, '--merged-sha', merged, '--target', 'main']);
  const db = openApsDb(f.dbPath);
  assert.equal(db.prepare('SELECT merged_sha FROM merges').get()?.merged_sha, merged);
  db.close();
  f.run(['done', id]);
});
test('context lineage survives missing compacted nodes without changing the tree', (t) => {
  const f = fixture(t);
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: f.home, env: f.env }).status, 0);
  const parent = f.card();
  const child = f.card(['--parent', parent]);
  const before = f.run(['card', 'show', child]).value;
  assert.equal(before.parent_card, parent);
  assert.equal(before.lineage.length, 1);
  assert.equal(before.lineage[0].label, 'context');
  const parentLink = f.run(['card', 'show', parent]).value.links[0];
  assert.equal(before.lineage[0].parentId, parentLink.ref);
  const cache = join(f.home, '.mmbridge', 'context-trees', `${before.lineage[0].projectKey}.jsonl`);
  writeFileSync(cache, '');
  const after = f.run(['card', 'show', child]).value;
  assert.equal(after.lineage[0].label, '(compacted)');
  assert.equal(after.lineage[0].parentId, parentLink.ref);
  assert.equal(readFileSync(cache, 'utf8'), '');
});
