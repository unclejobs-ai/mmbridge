import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { openApsDb } from '@mmbridge/aps';
import addFormats from 'ajv-formats';
import { Ajv2020 } from 'ajv/dist/2020.js';
import fc from 'fast-check';
import { compareMetric } from '../dist/commands/aps-gate-metrics.js';
import schema from '../dist/commands/aps-gate-schema.js';
import type { Gate, Metric } from '../src/commands/aps-gate-config.ts';

const bin = resolve(import.meta.dirname, '../dist/bin/mmbridge.js');
const gate: Gate = {
  id: 'static.complexity',
  item: 3,
  title: 'Complexity',
  mode: 'ratchet',
  run: { argv: [process.execPath, '-e', 'console.log(JSON.stringify({count:5}))'] },
  metrics: [{ id: 'count', source: { kind: 'json', pointer: '/count' }, direction: 'lower' }],
};
const ajv = new Ajv2020({ strict: false });
addFormats.default(ajv);
ajv.addSchema(schema);
const validResult = ajv.compile({ $ref: `${schema.$id}#/$defs/gateResult` });

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'aps-gate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.aps'));
  function git(args: string[]) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  git(['init', '--quiet']);
  git(['config', 'user.name', 'APS gate test']);
  git(['config', 'user.email', 'aps-gate@example.invalid']);
  git(['commit', '--quiet', '--allow-empty', '-m', 'test: initial']);
  const sha = git(['rev-parse', 'HEAD']);
  function file(name: string, value: unknown) {
    writeFileSync(join(root, '.aps', name), JSON.stringify(value));
  }
  function config(gates: Gate[] = [structuredClone(gate)]) {
    file('gates.json', { version: 1, repo: 'test/repo', gates });
  }
  function baseline(value = 5, id = gate.id, metric = 'count') {
    file('baseline.json', {
      version: 1,
      gates: { [id]: { [metric]: { value, sha, measuredAt: '2026-10-11T00:00:00Z' } } },
    });
  }
  function commit() {
    git(['add', '.']);
    git(['commit', '--quiet', '-m', 'test: gate input']);
    return git(['rev-parse', 'HEAD']);
  }
  function run(args: string[] = [], code = 0, json = true) {
    const result = spawnSync(process.execPath, [bin, 'aps', 'gate', ...args, ...(json ? ['--json'] : [])], {
      cwd: root,
      env: { ...process.env, HOME: root, APS_AGENT: '', NODE_NO_WARNINGS: '1' },
      encoding: 'utf8',
    });
    assert.equal(result.status, code, `${result.stdout}\n${result.stderr}`);
    const value = json && result.stdout.trim() ? JSON.parse(result.stdout) : null;
    if (value?.schema) assert.ok(validResult(value), ajv.errorsText(validResult.errors));
    return { ...result, value };
  }
  return { root, file, config, baseline, commit, run, git };
}
function exemption(overrides: Record<string, unknown> = {}) {
  const today = new Date().toISOString().slice(0, 10);
  return {
    id: 'EX-20261011-01',
    gate: gate.id,
    effect: 'waive',
    reason: 'Approved boundary exception',
    approvedBy: 'owner',
    approvalRef: 'IN-20261011-APS-SE',
    createdAt: today,
    expiresAt: today,
    ...overrides,
  };
}

test('gate help is independent of a ledger or agent', (t) => {
  const f = fixture(t);
  assert.match(f.run(['--help'], 0, false).stdout, /--update-baseline/);
});

test('missing config, invalid flags/format/ref and malformed JSON use exit 2', (t) => {
  const f = fixture(t);
  f.run([], 2);
  f.run(['--unknown'], 2, false);
  f.run(['--format', 'xml'], 2);
  f.config();
  f.baseline();
  f.run(['--base-ref', 'missing-ref'], 2);
  writeFileSync(join(f.root, '.aps/gates.json'), '{');
  f.run([], 2);
});

