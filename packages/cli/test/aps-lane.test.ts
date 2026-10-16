import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { addRunEvent, createRun, newAgent, openApsDb, startCard } from '@mmbridge/aps';

const bin = resolve(import.meta.dirname, '../dist/bin/mmbridge.js');
const usageFixture = resolve(import.meta.dirname, '../../aps/test/fixtures/omp-usage.json');
const card = 'TS-C-0001';
const card2 = 'TS-C-0002';
const acceptance = '[{"id":"AC1","text":"Works","command":"echo yes","expect":"yes"}]';

function fixture(t: TestContext) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'aps-lane-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const worktree = join(home, 'worker tree');
  mkdirSync(worktree);
  // APS_AGENT empty: lane start records itself unless --by names a manager.
  const env = {
    ...process.env,
    HOME: home,
    APS_AGENT: '',
    NODE_NO_WARNINGS: '1',
    APS_DB: join(home, 'aps.db'),
    MMBRIDGE_APS_DB: '',
  };
  const git = (args: string[]) => {
    const result = spawnSync('git', ['-C', worktree, ...args], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(['init', '-b', 'worker']);
  git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'initial']);
  const db = openApsDb(env.APS_DB);
  db.exec(`INSERT INTO projects(id,prefix,name) VALUES('test','TS','Test');
    INSERT INTO agents(id,name,layer,model,vendor) VALUES('mgr','manager','L1','test','test');
    INSERT INTO cards(id,project,title,kind,size,scope,acceptance_json,forbidden,needs_owner,needs_vision,layer_owner)
    VALUES('${card}','test','Lane test','mech','S','CLI','${acceptance}','paid calls',0,0,'mgr'),
          ('${card2}','test','Lane test 2','mech','S','CLI','${acceptance}','paid calls',0,0,'mgr');`);
  t.after(() => db.close());
  const sessions = join(home, '.omp', 'agent', 'sessions');
  const sessionDir = join(sessions, '-worker-tree', '2026-10-17T00-00-00-000Z_parent');
  mkdirSync(sessionDir, { recursive: true });

  const cli = (args: string[], status = 0) => {
    const result = spawnSync(process.execPath, [bin, ...args, '--db', env.APS_DB, '--json'], {
      env,
      cwd: worktree,
      encoding: 'utf8',
      timeout: 60_000,
    });
    assert.equal(result.status, status, `${result.stdout}\n${result.stderr}`);
    return { ...result, value: status === 0 && result.stdout.trim() ? JSON.parse(result.stdout) : null };
  };
  const start = (cardId: string, ompId: string, extra: string[] = [], status = 0) =>
    cli(['aps', 'lane', 'start', cardId, '--omp-id', ompId, '--lane', 'lane-x', ...extra], status);
  /** omp transcript: header, a model, then `tail` entries (default: a tool call still running). */
  const transcript = (
    file: string,
    tail: unknown[] = [
      { type: 'message', message: { role: 'assistant', stopReason: 'toolUse', provider: 'zai', model: 'glm-5.3' } },
    ],
  ) =>
    writeFileSync(
      file,
      `${[{ type: 'session', cwd: worktree }, { type: 'model_change', model: 'zai/glm-5.3' }, ...tail]
        .map((line) => JSON.stringify(line))
        .join('\n')}\n`,
    );
  const runEvents = (run: string) =>
    db
      .prepare('SELECT status FROM run_events WHERE run_id=? ORDER BY id')
      .all(run)
      .map((row) => row.status);
  const audit = (extra: string[] = []) => {
    const result = spawnSync(
      process.execPath,
      [bin, 'aps', 'audit', '--db', env.APS_DB, '--no-herdr', '--quota-json', usageFixture, '--json', ...extra],
      { env, cwd: home, encoding: 'utf8', timeout: 60_000 },
    );
    assert.ok(result.status === 0 || result.status === 4, `${result.stdout}\n${result.stderr}`);
    return JSON.parse(result.stdout) as {
      lanes: Array<{ id: string; source: string; model: string | null; recorded: boolean | null }>;
      violations: Array<{ code: string; lane: string | null }>;
    };
  };
  /** A pointer-mode run as `aps dispatch --harness omp --omp-id` records it: `session_ref` is a pattern. */
  const seedPointerRun = (cardId: string, ompId: string, model: string) => {
    const worker = newAgent(db, { name: `w-${ompId}`, layer: 'L3', model, vendor: 'test', project: 'test' });
    startCard(db, cardId, worker);
    const run = `${cardId}-a1-pointer`;
    createRun(db, {
      id: run,
      card_id: cardId,
      attempt: 1,
      agent_id: worker,
      harness: 'omp',
      kind: null,
      model,
      worktree,
      branch: 'worker',
      base_sha: git(['rev-parse', 'HEAD']),
      packet_dir: join(home, 'dispatch', run),
      created_by: 'mgr',
    });
    addRunEvent(db, run, 'launched', 'mgr', { omp_id: ompId, session_ref: join(sessions, '*', '*', `${ompId}.jsonl`) });
    return run;
  };
  return {
    home,
    worktree,
    env,
    db,
    git,
    sessionDir,
    sessions,
    cli,
    start,
    transcript,
    runEvents,
    audit,
    seedPointerRun,
  };
}

