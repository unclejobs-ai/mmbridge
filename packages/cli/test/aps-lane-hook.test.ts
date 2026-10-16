import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import apsTaskHook, { laneStarts } from '../../../integrations/omp/aps-task-hook.ts';

type HookHandler = Parameters<Parameters<typeof apsTaskHook>[0]['on']>[1];

const taskEvent = {
  toolName: 'task',
  isError: false,
  input: { tasks: [{ task: 'plain task' }, { task: 'ignored' }] },
  details: {
    progress: [
      { index: 0, id: 'Plain', assignment: 'no card here' },
      {
        index: 1,
        id: 'Lane1',
        assignment: 'Do the work.\nAPS-CARD: TS-C-0001\nAPS-LANE: w-glm\nAPS-WORKTREE: /tmp/wt\n',
      },
    ],
  },
};

test('laneStarts keeps only tasks with an APS-CARD line', () => {
  assert.deepEqual(laneStarts(taskEvent), [{ card: 'TS-C-0001', ompId: 'Lane1', lane: 'w-glm', worktree: '/tmp/wt' }]);
  assert.deepEqual(
    laneStarts({
      toolName: 'task',
      input: { tasks: [{ task: 'x\nAPS-CARD: TS-C-0002' }] },
      details: { results: [{ index: 0, id: 'R0' }] },
    }),
    [{ card: 'TS-C-0002', ompId: 'R0', lane: 'R0' }],
  );
  assert.deepEqual(
    laneStarts({ toolName: 'task', details: { progress: [{ id: 'X', assignment: 'APS-CARD: a; rm -rf /' }] } }),
    [],
  );
});

test('hook spawns one lane start per carded task and never touches the result', async (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'aps-hook-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const calls = join(home, 'calls.jsonl');
  const fake = join(home, 'fake-mmbridge.mjs');
  writeFileSync(
    fake,
    `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`,
  );
  const saved = { cmd: process.env.APS_HOOK_CMD, log: process.env.APS_HOOK_LOG, db: process.env.APS_HOOK_DB };
  t.after(() => {
    for (const [key, value] of [
      ['APS_HOOK_CMD', saved.cmd],
      ['APS_HOOK_LOG', saved.log],
      ['APS_HOOK_DB', saved.db],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.APS_HOOK_CMD = JSON.stringify([process.execPath, fake]);
  process.env.APS_HOOK_LOG = join(home, 'logs', 'hook.log');
  process.env.APS_HOOK_DB = join(home, 'aps.db');
  let handler: HookHandler | undefined;
  apsTaskHook({
    on: (name, fn) => {
      assert.equal(name, 'tool_result');
      handler = fn;
    },
  });
  assert.ok(handler);
  const ctx = { sessionManager: { getSessionFile: () => '/s/-proj/2026-10-17_parent.jsonl' } };
  assert.equal(handler({ ...taskEvent, toolName: 'bash' }, ctx), undefined);
  assert.equal(handler({ ...taskEvent, isError: true }, ctx), undefined);
  assert.equal(handler(taskEvent, ctx), undefined);

  for (let i = 0; i < 100 && !existsSync(calls); i++) await delay(50);
  await delay(200);
  const lines = readFileSync(calls, 'utf8').trim().split('\n');
  assert.deepEqual(
    lines.map((line) => JSON.parse(line)),
    [
      [
        'aps',
        'lane',
        'start',
        'TS-C-0001',
        '--omp-id',
        'Lane1',
        '--lane',
        'w-glm',
        '--json',
        '--omp-session-dir',
        '/s/-proj/2026-10-17_parent',
        '--worktree',
        '/tmp/wt',
        '--db',
        join(home, 'aps.db'),
      ],
    ],
  );
  assert.match(readFileSync(join(home, 'logs', 'hook.log'), 'utf8'), /spawn .*"TS-C-0001"/);

  process.env.APS_HOOK_CMD = 'not json';
  assert.equal(handler(taskEvent, ctx), undefined);
});