for (const [label, change] of [
  [
    'unknown config keys',
    (g: Record<string, unknown>) => {
      g.extra = true;
    },
  ],
  [
    'version mismatch',
    (g: Record<string, unknown>) => {
      g.version = 2;
    },
  ],
  [
    'empty gates',
    (g: Record<string, unknown>) => {
      g.gates = [];
    },
  ],
  [
    'family mismatch',
    (g: Record<string, unknown>) => {
      (g.gates as Gate[])[0].item = 1;
    },
  ],
  [
    'duplicate gate',
    (g: Record<string, unknown>) => {
      (g.gates as Gate[]).push(structuredClone(gate));
    },
  ],
  [
    'empty argv',
    (g: Record<string, unknown>) => {
      (g.gates as Gate[])[0].run.argv = [];
    },
  ],
  [
    'absolute cwd',
    (g: Record<string, unknown>) => {
      (g.gates as Gate[])[0].run.cwd = '/tmp';
    },
  ],
  [
    'escaping cwd',
    (g: Record<string, unknown>) => {
      (g.gates as Gate[])[0].run.cwd = '../';
    },
  ],
  [
    'invalid regex',
    (g: Record<string, unknown>) => {
      (g.gates as Gate[])[0].metrics = [{ id: 'm', direction: 'lower', source: { kind: 'regex', pattern: '[' } }];
    },
  ],
  [
    'duplicate metric',
    (g: Record<string, unknown>) => {
      (g.gates as Gate[])[0].metrics?.push(structuredClone(gate.metrics?.[0] as Metric));
    },
  ],
  [
    'inverted threshold',
    (g: Record<string, unknown>) => {
      const m = (g.gates as Gate[])[0].metrics?.[0] as Metric;
      m.min = 10;
      m.max = 1;
    },
  ],
  [
    'bad pointer',
    (g: Record<string, unknown>) => {
      ((g.gates as Gate[])[0].metrics?.[0] as Metric).source.pointer = '/bad~2key';
    },
  ],
] as const)
  test(`config validation: ${label}`, (t) => {
    const f = fixture(t);
    const config: Record<string, unknown> = { version: 1, repo: 'test/repo', gates: [structuredClone(gate)] };
    change(config);
    f.file('gates.json', config);
    f.run([], 2);
  });

test('baseline/exemption documents validated and symlink escape rejected', (t) => {
  const f = fixture(t);
  f.config();
  f.file('baseline.json', { version: 1, gates: { [gate.id]: { count: { value: 5 } } } });
  f.run([], 2);
  f.baseline();
  f.file('exemptions.json', {
    version: 1,
    exemptions: [exemption({ createdAt: '2026-01-01', expiresAt: '2026-03-01' })],
  });
  f.run([], 2);
  rmSync(join(f.root, '.aps/exemptions.json'));
  symlinkSync(tmpdir(), join(f.root, 'outside'));
  const escaped = structuredClone(gate);
  escaped.run.cwd = 'outside';
  f.config([escaped]);
  f.run([], 2);
});

test('local ratchet passes equality/improvement and fails regression without writing baseline', (t) => {
  const f = fixture(t);
  f.config();
  f.baseline();
  const original = readFileSync(join(f.root, '.aps/baseline.json'), 'utf8');
  const equal = f.run().value;
  assert.equal(equal.gates[0].metrics[0].baselineSource, 'head');
  assert.match(equal.warnings[0], /local-mode/);
  f.baseline(6);
  assert.equal(f.run().value.gates[0].metrics[0].improved, true);
  f.baseline(4);
  assert.equal(f.run([], 1).value.gates[0].metrics[0].status, 'fail');
  f.baseline();
  assert.equal(readFileSync(join(f.root, '.aps/baseline.json'), 'utf8'), original);
});