test('lane start records the exact transcript and reuses an idle agent of that name', (t) => {
  const f = fixture(t);
  const idle = newAgent(f.db, { name: 'lane-x', layer: 'L3', model: 'zai/glm-5.3', vendor: 'zai', project: 'test' });
  f.transcript(join(f.sessionDir, 'TaskA.jsonl'));
  const first = f.start(card, 'TaskA', ['--omp-session-dir', f.sessionDir]).value;
  assert.equal(first.reused_agent, true);
  assert.equal(first.agent, idle);
  assert.equal(first.by, first.agent);
  assert.equal(first.model, 'zai/glm-5.3');
  assert.equal(first.session_ref, join(f.sessionDir, 'TaskA.jsonl'));
  assert.equal(first.base_sha, f.git(['rev-parse', 'HEAD']));
  assert.deepEqual(f.runEvents(first.run), ['intent', 'launched']);
  const launched = JSON.parse(
    String(
      f.db.prepare("SELECT detail_json FROM run_events WHERE run_id=? AND status='launched'").get(first.run)
        ?.detail_json,
    ),
  );
  assert.deepEqual(launched, { omp_id: 'TaskA', session_ref: join(f.sessionDir, 'TaskA.jsonl'), lane: 'lane-x' });
  const run = f.db.prepare('SELECT harness, kind FROM worker_runs WHERE id=?').get(first.run);
  assert.deepEqual({ ...run }, { harness: 'omp', kind: null });
  assert.match(readFileSync(join(first.packet, 'card.md'), 'utf8'), /## Collect contract/);

  assert.match(f.start(card, 'TaskA', [], 3).stderr, /APS-N01: card already has a live run/);
  assert.match(f.start(card2, 'bad id', [], 2).stderr, /--omp-id must match/);
});

test('lane start creates the agent, reads the model from the transcript, finds nested tasks', (t) => {
  const f = fixture(t);
  // Task spawned by task `Lead`: <parent session>/Lead/Lead.Child.jsonl.
  mkdirSync(join(f.sessionDir, 'Lead'));
  f.transcript(join(f.sessionDir, 'Lead', 'Lead.Child.jsonl'));
  const started = f.start(card, 'Lead.Child').value;
  assert.equal(started.reused_agent, false);
  assert.equal(started.model, 'zai/glm-5.3');
  assert.equal(started.session_ref, join(f.sessionDir, 'Lead', 'Lead.Child.jsonl'));
  const agent = f.db.prepare('SELECT name, vendor, model, project FROM agents WHERE id=?').get(started.agent);
  assert.deepEqual({ ...agent }, { name: 'lane-x', vendor: 'zai', model: 'zai/glm-5.3', project: 'test' });
});

test('lane start refuses ambiguous ids and session dirs outside the omp sessions root', (t) => {
  const f = fixture(t);
  const otherDir = join(f.sessions, '-other', '2026-10-17T00-00-01-000Z_parent');
  mkdirSync(otherDir, { recursive: true });
  f.transcript(join(f.sessionDir, 'TaskD.jsonl'));
  f.transcript(join(otherDir, 'TaskD.jsonl'));
  assert.match(f.start(card, 'TaskD', [], 2).stderr, /omp task TaskD is ambiguous .*pass --omp-session-dir/);
  const outside = join(f.home, 'elsewhere');
  mkdirSync(outside);
  f.transcript(join(outside, 'TaskD.jsonl'));
  assert.match(
    f.start(card, 'TaskD', ['--omp-session-dir', outside], 2).stderr,
    /must be an existing directory inside/,
  );
  symlinkSync(outside, join(f.sessions, '-link'));
  assert.match(
    f.start(card, 'TaskD', ['--omp-session-dir', join(f.sessions, '-link')], 2).stderr,
    /must be an existing directory inside/,
  );
  assert.equal(f.db.prepare('SELECT state FROM cards WHERE id=?').get(card)?.state, 'issued');
  assert.equal(
    f.start(card, 'TaskD', ['--omp-session-dir', otherDir]).value.session_ref,
    join(otherDir, 'TaskD.jsonl'),
  );
});

test('a busy lane name is refused, so ending one card never touches another', (t) => {
  const f = fixture(t);
  f.transcript(join(f.sessionDir, 'TaskA.jsonl'));
  f.transcript(join(f.sessionDir, 'TaskB.jsonl'));
  const a = f.start(card, 'TaskA', ['--omp-session-dir', f.sessionDir]).value;
  assert.match(
    f.start(card2, 'TaskB', ['--omp-session-dir', f.sessionDir], 2).stderr,
    /lane lane-x is busy: agent .* holds TS-C-0001 \(working\)/,
  );
  assert.equal(f.db.prepare('SELECT state FROM cards WHERE id=?').get(card2)?.state, 'issued');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM worker_runs WHERE card_id=?').get(card2)?.n, 0);
  writeFileSync(join(f.sessionDir, 'TaskA.md'), 'yielded\n');
  const abandoned = f.cli(['aps', 'lane', 'end', card, '--omp-id', 'TaskA', '--by', 'mgr', '--abandon']).value;
  assert.equal(abandoned.outcome, 'abandoned');
  assert.equal(f.db.prepare('SELECT state FROM cards WHERE id=?').get(card)?.state, 'issued');
  assert.deepEqual(f.runEvents(a.run), ['intent', 'launched', 'abandoned']);
  assert.equal(f.db.prepare('SELECT status FROM agents WHERE id=?').get(a.agent)?.status, 'closed');
  const b = f.start(card2, 'TaskB', ['--omp-session-dir', f.sessionDir]).value;
  assert.equal(b.reused_agent, false);
  assert.notEqual(b.agent, a.agent);
});

test('lane end refuses until the task yielded, binds to the recorded transcript, then collects', (t) => {
  const f = fixture(t);
  f.transcript(join(f.sessionDir, 'TaskA.jsonl'));
  const started = f.start(card, 'TaskA', ['--omp-session-dir', f.sessionDir]).value;
  writeFileSync(
    join(started.packet, 'report.json'),
    `${JSON.stringify({
      run: started.run,
      card,
      attempt: started.attempt,
      status: 'DONE',
      sha: f.git(['rev-parse', 'HEAD']),
      branch: 'worker',
      pr: null,
      files: ['src/x.ts'],
      evidence: [{ ac: 'AC1', command: 'echo yes', output: 'yes', ok: true }],
    })}\n`,
  );
  writeFileSync(join(started.packet, 'report.md'), '## report\n');
  const end = (extra: string[], status: number) =>
    f.cli(['aps', 'lane', 'end', card, '--omp-id', 'TaskA', ...extra], status);
  assert.match(end(['--by', started.agent], 2).stderr, /--by must be a manager session/);
  assert.match(end(['--by', 'mgr', '--omp-id', 'TaskZ'], 2).stderr, /is not omp task TaskZ/);
  // Another session's TaskA with a yield output must not satisfy this run.
  const otherDir = join(f.sessions, '-other', '2026-10-17T00-00-01-000Z_parent');
  mkdirSync(otherDir, { recursive: true });
  f.transcript(join(otherDir, 'TaskA.jsonl'));
  writeFileSync(join(otherDir, 'TaskA.md'), 'other yield\n');
  assert.match(
    end(['--by', 'mgr', '--omp-session-dir', otherDir], 2).stderr,
    /does not hold the transcript recorded for run/,
  );
  const yieldPath = join(f.sessionDir, 'TaskA.md').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(
    end(['--by', 'mgr'], 3).stderr,
    new RegExp(`APS-H08: omp task TaskA has no yield output at ${yieldPath}`),
  );
  assert.deepEqual(f.runEvents(started.run), ['intent', 'launched']);
  writeFileSync(join(f.sessionDir, 'TaskA.md'), 'yielded\n');
  assert.equal(end(['--by', 'mgr', '--omp-session-dir', f.sessionDir], 0).value.outcome, 'reported');
  assert.deepEqual(f.runEvents(started.run), ['intent', 'launched', 'reported', 'closed']);
  assert.equal(f.db.prepare('SELECT state FROM cards WHERE id=?').get(card)?.state, 'closed_session');
  assert.equal(f.db.prepare('SELECT status FROM agents WHERE id=?').get(started.agent)?.status, 'closed');
});

test('audit reports live unrecorded omp subagents and ties pattern runs to one transcript', (t) => {
  const f = fixture(t);
  f.transcript(join(f.sessionDir, 'Foo.jsonl'));
  f.transcript(join(f.sessionDir, 'Idle.jsonl'), [
    { type: 'message', message: { role: 'assistant', stopReason: 'stop', provider: 'zai', model: 'glm-5.3' } },
  ]);
  f.transcript(join(f.sessionDir, 'Parked.jsonl'), [{ type: 'custom', customType: 'session_exit' }]);
  f.transcript(join(f.sessionDir, '__advisor.jsonl'));
  // Pointer-mode pattern with one nested match: resolved for the model and not reported as unrecorded.
  mkdirSync(join(f.sessionDir, 'Lead'));
  f.transcript(join(f.sessionDir, 'Lead', 'Lead.Child.jsonl'));
  const nested = f.seedPointerRun(card, 'Lead.Child', 'test/declared');
  // The same task id in two parent sessions ties no file: both stay visible and the model is not guessed.
  const otherDir = join(f.sessions, '-other', '2026-10-17T00-00-01-000Z_parent');
  mkdirSync(otherDir, { recursive: true });
  f.transcript(join(f.sessionDir, 'TaskD.jsonl'));
  f.transcript(join(otherDir, 'TaskD.jsonl'));
  const ambiguous = f.seedPointerRun(card2, 'TaskD', 'test/declared');

  const report = f.audit();
  const omp = report.lanes.filter((lane) => lane.source === 'omp');
  assert.deepEqual(
    omp.map((lane) => [lane.id, lane.recorded, lane.model]),
    [
      ['omp:TaskD', false, 'zai/glm-5.3'],
      ['omp:Foo', false, 'zai/glm-5.3'],
      ['omp:TaskD', false, 'zai/glm-5.3'],
    ],
  );
  assert.ok(
    report.violations.some((violation) => violation.code === 'UNRECORDED_LANE' && violation.lane === 'omp:Foo'),
  );
  assert.equal(report.lanes.find((lane) => lane.id === nested)?.model, 'zai/glm-5.3');
  assert.equal(report.lanes.find((lane) => lane.id === ambiguous)?.model, 'test/declared');

  const skipped = f.audit(['--no-omp-sessions']);
  assert.deepEqual(
    skipped.lanes.filter((lane) => lane.source === 'omp'),
    [],
  );
});

test('collect resolves a nested pointer-mode task and refuses an ambiguous one', (t) => {
  const f = fixture(t);
  mkdirSync(join(f.sessionDir, 'Lead'));
  f.transcript(join(f.sessionDir, 'Lead', 'Lead.Child.jsonl'));
  f.seedPointerRun(card, 'Lead.Child', 'test/declared');
  const nestedYield = join(f.sessionDir, 'Lead', 'Lead.Child.md').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(
    f.cli(['aps', 'lane', 'end', card, '--omp-id', 'Lead.Child', '--by', 'mgr'], 3).stderr,
    new RegExp(`APS-H08: omp task Lead.Child has no yield output at ${nestedYield}`),
  );
  const otherDir = join(f.sessions, '-other', '2026-10-17T00-00-01-000Z_parent');
  mkdirSync(otherDir, { recursive: true });
  f.transcript(join(f.sessionDir, 'TaskD.jsonl'));
  f.transcript(join(otherDir, 'TaskD.jsonl'));
  f.seedPointerRun(card2, 'TaskD', 'test/declared');
  assert.match(
    f.cli(['aps', 'lane', 'end', card2, '--omp-id', 'TaskD', '--by', 'mgr'], 3).stderr,
    /APS-H08: omp task TaskD has no yield output at .*\(ambiguous; pass --omp-session-dir\)/,
  );
});
