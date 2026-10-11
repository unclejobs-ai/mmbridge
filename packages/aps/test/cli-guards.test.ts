// TS guards from DESIGN.md §5.2 — CLI-side checks the SQL triggers cannot see
// (herdr, git, ~/.mmbridge sessions, wall clock). Each test spawns the real CLI
// binary against a temp --db and a temp HOME, and asserts the §5.2 message plus
// one case the guard allows. Until A-02 lands dist/commands/aps.js the tests
// report todo; the flag clears itself once the CLI exists.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { openApsDb } from '../dist/index.js';
import { AC2, CARD, SHA, SHA2, cardState, move, review, toInspecting } from './fixture.ts';

const CLI_BIN = fileURLToPath(new URL('../../cli/dist/bin/mmbridge.js', import.meta.url));
const CLI_READY = fs.existsSync(fileURLToPath(new URL('../../cli/dist/commands/aps.js', import.meta.url)));
const TODO = CLI_READY ? false : 'aps CLI not implemented yet (A-02, DESIGN.md §8)';

interface CliRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** `mmbridge aps <args>` in a temp HOME; fakeBin prepends a stub dir to PATH. */
function aps(args: string[], opts: { home: string; cwd?: string; fakeBin?: string }): CliRun {
  const env = {
    PATH: opts.fakeBin ? `${opts.fakeBin}${path.delimiter}${process.env.PATH ?? ''}` : (process.env.PATH ?? ''),
    HOME: opts.home,
    APS_AGENT: 'mgr',
  };
  const res = spawnSync(process.execPath, [CLI_BIN, 'aps', ...args], {
    cwd: opts.cwd ?? opts.home,
    env,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/** The fixture seed, but on a file the CLI process can open. */
function seedLedger(dir: string): string {
  const dbPath = path.join(dir, 'aps.db');
  const db = openApsDb(dbPath);
  db.exec(`
    INSERT INTO projects(id,prefix,name) VALUES('ss','SS','SceneSteller');
    INSERT INTO agents(id,name,layer,model,vendor) VALUES
      ('l0','opus-l0','L0','opus-5.5','anthropic'),
      ('mgr','sol-l2','L2','sol-6.1','openai'),
      ('w1','devin','L3','swe-2-max','cognition'),
      ('w1b','devin','L3','swe-2-max','cognition'),
      ('w2','grok','L3','grok-4.7','xai'),
      ('rev','opus-l1','L1','opus-5.5','anthropic'),
      ('viz','viewer','L1','sonnet-5.5','anthropic');
    INSERT INTO cards(id,project,title,kind,size,scope,acceptance_json,forbidden,needs_owner,needs_vision,layer_owner,assignee)
    VALUES('${CARD}','ss','card','mech','S','scope','${AC2}','none',0,0,'mgr','w1');
  `);
  db.close();
  return dbPath;
}

function withDb<T>(dbPath: string, fn: (db: DatabaseSync) => T): T {
  const db = openApsDb(dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aps-cli-'));
}

/** `SessionStore.save` equivalent: writes ~/.mmbridge/sessions/<id>.json. */
function writeSession(home: string, id: string, sha: string, projectDir: string): void {
  const dir = path.join(home, '.mmbridge', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({
      id,
      tool: 'mmbridge',
      mode: 'review',
      projectDir,
      workspace: projectDir,
      createdAt: '2026-10-11T00:00:00.000Z',
      head: { sha, branch: 'feat/x' },
    }),
  );
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

test('H01: close-session refuses while the herdr pane is still open', { todo: TODO }, (t) => {
  const dir = tmpdir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  const fakeBin = path.join(dir, 'bin');
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(
    path.join(fakeBin, 'herdr'),
    `#!/bin/sh
[ "$#" -eq 3 ] && [ "$1" = pane ] && [ "$2" = get ] || exit 99
case "$3" in
  pane-1) printf '%s\\n' '{"result":{"type":"pane_info","pane":{"pane_id":"pane-1","terminal_id":"terminal-1","tab_id":"tab-1","workspace_id":"workspace-1"}}}' ;;
  pane-2) printf '%s\\n' '{"error":{"code":"pane_not_found"}}' >&2; exit 1 ;;
  pane-3) printf '%s\\n' '{"error":{"code":"server_not_running"}}' >&2; exit 1 ;;
  *) exit 99 ;;
esac
`,
    { mode: 0o755 },
  );
  const dbPath = seedLedger(home);
  withDb(dbPath, (db) =>
    db.exec(`UPDATE agents SET herdr_pane='pane-1' WHERE id='w1';
             UPDATE agents SET herdr_pane='pane-2' WHERE id='w2';
             UPDATE agents SET herdr_pane='pane-3' WHERE id='w1b'`),
  );

  const denied = aps(['close-session', 'w1', '--by', 'mgr', '--note', 'done', '--db', dbPath], { home, fakeBin });
  assert.equal(denied.status, 3, denied.stderr);
  assert.ok(denied.stderr.includes('[mmbridge] APS-H01: herdr pane pane-1 is still open'));

  const failed = aps(['close-session', 'w1b', '--by', 'mgr', '--note', 'done', '--db', dbPath], {
    home,
    fakeBin,
  });
  assert.equal(failed.status, 1, failed.stderr);
  assert.ok(failed.stderr.includes('cannot confirm pane ended: herdr pane get failed'));
  assert.equal(
    withDb(dbPath, (db) => db.prepare("SELECT status FROM agents WHERE id='w1b'").get()?.status),
    'active',
  );

  // allowed: w2's pane-2 is explicitly reported as pane_not_found
  const ok = aps(['close-session', 'w2', '--by', 'mgr', '--note', 'done', '--db', dbPath], { home, fakeBin });
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(!ok.stderr.includes('APS-H01'));
});

test('H02: review --from-session refuses when session head.sha != reported sha', { todo: TODO }, () => {
  const dir = tmpdir();
  const home = path.join(dir, 'home');
  const dbPath = seedLedger(home);
  withDb(dbPath, (db) => toInspecting(db, 'w1', SHA));
  const uuid = '0f8fad5b-d9cb-469f-a165-70867728950e';
  writeSession(home, uuid, SHA2, dir);

  const denied = aps(['review', CARD, '--verdict', 'accept', '--from-session', uuid, '--by', 'rev', '--db', dbPath], {
    home,
  });
  assert.equal(denied.status, 3, denied.stderr);
  assert.ok(
    denied.stderr.includes(`[mmbridge] APS-H02: mmbridge session ${uuid} head.sha ${SHA2} != reported sha ${SHA}`),
  );

  // allowed: head.sha matches the reported sha -> accept moves to merge_wait
  const uuid2 = '11111111-2222-4333-8444-555555555555';
  writeSession(home, uuid2, SHA, dir);
  const ok = aps(['review', CARD, '--verdict', 'accept', '--from-session', uuid2, '--by', 'rev', '--db', dbPath], {
    home,
  });
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(!ok.stderr.includes('APS-H02'));
  assert.deepEqual({ ...withDb(dbPath, cardState) }, { state: 'merge_wait', attempt: 1 });
});

test('H03: merge refuses a merged_sha that does not contain the reported sha', { todo: TODO }, () => {
  const dir = tmpdir();
  const home = path.join(dir, 'home');
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.name', 'APS Test']);
  git(repo, ['config', 'user.email', 'aps@example.com']);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git(repo, ['add', 'a.txt']);
  git(repo, ['commit', '-m', 'a']);
  const shaA = git(repo, ['rev-parse', 'HEAD']);
  git(repo, ['checkout', '--orphan', 'other']);
  git(repo, ['rm', '-rf', '.']);
  fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
  git(repo, ['add', 'b.txt']);
  git(repo, ['commit', '-m', 'b']);
  const shaB = git(repo, ['rev-parse', 'HEAD']);
  git(repo, ['checkout', 'main']);
  fs.writeFileSync(path.join(repo, 'c.txt'), 'c\n');
  git(repo, ['add', 'c.txt']);
  git(repo, ['commit', '-m', 'c']);
  const shaC = git(repo, ['rev-parse', 'HEAD']);

  const dbPath = seedLedger(home);
  withDb(dbPath, (db) => {
    toInspecting(db, 'w1', shaA);
    review(db, 'accept', shaA);
    move(db, 'inspecting', 'accepted', 'mgr');
    move(db, 'accepted', 'merge_wait', 'mgr');
  });

  const denied = aps(['merge', CARD, '--merged-sha', shaB, '--target', 'main', '--by', 'mgr', '--db', dbPath], {
    home,
    cwd: repo,
  });
  assert.equal(denied.status, 3, denied.stderr);
  assert.ok(
    denied.stderr.includes(
      `[mmbridge] APS-H03: ${shaB} does not contain ${shaA} (git merge-base --is-ancestor failed)`,
    ),
  );

  // allowed: shaC descends from the reported shaA
  const ok = aps(['merge', CARD, '--merged-sha', shaC, '--target', 'main', '--by', 'mgr', '--db', dbPath], {
    home,
    cwd: repo,
  });
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(!ok.stderr.includes('APS-H03'));
});

test('H04: review --from-session refuses an unknown session id', { todo: TODO }, () => {
  const dir = tmpdir();
  const home = path.join(dir, 'home');
  const dbPath = seedLedger(home);
  withDb(dbPath, (db) => toInspecting(db, 'w1', SHA));
  const unknown = '99999999-8888-4777-8666-555555555555';

  const denied = aps(
    ['review', CARD, '--verdict', 'accept', '--from-session', unknown, '--by', 'rev', '--db', dbPath],
    { home },
  );
  assert.equal(denied.status, 3, denied.stderr);
  assert.ok(denied.stderr.includes(`[mmbridge] APS-H04: mmbridge session ${unknown} not found`));

  // allowed: the session file exists -> H04 does not fire (H02 proves it was read)
  const uuid = '0f8fad5b-d9cb-469f-a165-70867728950e';
  writeSession(home, uuid, SHA2, dir);
  const found = aps(['review', CARD, '--verdict', 'accept', '--from-session', uuid, '--by', 'rev', '--db', dbPath], {
    home,
  });
  assert.equal(found.status, 3, found.stderr);
  assert.ok(found.stderr.includes('APS-H02'), found.stderr);
  assert.ok(!found.stderr.includes('APS-H04'));
});

test(
  'K10: every aps invocation escalates feedback unanswered > 30 min (warning, not a rejection)',
  { todo: TODO },
  () => {
    const dir = tmpdir();
    const home = path.join(dir, 'home');
    const dbPath = seedLedger(home);
    const fid = withDb(dbPath, (db) => {
      db.exec(`INSERT INTO feedback(from_agent,to_agent,kind,body,created_at)
             VALUES('w1','mgr','objection','needs rework',strftime('%Y-%m-%dT%H:%M:%fZ','now','-31 minutes'))`);
      return (db.prepare('SELECT id FROM feedback').get() as { id: number }).id;
    });

    const res = aps(['card', 'list', '--db', dbPath], { home });
    assert.equal(res.status, 0, res.stderr);
    assert.ok(res.stderr.includes(`APS-K10: feedback ${fid} unanswered for > 30 min; escalated`), res.stderr);
    const row = withDb(
      dbPath,
      (db) =>
        db.prepare('SELECT escalated, escalated_at FROM feedback WHERE id = ?').get(fid) as {
          escalated: number;
          escalated_at: string | null;
        },
    );
    assert.equal(row.escalated, 1);
    assert.ok(row.escalated_at);

    // allowed: fresh unanswered feedback stays quiet
    const home2 = path.join(dir, 'home2');
    const dbPath2 = seedLedger(home2);
    withDb(dbPath2, (db) =>
      db.exec(`INSERT INTO feedback(from_agent,to_agent,kind,body) VALUES('w1','mgr','proposal','an idea')`),
    );
    const ok = aps(['card', 'list', '--db', dbPath2], { home: home2 });
    assert.equal(ok.status, 0, ok.stderr);
    assert.ok(!ok.stderr.includes('APS-K10'));
  },
);