test('base-ref baseline wins over a loosened head baseline', (t) => {
  const f = fixture(t);
  f.config();
  f.baseline(4);
  const base = f.commit();
  f.baseline(100);
  const result = f.run(['--base-ref', base], 1).value;
  assert.equal(result.gates[0].metrics[0].baseline, 4);
  assert.equal(result.gates[0].metrics[0].baselineSource, 'base');
});

test('new baseline keys must match seed in CI; missing keys fail until explicit bootstrap', (t) => {
  const f = fixture(t);
  f.config();
  const base = f.commit();
  assert.equal(f.run(['--base-ref', base], 1).value.gates[0].metrics[0].status, 'no-baseline');
  f.baseline(6);
  assert.equal(f.run(['--base-ref', base], 1).value.gates[0].metrics[0].status, 'seed-mismatch');
  f.baseline(5);
  assert.equal(f.run(['--base-ref', base]).value.gates[0].metrics[0].baselineSource, 'head-seed');
  rmSync(join(f.root, '.aps/baseline.json'));
  assert.equal(f.run(['--base-ref', base, '--update-baseline']).value.baselineUpdated, true);
  assert.equal(JSON.parse(readFileSync(join(f.root, '.aps/baseline.json'), 'utf8')).gates[gate.id].count.value, 5);
});

test('updates tighten monotonically, preserve tolerated worse values and refuse regression atomically', (t) => {
  const f = fixture(t);
  f.config();
  f.baseline(6);
  assert.equal(f.run(['--update-baseline']).value.baselineUpdated, true);
  const first = JSON.parse(readFileSync(join(f.root, '.aps/baseline.json'), 'utf8'));
  assert.equal(first.gates[gate.id].count.value, 5);
  assert.equal(first.gates[gate.id].count.sha, f.git(['rev-parse', 'HEAD']));
  const tolerant = structuredClone(gate);
  (tolerant.metrics?.[0] as Metric).tolerance = 1;
  f.config([tolerant]);
  f.baseline(4);
  f.run(['--update-baseline']);
  assert.equal(JSON.parse(readFileSync(join(f.root, '.aps/baseline.json'), 'utf8')).gates[gate.id].count.value, 4);
  f.config();
  const before = readFileSync(join(f.root, '.aps/baseline.json'), 'utf8');
  assert.equal(f.run(['--update-baseline'], 1).value.baselineUpdated, false);
  assert.equal(readFileSync(join(f.root, '.aps/baseline.json'), 'utf8'), before);
});

test('one failing metric prevents every baseline update, including an improving metric', (t) => {
  const f = fixture(t);
  const second = structuredClone(gate);
  second.id = 'static.duplication';
  f.config([gate, second]);
  const sha = f.git(['rev-parse', 'HEAD']);
  f.file('baseline.json', {
    version: 1,
    gates: {
      [gate.id]: { count: { value: 6, sha, measuredAt: new Date().toISOString() } },
      [second.id]: { count: { value: 4, sha, measuredAt: new Date().toISOString() } },
    },
  });
  const before = readFileSync(join(f.root, '.aps/baseline.json'), 'utf8');
  f.run(['--update-baseline'], 1);
  assert.equal(readFileSync(join(f.root, '.aps/baseline.json'), 'utf8'), before);
});

test('thresholds enforce inclusive bounds while targets are advisory; warn/report never block', (t) => {
  const f = fixture(t);
  const threshold = structuredClone(gate);
  threshold.mode = 'threshold';
  Object.assign(threshold.metrics?.[0] as Metric, { min: 5, max: 5, target: 0 });
  f.config([threshold]);
  f.run();
  (threshold.metrics?.[0] as Metric).max = 4;
  (threshold.metrics?.[0] as Metric).min = undefined;
  f.config([threshold]);
  f.run([], 1);
  threshold.enforcement = 'warn';
  f.config([threshold]);
  assert.equal(f.run().value.gates[0].status, 'fail');
  threshold.mode = 'report';
  threshold.enforcement = 'block';
  f.config([threshold]);
  assert.equal(f.run().value.gates[0].enforcement, 'warn');
});

