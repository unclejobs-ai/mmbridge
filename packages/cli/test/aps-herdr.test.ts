import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const adapter = new URL('../dist/commands/aps-herdr.js', import.meta.url).href;
const fake = new URL('./fixtures/fake-herdr.mjs', import.meta.url);
const pane = {
  pane_id: 'wH:p2',
  terminal_id: 'term_2',
  tab_id: 'wH:t2',
  workspace_id: 'wH',
  agent_status: 'unknown',
  cwd: '/work/tree with spaces',
};
const absent = { error: { code: 'pane_not_found', message: 'pane wH:p2 not found' } };

type Step = { args: string[]; stdout: unknown; exit?: number; stderr?: string; delayMs?: number };

function invoke(method: string, args: unknown[], steps: Step[], includeCause = false) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mmbridge-herdr-'));
  try {
    const statePath = path.join(root, 'state.json');
    copyFileSync(fake, path.join(root, 'herdr'));
    chmodSync(path.join(root, 'herdr'), 0o755);
    symlinkSync(process.execPath, path.join(root, 'node'));
    writeFileSync(statePath, JSON.stringify({ steps, calls: [] }));
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      const adapter = await import(${JSON.stringify(adapter)});
      try {
        const value = await adapter[${JSON.stringify(method)}](...${JSON.stringify(args)});
        process.stdout.write(JSON.stringify({ ok: true, value }));
      } catch (error) {
        process.stdout.write(JSON.stringify({
          ok: false,
          error: error.message,
          ...(${includeCause} ? { cause: error.cause?.message } : {}),
        }));
      }
    `,
      ],
      {
        encoding: 'utf8',
        timeout: 25_000,
        env: { ...process.env, PATH: root, FAKE_HERDR_STATE: statePath, NODE_NO_WARNINGS: '1' },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(state.steps.length, 0, 'all scripted calls must be exercised');
    assert.deepEqual(
      state.calls,
      steps.map((step) => step.args),
    );
    return JSON.parse(result.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function reply(args: string[], result: unknown): Step {
  return { args, stdout: { result } };
}

test('parseHerdrEnvelope preserves stderr error codes for failed commands', () => {
  assert.deepEqual(invoke('parseHerdrEnvelope', [{ code: 1, stdout: '', stderr: JSON.stringify(absent) }], []), {
    ok: true,
    value: absent,
  });
});

test('getPane maps pane_not_found to absent', () => {
  assert.deepEqual(
    invoke(
      'getPane',
      ['wH:p2'],
      [{ args: ['pane', 'get', 'wH:p2'], stdout: '', stderr: JSON.stringify(absent), exit: 1 }],
    ),
    { ok: true, value: { state: 'absent' } },
  );
});

test('getPane reads stderr when successful stdout is empty', () => {
  assert.deepEqual(
    invoke(
      'getPane',
      ['wH:p2'],
      [{ args: ['pane', 'get', 'wH:p2'], stdout: '', stderr: JSON.stringify({ result: { pane } }) }],
    ),
    { ok: true, value: { state: 'present', pane } },
  );
});

test('getPane returns a present bare-shell pane and agent session metadata', () => {
  const present = { ...pane, agent: 'omp', agent_session: { value: '/sessions/worker.jsonl', kind: 'path' } };
  assert.deepEqual(invoke('getPane', ['wH:p2'], [reply(['pane', 'get', 'wH:p2'], { pane: present })]), {
    ok: true,
    value: { state: 'present', pane: present },
  });
});

test('terminal_id change counts as ended', () => {
  const result = invoke('confirmPaneEnded', ['wH:p2', 'old_terminal'], [reply(['pane', 'get', 'wH:p2'], { pane })]);
  assert.equal(result.ok, true);
  assert.equal(result.value.probe, 'herdr pane get');
  assert.deepEqual(result.value.argv, ['pane', 'get', 'wH:p2']);
  assert.equal(result.value.exit, 0);
  assert.equal(JSON.parse(result.value.stdout_head).result.pane.terminal_id, 'term_2');
  assert.equal(result.value.stderr_head, '');
  assert.ok(Number.isFinite(Date.parse(result.value.at)));
});

test('confirmPaneEnded refuses an open pane even without a detected agent', () => {
  for (const args of [['wH:p2'], ['wH:p2', 'term_2'], ['wH:p2', null]]) {
    assert.deepEqual(invoke('confirmPaneEnded', args, [reply(['pane', 'get', 'wH:p2'], { pane })]), {
      ok: false,
      error: 'APS-H01: herdr pane wH:p2 is still open',
    });
  }
});

test('confirmPaneEnded records explicit absence evidence', () => {
  const result = invoke(
    'confirmPaneEnded',
    ['wH:p2'],
    [{ args: ['pane', 'get', 'wH:p2'], stdout: '', stderr: JSON.stringify(absent), exit: 1 }],
  );
  assert.equal(result.ok, true);
  assert.equal(result.value.exit, 1);
  assert.equal(result.value.stdout_head, '');
  assert.equal(JSON.parse(result.value.stderr_head).error.code, 'pane_not_found');
});

test('herdr failure is a runtime error not absent', () => {
  for (const step of [
    { stdout: '', stderr: JSON.stringify({ error: { code: 'server_not_running' } }), exit: 1 },
    { stdout: '', stderr: JSON.stringify({ error: { code: 'transport_error' } }), exit: 1 },
    { stdout: { result: { pane } }, stderr: JSON.stringify({ error: { code: 'server_not_running' } }), exit: 1 },
    { stdout: '', exit: 1, stderr: 'connection refused' },
    { stdout: 'not JSON', exit: 0 },
    { stdout: { result: {} }, exit: 0 },
    { stdout: '', stderr: JSON.stringify(absent), exit: 0 },
    { stdout: '', stderr: JSON.stringify(absent), exit: 255 },
    { stdout: { result: { pane: { ...pane, terminal_id: null } } }, exit: 0 },
    { stdout: { result: { pane: { ...pane, pane_id: 'another-pane' } } }, exit: 0 },
  ]) {
    assert.deepEqual(invoke('getPane', ['wH:p2'], [{ args: ['pane', 'get', 'wH:p2'], ...step }]), {
      ok: false,
      error: 'cannot confirm pane ended: herdr pane get failed',
    });
  }
});

test('getPane bounds a hung herdr call to 15 seconds', () => {
  assert.deepEqual(
    invoke(
      'getPane',
      ['wH:p2'],
      [{ args: ['pane', 'get', 'wH:p2'], stdout: '', stderr: JSON.stringify(absent), exit: 1, delayMs: 16_000 }],
    ),
    { ok: false, error: 'cannot confirm pane ended: herdr pane get failed' },
  );
});

test('listPanes and listWorkspaces parse herdr envelopes', () => {
  assert.deepEqual(invoke('listPanes', [], [reply(['pane', 'list'], { panes: [pane] })]), { ok: true, value: [pane] });
  assert.deepEqual(
    invoke(
      'listWorkspaces',
      [],
      [
        reply(['workspace', 'list'], {
          workspaces: [{ workspace_id: 'wH', label: 'ss-ciops', focused: true }],
        }),
      ],
    ),
    { ok: true, value: [{ workspace_id: 'wH', label: 'ss-ciops' }] },
  );
  for (const [method, command, field] of [
    ['listPanes', 'pane', 'panes'],
    ['listWorkspaces', 'workspace', 'workspaces'],
  ]) {
    assert.equal(invoke(method, [], [reply([command, 'list'], { [field]: null })]).ok, false);
  }
});

const createArgs = [
  'tab',
  'create',
  '--workspace',
  'wH',
  '--cwd',
  '/work/tree with spaces',
  '--label',
  'run-1',
  '--no-focus',
];
const options = { workspace: 'wH', cwd: '/work/tree with spaces', label: 'run-1' };
const tab = { tab_id: 'wH:t2', workspace_id: 'wH', label: 'run-1' };

test('createTab resolves pane via tab label', () => {
  assert.deepEqual(
    invoke(
      'createTab',
      [options],
      [
        reply(createArgs, { type: 'tab_created' }),
        reply(['tab', 'list'], { tabs: [{ ...tab, workspace_id: 'w0', tab_id: 'w0:t2' }, tab] }),
        reply(['pane', 'list'], { panes: [{ ...pane, tab_id: 'wH:other' }, pane] }),
      ],
    ),
    { ok: true, value: { tabId: 'wH:t2', paneId: 'wH:p2', terminalId: 'term_2' } },
  );
});

test('createTab refuses missing or ambiguous tabs and panes', () => {
  for (const tabs of [[], [tab, tab]]) {
    assert.match(
      invoke('createTab', [options], [reply(createArgs, { type: 'tab_created' }), reply(['tab', 'list'], { tabs })])
        .error,
      /cannot resolve herdr tab/,
    );
  }
  for (const panes of [[], [pane, { ...pane, pane_id: 'wH:p3' }]]) {
    assert.match(
      invoke(
        'createTab',
        [options],
        [
          reply(createArgs, { type: 'tab_created' }),
          reply(['tab', 'list'], { tabs: [tab] }),
          reply(['pane', 'list'], { panes }),
        ],
      ).error,
      /cannot resolve exactly one herdr pane/,
    );
  }
});

test('startAgent, promptAgent and closePane preserve argv and return captured output', () => {
  const args = ['--model', 'test-model', '--cwd', '/work/tree with spaces'];
  const prompt = 'Read /packet/card.md; do not interpret shell syntax $(echo unsafe)';
  for (const [method, input, argv] of [
    [
      'startAgent',
      [{ name: 'run-1', kind: 'omp', pane: 'wH:p2', args }],
      ['agent', 'start', 'run-1', '--kind', 'omp', '--pane', 'wH:p2', '--timeout', '60000', '--', ...args],
    ],
    [
      'promptAgent',
      ['run-1', prompt],
      ['agent', 'prompt', 'run-1', prompt, '--wait', '--until', 'working', '--timeout', '15000'],
    ],
    ['closePane', ['wH:p2'], ['pane', 'close', 'wH:p2']],
  ] as const) {
    const result = invoke(method, [...input], [reply([...argv], { type: 'ok' })]);
    assert.equal(result.ok, true);
    assert.equal(result.value.ok, true);
    assert.equal(result.value.code, 0);
    assert.equal(JSON.parse(result.value.stdout).result.type, 'ok');
    assert.match(
      invoke(method, [...input], [{ args: [...argv], stdout: { error: { code: 'transport_error' } }, exit: 1 }]).error,
      /herdr .* failed/,
    );
  }
});

test('startAgent allows readiness beyond the 15-second probe timeout', () => {
  const result = invoke(
    'startAgent',
    [{ name: 'run-1', kind: 'omp', pane: 'wH:p2' }],
    [
      {
        ...reply(['agent', 'start', 'run-1', '--kind', 'omp', '--pane', 'wH:p2', '--timeout', '60000', '--'], {
          type: 'ok',
        }),
        delayMs: 16_000,
      },
    ],
  );
  assert.equal(result.ok, true);
  assert.equal(result.value.code, 0);
});

test('promptAgent allows herdr to return after its 15-second wait', () => {
  const result = invoke(
    'promptAgent',
    ['run-1', 'Read the packet.'],
    [
      {
        ...reply(
          ['agent', 'prompt', 'run-1', 'Read the packet.', '--wait', '--until', 'working', '--timeout', '15000'],
          { type: 'ok' },
        ),
        delayMs: 16_000,
      },
    ],
  );
  assert.equal(result.ok, true);
  assert.equal(result.value.code, 0);
});

test('failed commands retain exit code and bounded stderr in their cause', () => {
  const result = invoke(
    'closePane',
    ['wH:p2'],
    [{ args: ['pane', 'close', 'wH:p2'], stdout: '', exit: 2, stderr: 'connection refused' }],
    true,
  );
  assert.equal(result.error, 'herdr pane close failed');
  assert.equal(result.cause, 'herdr command exited 2; stderr: connection refused');
  const longStderr = 'x'.repeat(2048);
  const bounded = invoke(
    'closePane',
    ['wH:p2'],
    [{ args: ['pane', 'close', 'wH:p2'], stdout: '', exit: 2, stderr: longStderr }],
    true,
  );
  assert.equal(bounded.cause, `herdr command exited 2; stderr: ${longStderr.slice(0, 1024)}`);
});