test('required exit failures are fail, metric tool failures are error; accepted nonzero exits pass', (t) => {
  const f = fixture(t);
  const required = structuredClone(gate);
  required.mode = 'required';
  required.metrics = undefined;
  required.run.argv = [process.execPath, '-e', 'process.exit(7)'];
  f.config([required]);
  assert.equal(f.run([], 1).value.gates[0].status, 'fail');
  required.run.okExitCodes = [7];
  f.config([required]);
  f.run();
  required.mode = 'threshold';
  required.metrics = [{ id: 'exit', direction: 'lower', source: { kind: 'exit-code' }, max: 7 }];
  f.config([required]);
  assert.equal(f.run().value.gates[0].metrics[0].value, 7);
  required.run.okExitCodes = undefined;
  f.config([required]);
  assert.equal(f.run([], 1).value.gates[0].status, 'error');
});

test('timeout, spawn failure and extraction failure are fail-closed errors', (t) => {
  const f = fixture(t);
  const failed = structuredClone(gate);
  failed.run.argv = ['aps-test-command-does-not-exist'];
  f.config([failed]);
  assert.equal(f.run([], 1).value.gates[0].status, 'error');
  // Integration timeout: a separately spawned process cannot share this test's fake clock.
  failed.run.argv = [process.execPath, '-e', 'setTimeout(()=>{},60000)'];
  failed.run.timeoutSec = 1;
  f.config([failed]);
  assert.equal(f.run([], 1).value.gates[0].status, 'error');
  failed.run.argv = [process.execPath, '-e', 'console.log("not-json")'];
  f.config([failed]);
  assert.equal(f.run([], 1).value.gates[0].metrics[0].status, 'error');
});

test('JSON pointers, arrays, regex, filtered lines and metric files extract correctly', (t) => {
  const f = fixture(t);
  mkdirSync(join(f.root, 'tools'));
  writeFileSync(join(f.root, 'tools/report.txt'), 'hit one\n\nmiss\nhit two\n');
  const measured = structuredClone(gate);
  measured.mode = 'threshold';
  measured.run.cwd = 'tools';
  measured.run.argv = [process.execPath, '-e', 'console.log(JSON.stringify({"a/b":{"~k":[1,2,3]},score:42}))'];
  measured.metrics = [
    { id: 'array', direction: 'lower', source: { kind: 'json', pointer: '/a~1b/~0k' }, min: 3, max: 3 },
    { id: 'regex', direction: 'higher', source: { kind: 'regex', pattern: 'score\\":(\\d+)' }, min: 42 },
    { id: 'lines', direction: 'lower', source: { kind: 'count-lines', file: 'report.txt', pattern: '^hit' }, max: 2 },
  ];
  f.config([measured]);
  assert.deepEqual(
    f.run().value.gates[0].metrics.map((m: { value: number }) => m.value),
    [3, 42, 2],
  );
});

test('nonfinite/non-numeric/missing metrics fail extraction rather than silently becoming zero', (t) => {
  const f = fixture(t);
  for (const output of ['{}', '{"count":"5"}', '{"count":null}']) {
    const bad = structuredClone(gate);
    bad.run.argv = [process.execPath, '-e', `console.log(${JSON.stringify(output)})`];
    f.config([bad]);
    assert.equal(f.run([], 1).value.gates[0].metrics[0].status, 'error');
  }
  const bad = structuredClone(gate);
  (bad.metrics?.[0] as Metric).source = { kind: 'regex', pattern: '(\\d+)' };
  bad.run.argv = [process.execPath, '-e', 'console.log("9".repeat(400))'];
  f.config([bad]);
  f.run([], 1);
});

test('changed-path conditions use merge-base and always run in local mode', (t) => {
  const f = fixture(t);
  const conditional = structuredClone(gate);
  conditional.mode = 'required';
  conditional.metrics = undefined;
  conditional.when = { changedPaths: ['src/**/*.ts'] };
  f.config([conditional]);
  const base = f.commit();
  assert.equal(f.run(['--base-ref', base]).value.gates[0].status, 'skipped');
  assert.equal(f.run().value.gates[0].status, 'pass');
  mkdirSync(join(f.root, 'src'));
  writeFileSync(join(f.root, 'src/a.ts'), 'export const value = 1;');
  f.commit();
  assert.equal(f.run(['--base-ref', base]).value.gates[0].status, 'pass');
});

test('head-only exemptions are pending in CI; approved base exemptions waive regressions', (t) => {
  const f = fixture(t);
  f.config();
  f.baseline(4);
  const base = f.commit();
  f.file('exemptions.json', { version: 1, exemptions: [exemption()] });
  const pending = f.run(['--base-ref', base], 1).value;
  assert.match(pending.warnings.join(' '), /pending-exemption/);
  assert.equal(f.run().value.gates[0].status, 'exempt');
  const approved = f.commit();
  assert.equal(f.run(['--base-ref', approved]).value.gates[0].status, 'exempt');
  const before = readFileSync(join(f.root, '.aps/baseline.json'), 'utf8');
  f.run(['--base-ref', approved, '--update-baseline'], 1);
  assert.equal(readFileSync(join(f.root, '.aps/baseline.json'), 'utf8'), before);
});

test('allow exemption replaces bounds; expiry ignored; extraction/tool errors cannot be waived', (t) => {
  const f = fixture(t);
  const constrained = structuredClone(gate);
  (constrained.metrics?.[0] as Metric).max = 3;
  f.config([constrained]);
  f.baseline(3);
  f.file('exemptions.json', { version: 1, exemptions: [exemption({ metric: 'count', effect: 'allow', allow: 5 })] });
  assert.equal(f.run().value.gates[0].metrics[0].baselineSource, 'exemption');
  f.file('exemptions.json', {
    version: 1,
    exemptions: [exemption({ createdAt: '2020-01-01', expiresAt: '2020-01-02' })],
  });
  assert.match(f.run([], 1).value.warnings.join(' '), /expired-exemption/);
  f.file('exemptions.json', { version: 1, exemptions: [exemption()] });
  constrained.run.argv = [process.execPath, '-e', 'console.log("invalid")'];
  f.config([constrained]);
  assert.equal(f.run([], 1).value.gates[0].status, 'error');
  constrained.mode = 'required';
  constrained.metrics = undefined;
  constrained.run.argv = [process.execPath, '-e', 'process.exit(1)'];
  f.config([constrained]);
  assert.equal(f.run().value.gates[0].status, 'exempt');
});

test('literal environment, no shell and human table/--format json outputs', (t) => {
  const f = fixture(t);
  const required = structuredClone(gate);
  required.mode = 'required';
  required.metrics = undefined;
  required.run.argv = [
    process.execPath,
    '-e',
    'if(process.env.APS_GATE_LITERAL!==process.argv[1])process.exit(1)',
    '$HOME; echo not-executed',
  ];
  required.run.env = { APS_GATE_LITERAL: '$HOME; echo not-executed' };
  f.config([required]);
  assert.match(f.run([], 0, false).stdout, /APS gates: PASS/);
  const result = f.run(['--format', 'json'], 0, false);
  assert.equal(JSON.parse(result.stdout).schema, 'aps-gate-result/1');
});

test('--card appends exact result on the current attempt without changing state', (t) => {
  const f = fixture(t);
  const required = structuredClone(gate);
  required.mode = 'required';
  required.metrics = undefined;
  f.config([required]);
  const dbPath = join(f.root, 'ledger.db');
  const db = openApsDb(dbPath);
  db.exec(`INSERT INTO projects(id,prefix,name) VALUES('test','TEST','test');
    INSERT INTO agents(id,name,layer,model,vendor) VALUES('manager','manager','L2','local','local'),('worker','worker','L3','local','local');
    INSERT INTO cards(id,project,title,kind,size,scope,acceptance_json,forbidden,needs_owner,needs_vision,layer_owner,assignee)
    VALUES('TEST-C-0001','test','gate','mech','S','scope','[{"id":"AC1","text":"gates","command":"mmbridge aps gate","expect":"exit 0"}]','none',0,0,'manager','worker');`);
  const before = db.prepare('SELECT state,attempt FROM cards').get();
  const result = f.run(['--card', 'TEST-C-0001', '--db', dbPath, '--by', 'worker']).value;
  const link = db.prepare('SELECT attempt,kind,ref,detail_json FROM card_links').get() as {
    attempt: number;
    kind: string;
    ref: string;
    detail_json: string;
  };
  assert.equal(link.kind, 'other');
  assert.equal(link.ref, `aps-gate:${result.runId}`);
  assert.equal(link.attempt, before?.attempt);
  assert.deepEqual(JSON.parse(link.detail_json), result);
  assert.deepEqual(db.prepare('SELECT state,attempt FROM cards').get(), before);
  db.close();
});

test('higher-direction baseline updates tighten with max and refuse decreases', (t) => {
  const f = fixture(t);
  const higher = structuredClone(gate);
  (higher.metrics?.[0] as Metric).direction = 'higher';
  f.config([higher]);
  f.baseline(4);
  f.run(['--update-baseline']);
  assert.equal(JSON.parse(readFileSync(join(f.root, '.aps/baseline.json'), 'utf8')).gates[gate.id].count.value, 5);
  f.baseline(6);
  const before = readFileSync(join(f.root, '.aps/baseline.json'), 'utf8');
  f.run(['--update-baseline'], 1);
  assert.equal(readFileSync(join(f.root, '.aps/baseline.json'), 'utf8'), before);
});

test('missing cwd/file are execution/extraction errors and internal report symlinks are allowed', (t) => {
  const f = fixture(t);
  const measured = structuredClone(gate);
  measured.run.cwd = 'missing';
  (measured.metrics?.[0] as Metric).source.file = 'report.json';
  f.config([measured]);
  assert.equal(f.run([], 1).value.gates[0].status, 'error');
  measured.run.cwd = '.';
  f.config([measured]);
  assert.equal(f.run([], 1).value.gates[0].metrics[0].status, 'error');
  mkdirSync(join(f.root, 'reports'));
  writeFileSync(join(f.root, 'reports/data.json'), '{"count":5}');
  symlinkSync('reports/data.json', join(f.root, 'report.json'));
  f.baseline();
  assert.equal(f.run().value.gates[0].status, 'pass');
});

test('ratchet boundaries satisfy both directional invariants (property based)', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: -10000, max: 10000 }),
      fc.integer({ min: -10000, max: 10000 }),
      fc.integer({ min: 0, max: 100 }),
      (value, baseline, tolerance) => {
        for (const direction of ['lower', 'higher'] as const) {
          const metric: Metric = { id: 'count', source: { kind: 'exit-code' }, direction, tolerance };
          const prior = { value: baseline, sha: 'a'.repeat(40), measuredAt: '2026-10-11T00:00:00Z' };
          const result = compareMetric(gate, metric, value, prior, undefined, true);
          const fail = direction === 'lower' ? value > baseline + tolerance : value < baseline - tolerance;
          assert.equal(result.status, fail ? 'fail' : 'pass');
          const seed = compareMetric(gate, metric, value, undefined, prior, true);
          assert.equal(seed.status, Math.abs(value - baseline) > tolerance ? 'seed-mismatch' : 'pass');
        }
      },
    ),
    { numRuns: 500 },
  );
});
