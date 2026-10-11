import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { openApsDb } from '@mmbridge/aps';
import { redactContent } from '@mmbridge/core';
import addFormats from 'ajv-formats';
import { Ajv2020 } from 'ajv/dist/2020.js';
import fc from 'fast-check';
import { GATE_TOKEN_RULES, redactBoundedText } from '../dist/commands/aps-gate-ledger.js';
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
  f.commit();
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
  const base = f.commit();
  const dbPath = join(f.root, 'ledger.db');
  const db = openApsDb(dbPath);
  db.exec(`INSERT INTO projects(id,prefix,name) VALUES('test','TEST','test');
    INSERT INTO agents(id,name,layer,model,vendor) VALUES('manager','manager','L2','local','local'),('worker','worker','L3','local','local');
    INSERT INTO cards(id,project,title,kind,size,scope,acceptance_json,forbidden,needs_owner,needs_vision,layer_owner,assignee)
    VALUES('TEST-C-0001','test','gate','mech','S','scope','[{"id":"AC1","text":"gates","command":"mmbridge aps gate","expect":"exit 0"}]','none',0,0,'manager','worker');`);
  const before = db.prepare('SELECT state,attempt FROM cards').get();
  const result = f.run(['--card', 'TEST-C-0001', '--db', dbPath, '--by', 'worker', '--base-ref', base]).value;
  const link = db.prepare('SELECT attempt,kind,ref,detail_json FROM card_links').get() as {
    attempt: number;
    kind: string;
    ref: string;
    detail_json: string;
  };
  assert.equal(link.kind, 'other');
  assert.equal(link.ref, `aps-gate:${result.runId}`);
  assert.equal(link.attempt, before?.attempt);
  const expectedDetail = structuredClone(result);
  for (const g of expectedDetail.gates) {
    g.stdout = undefined;
    g.stderr = undefined;
  }
  const actualDetail = JSON.parse(link.detail_json);
  for (const g of actualDetail.gates) {
    g.stdout = undefined;
    g.stderr = undefined;
  }
  assert.deepEqual(actualDetail, expectedDetail);
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
test('H1: base-ref mode binds gate config to base and rejects relaxed or missing gates/metrics', (t) => {
  const f = fixture(t);
  const baseGate = structuredClone(gate);
  baseGate.run.timeoutSec = 100;
  baseGate.metrics = [
    { id: 'count', source: { kind: 'json', pointer: '/count' }, direction: 'lower', tolerance: 0, min: 0, max: 10 },
  ];
  f.config([baseGate]);
  const base = f.commit();

  // Test 1: missing gate in head fails
  const headGate = structuredClone(baseGate);
  headGate.id = 'static.other';
  f.config([headGate]);
  f.commit();
  const resMissing = f.run(['--base-ref', base], 1).value;
  assert.equal(resMissing.verdict, 'fail');
  assert.match(resMissing.gates.find((g: Gate) => g.id === baseGate.id)?.message, /missing in head/i);

  // Test 2: relaxed timeoutSec in head fails
  const relaxedTimeout = structuredClone(baseGate);
  relaxedTimeout.run.timeoutSec = 200;
  f.config([relaxedTimeout]);
  f.commit();
  const resTimeout = f.run(['--base-ref', base], 1).value;
  assert.equal(resTimeout.verdict, 'fail');
  assert.match(resTimeout.gates[0].message, /timeoutSec raised/);

  // Test 3: relaxed tolerance in head fails
  const relaxedTol = structuredClone(baseGate);
  if (relaxedTol.metrics?.[0]) relaxedTol.metrics[0].tolerance = 5;
  f.config([relaxedTol]);
  f.commit();
  const resTol = f.run(['--base-ref', base], 1).value;
  assert.equal(resTol.verdict, 'fail');
  assert.match(resTol.gates[0].message, /tolerance raised/);

  // Test 4: approval exemption on base waives the relaxation
  f.file('exemptions.json', { version: 1, exemptions: [exemption({ gate: baseGate.id, metric: undefined })] });
  const approvedBase = f.commit();
  const resWaived = f.run(['--base-ref', approvedBase], 0).value;
  assert.equal(resWaived.verdict, 'pass');

  f.git(['rm', '-f', '.aps/exemptions.json']);
  const relaxedMode = structuredClone(baseGate);
  relaxedMode.mode = 'report';
  f.config([relaxedMode]);
  f.commit();
  assert.match(f.run(['--base-ref', base], 1).value.gates[0].message, /mode changed/);

  const relaxedMin = structuredClone(baseGate);
  if (relaxedMin.metrics?.[0]) relaxedMin.metrics[0].min = -1;
  f.config([relaxedMin]);
  f.commit();
  assert.match(f.run(['--base-ref', base], 1).value.gates[0].message, /min bound loosened/);

  const relaxedMax = structuredClone(baseGate);
  if (relaxedMax.metrics?.[0]) relaxedMax.metrics[0].max = 20;
  f.config([relaxedMax]);
  f.commit();
  assert.match(f.run(['--base-ref', base], 1).value.gates[0].message, /max bound loosened/);

  const relaxedEnforcement = structuredClone(baseGate);
  relaxedEnforcement.enforcement = 'warn';
  f.config([relaxedEnforcement]);
  f.commit();
  assert.match(f.run(['--base-ref', base], 1).value.gates[0].message, /enforcement relaxed/);

  const relaxedCodes = structuredClone(baseGate);
  relaxedCodes.run.okExitCodes = [0, 2];
  f.config([relaxedCodes]);
  f.commit();
  assert.match(f.run(['--base-ref', base], 1).value.gates[0].message, /okExitCodes widened/);

  const pathGate = structuredClone(baseGate);
  pathGate.when = { changedPaths: ['src/**', 'lib/**'] };
  f.config([pathGate]);
  const pathBase = f.commit();
  const narrowed = structuredClone(pathGate);
  narrowed.when = { changedPaths: ['src/**'] };
  f.config([narrowed]);
  f.commit();
  assert.match(f.run(['--base-ref', pathBase], 1).value.gates[0].message, /changedPaths narrowed/);

  f.config([baseGate]);
  f.file('baseline.json', {
    version: 1,
    gates: { [baseGate.id]: { count: { value: 4, sha: 'a'.repeat(40), measuredAt: '2026-10-11T00:00:00Z' } } },
  });
  const baselineBase = f.commit();
  f.file('gates.json', {
    version: 1,
    repo: 'test/repo',
    baselineFile: '.aps/baseline-v2.json',
    gates: [baseGate],
  });
  f.file('baseline-v2.json', {
    version: 1,
    gates: { [baseGate.id]: { count: { value: 5, sha: 'a'.repeat(40), measuredAt: '2026-10-11T00:00:00Z' } } },
  });
  f.commit();
  const redirected = f.run(['--base-ref', baselineBase], 1).value;
  assert.equal(redirected.gates[0].metrics[0].baseline, 4);
  assert.equal(redirected.gates[0].metrics[0].baselineSource, 'base');
});

test('H2: base-ref mode fails when head baseline loosens or deletes a base key', (t) => {
  const f = fixture(t);
  f.config();
  f.baseline(5);
  const base = f.commit();

  // Loosen baseline in head (higher value for lower direction)
  f.baseline(10);
  f.commit();
  const resLoosened = f.run(['--base-ref', base], 1).value;
  assert.equal(resLoosened.verdict, 'fail');
  assert.match(resLoosened.warnings.join(' '), /head-baseline-loosened/);

  // Delete baseline key in head
  f.file('baseline.json', { version: 1, gates: {} });
  f.commit();
  const resDeleted = f.run(['--base-ref', base], 1).value;
  assert.equal(resDeleted.verdict, 'fail');
  assert.match(resDeleted.warnings.join(' '), /head-baseline-loosened.*deleted/);
});

test('M1: dirty tracked files fail with exit 2 under --base-ref or --card', (t) => {
  const f = fixture(t);
  f.config();
  f.baseline(5);
  const base = f.commit();

  // Dirty tracked file
  writeFileSync(join(f.root, 'dirty.txt'), 'hello');
  f.git(['add', 'dirty.txt']);
  const resBase = f.run(['--base-ref', base], 2);
  assert.match(resBase.stdout, /tracked files dirty/);

  // Untracked file does not trigger dirty error
  f.git(['reset', '--hard', 'HEAD']);
  writeFileSync(join(f.root, 'untracked.txt'), 'hello');
  const resClean = f.run(['--base-ref', base], 0);
  assert.equal(resClean.value.verdict, 'pass');

  // Baseline dirtiness is exempt only when this run writes it.
  const baselinePath = join(f.root, '.aps/baseline.json');
  writeFileSync(baselinePath, `${readFileSync(baselinePath, 'utf8')}\n`);
  const resDirtyBaseline = f.run(['--base-ref', base], 2);
  assert.match(resDirtyBaseline.stdout, /tracked files dirty/);
  const resUpdate = f.run(['--base-ref', base, '--update-baseline'], 0);
  assert.equal(resUpdate.value.baselineUpdated, true);
});

test('M2: git diff detects renames with old and new paths via --no-renames', (t) => {
  const f = fixture(t);
  const condGate = structuredClone(gate);
  condGate.mode = 'required';
  condGate.metrics = undefined;
  condGate.when = { changedPaths: ['old-dir/**'] };
  f.config([condGate]);
  mkdirSync(join(f.root, 'old-dir'));
  writeFileSync(join(f.root, 'old-dir/file.txt'), 'content');
  const base = f.commit();

  // Rename old-dir/file.txt to new-dir/file.txt
  f.git(['mv', 'old-dir', 'new-dir']);
  f.commit();
  // Gate watching old-dir/** should still trigger because old path is in diff
  const res = f.run(['--base-ref', base], 0).value;
  assert.equal(res.gates[0].status, 'pass');
});

test('M3: stdout/stderr capped to 8 KiB tail on fail/error, omitted on card link', (t) => {
  const f = fixture(t);
  const failGate = structuredClone(gate);
  failGate.mode = 'required';
  failGate.metrics = undefined;
  // Gate that produces > 10 KiB output and exits 1
  failGate.run.argv = [
    process.execPath,
    '-e',
    'console.log("X".repeat(12000) + "TAIL_STDOUT"); console.error("Y".repeat(12000) + "TAIL_STDERR"); process.exit(1);',
  ];
  f.config([failGate]);
  const base = f.commit();

  const res = f.run(['--base-ref', base], 1).value;
  const g = res.gates[0];
  assert.equal(g.status, 'fail');
  assert.ok(g.stdout.length <= 8192);
  assert.ok(g.stderr.length <= 8192);
  assert.ok(g.stdout.endsWith('TAIL_STDOUT\n'));
  assert.ok(g.stderr.endsWith('TAIL_STDERR\n'));
});

test('L1: running outside repository root exits 2', (t) => {
  const f = fixture(t);
  f.config();
  f.commit();
  mkdirSync(join(f.root, 'sub-dir'));
  const res = spawnSync(process.execPath, [bin, 'aps', 'gate'], {
    cwd: join(f.root, 'sub-dir'),
    encoding: 'utf8',
  });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /projectDir must be repository root/);
});

test('L2: ledger validation happens before gate execution', (t) => {
  const f = fixture(t);
  f.config();
  const base = f.commit();
  // Pass non-existent card with --card
  const res = f.run(
    ['--base-ref', base, '--card', 'NONEXISTENT', '--by', 'worker', '--db', join(f.root, 'ledger.db')],
    2,
  );
  assert.match(res.stdout, /card NONEXISTENT not found/);
});

test('L3: baselineSha256 binds to base baseline in base-ref mode', (t) => {
  const f = fixture(t);
  f.config();
  f.baseline(4);
  const base = f.commit();
  const baseBytes = readFileSync(join(f.root, '.aps/baseline.json'));
  f.baseline(9);
  f.commit();
  const headBytes = readFileSync(join(f.root, '.aps/baseline.json'));
  const res = f.run(['--base-ref', base], 1).value;
  assert.equal(res.baselineSha256, createHash('sha256').update(baseBytes).digest('hex'));
  assert.notEqual(res.baselineSha256, createHash('sha256').update(headBytes).digest('hex'));
});

test('L4: not-yet-active exemptions emit warning and are ignored', (t) => {
  const f = fixture(t);
  f.config();
  f.baseline(4);
  const base = f.commit();
  const future = '2099-01-01';
  f.file('exemptions.json', {
    version: 1,
    exemptions: [exemption({ createdAt: future, expiresAt: future })],
  });
  const approvedBase = f.commit();
  const res = f.run(['--base-ref', approvedBase], 1).value;
  assert.equal(res.gates[0].status, 'fail');
  assert.match(res.warnings.join(' '), /not-yet-active-exemption/);
});

test('L6: --card requires --base-ref', (t) => {
  const f = fixture(t);
  f.config();
  f.commit();
  const res = f.run(['--card', 'TEST-C-0001', '--by', 'worker'], 2);
  assert.match(res.stdout, /--card requires --base-ref/);
});

test('M4: timeout kills the process group, including a grandchild', (t) => {
  const f = fixture(t);
  const hang = structuredClone(gate);
  hang.mode = 'required';
  hang.metrics = undefined;
  hang.run.timeoutSec = 1;
  const pidFile = join(f.root, 'grandchild.pid');
  hang.run.argv = [
    process.execPath,
    '-e',
    `const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn('sleep',['30'],{stdio:'inherit'});fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));setInterval(()=>{},1000);`,
  ];
  f.config([hang]);
  const base = f.commit();
  // Real timeout: process-group kill cannot be proven with fake timers. spawnSync timeout fails the test if the grandchild keeps the pipe open.
  const started = Date.now();
  const result = spawnSync(process.execPath, [bin, 'aps', 'gate', '--base-ref', base, '--json'], {
    cwd: f.root,
    env: { ...process.env, HOME: f.root, APS_AGENT: '', NODE_NO_WARNINGS: '1' },
    encoding: 'utf8',
    timeout: 8000,
  });
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.ok(Date.now() - started < 8000, `elapsed ${Date.now() - started}`);
  const value = JSON.parse(result.stdout);
  assert.equal(value.gates[0].status, 'error');
  const pid = Number(readFileSync(pidFile, 'utf8'));
  const alive = spawnSync('kill', ['-0', String(pid)]);
  assert.notEqual(alive.status, 0, `grandchild ${pid} still alive`);
});

test('L5: pipelines belong in a repository script', () => {
  const doc = readFileSync(resolve(import.meta.dirname, '../../../docs/aps/GATES.md'), 'utf8');
  assert.match(doc, /Pipelines belong in a repository script\./);
  assert.doesNotMatch(doc, /or explicit shell argv/);
});

test('H1: adding when to a base gate is drift and does not skip the gate', (t) => {
  const f = fixture(t);
  const baseGate = structuredClone(gate);
  f.config([baseGate]);
  f.baseline(5);
  const base = f.commit();
  const drifted = structuredClone(baseGate);
  drifted.when = { changedPaths: ['src/**'] };
  f.config([drifted]);
  f.commit();
  const res = f.run(['--base-ref', base], 1).value;
  assert.notEqual(res.gates[0].status, 'skipped');
  assert.notEqual(res.gates[0].exitCode, null);
  assert.doesNotMatch(res.gates[0].message, /No matching changed paths/);
  assert.equal(res.verdict, 'fail');
  assert.match(res.gates[0].message, /when changed/);
});

test('H1: flipping metric direction is drift', (t) => {
  const f = fixture(t);
  const baseGate = structuredClone(gate);
  f.config([baseGate]);
  f.baseline(4);
  const base = f.commit();
  const flipped = structuredClone(baseGate);
  if (flipped.metrics?.[0]) flipped.metrics[0].direction = 'higher';
  f.config([flipped]);
  f.baseline(4);
  f.commit();
  const res = f.run(['--base-ref', base], 1).value;
  assert.equal(res.verdict, 'fail');
  assert.match(res.gates[0].message, /direction changed from lower to higher/);
});

test('M3: card detail stores a short redacted message and never raw stderr', (t) => {
  const f = fixture(t);
  const failGate = structuredClone(gate);
  failGate.mode = 'required';
  failGate.metrics = undefined;
  const token = 'TOKEN=ghp_probe_not_real';
  failGate.run.argv = [
    process.execPath,
    '-e',
    `console.error(${JSON.stringify(token)} + 'Y'.repeat(5000) + ${JSON.stringify(token)}); process.exit(1);`,
  ];
  f.config([failGate]);
  const base = f.commit();
  const dbPath = join(f.root, 'ledger.db');
  const db = openApsDb(dbPath);
  db.exec(`INSERT INTO projects(id,prefix,name) VALUES('test','TEST','test');
    INSERT INTO agents(id,name,layer,model,vendor) VALUES('manager','manager','L2','local','local'),('worker','worker','L3','local','local');
    INSERT INTO cards(id,project,title,kind,size,scope,acceptance_json,forbidden,needs_owner,needs_vision,layer_owner,assignee)
    VALUES('TEST-C-0001','test','gate','mech','S','scope','[{"id":"AC1","text":"gates","command":"mmbridge aps gate","expect":"exit 0"}]','none',0,0,'manager','worker');`);
  const res = f.run(['--base-ref', base, '--card', 'TEST-C-0001', '--db', dbPath, '--by', 'worker'], 1).value;

  const message = res.gates[0].message as string;
  assert.ok(Buffer.byteLength(message) <= 2048);
  assert.doesNotMatch(message, /ghp_probe_not_real/);
  assert.match(message, /REDACTED/);
  const link = db.prepare('SELECT detail_json FROM card_links').get() as { detail_json: string };
  assert.ok(Buffer.byteLength(link.detail_json) < 8192);
  assert.doesNotMatch(link.detail_json, /ghp_probe_not_real/);
  assert.doesNotMatch(link.detail_json, /"stderr"/);
  assert.doesNotMatch(link.detail_json, /"stdout"/);
  db.close();
});

test('update-baseline still rejects a loosened baseline on a skipped gate', (t) => {
  const f = fixture(t);
  const skipped = structuredClone(gate);
  skipped.when = { changedPaths: ['src/**'] };
  f.config([skipped]);
  f.baseline(4);
  const base = f.commit();
  f.baseline(10);
  f.commit();
  const before = readFileSync(join(f.root, '.aps/baseline.json'), 'utf8');
  const res = f.run(['--base-ref', base, '--update-baseline'], 1).value;
  assert.equal(res.verdict, 'fail');
  assert.equal(res.baselineUpdated, false);
  assert.match(res.warnings.join(' '), /head-baseline-loosened/);
  assert.equal(readFileSync(join(f.root, '.aps/baseline.json'), 'utf8'), before);
});

function seedCard(root: string): string {
  const dbPath = join(root, 'ledger.db');
  const db = openApsDb(dbPath);
  db.exec(`INSERT INTO projects(id,prefix,name) VALUES('test','TEST','test');
    INSERT INTO agents(id,name,layer,model,vendor) VALUES('manager','manager','L2','local','local'),('worker','worker','L3','local','local');
    INSERT INTO cards(id,project,title,kind,size,scope,acceptance_json,forbidden,needs_owner,needs_vision,layer_owner,assignee)
    VALUES('TEST-C-0001','test','gate','mech','S','scope','[{"id":"AC1","text":"gates","command":"mmbridge aps gate","expect":"exit 0"}]','none',0,0,'manager','worker');`);
  db.close();
  return dbPath;
}

test('R1: argv drift fails even when the command still prints the baseline', (t) => {
  const f = fixture(t);
  f.config();
  f.baseline(5);
  const base = f.commit();
  const baseConfigBytes = readFileSync(join(f.root, '.aps/gates.json'));
  const drifted = structuredClone(gate);
  drifted.run.argv = [process.execPath, '-e', 'console.log(JSON.stringify({count:5}));'];
  f.config([drifted]);
  f.commit();
  const res = f.run(['--base-ref', base], 1).value;
  assert.match(res.gates[0].message, /run\.argv changed/);
  assert.equal(res.baseConfigSha256, createHash('sha256').update(baseConfigBytes).digest('hex'));
});

test('R1: cwd drift includes an explicit dot', (t) => {
  const f = fixture(t);
  f.config();
  f.baseline(5);
  const base = f.commit();
  const drifted = structuredClone(gate);
  drifted.run.cwd = '.';
  f.config([drifted]);
  f.commit();
  assert.match(f.run(['--base-ref', base], 1).value.gates[0].message, /run\.cwd changed/);
});

test('R1: env drift fails a no-op SKIP_CHECK assignment', (t) => {
  const f = fixture(t);
  f.config();
  f.baseline(5);
  const base = f.commit();
  const drifted = structuredClone(gate);
  drifted.run.env = { SKIP_CHECK: '1' };
  f.config([drifted]);
  f.commit();
  assert.match(f.run(['--base-ref', base], 1).value.gates[0].message, /run\.env changed/);
});

test('R1: metric source pointer drift fails closed', (t) => {
  const f = fixture(t);
  f.config();
  f.baseline(5);
  const base = f.commit();
  const drifted = structuredClone(gate);
  if (drifted.metrics?.[0]) drifted.metrics[0].source = { kind: 'json', pointer: '/zero' };
  f.config([drifted]);
  f.commit();
  assert.match(f.run(['--base-ref', base], 1).value.gates[0].message, /source changed/);
});

test('R1: ratchet to threshold is mode drift', (t) => {
  const f = fixture(t);
  f.config();
  f.baseline(5);
  const base = f.commit();
  const drifted = structuredClone(gate);
  drifted.mode = 'threshold';
  f.config([drifted]);
  f.commit();
  assert.match(f.run(['--base-ref', base], 1).value.gates[0].message, /mode changed from ratchet to threshold/);
});

test('R2: allow does not skip a raised tolerance', (t) => {
  const f = fixture(t);
  f.config();
  f.baseline(5);
  f.file('exemptions.json', {
    version: 1,
    exemptions: [exemption({ effect: 'allow', metric: 'count', allow: 6 })],
  });
  const base = f.commit();
  const drifted = structuredClone(gate);
  if (drifted.metrics?.[0]) drifted.metrics[0].tolerance = 100000;
  drifted.run.argv = [process.execPath, '-e', 'console.log(JSON.stringify({count:1000}))'];
  f.config([drifted]);
  f.commit();
  const res = f.run(['--base-ref', base], 1).value;
  assert.match(res.gates[0].message, /tolerance raised/);
});

test('R3: drift refuses update-baseline and keeps the card verdict failed', (t) => {
  const f = fixture(t);
  f.config();
  f.baseline(5);
  const base = f.commit();
  const drifted = structuredClone(gate);
  drifted.run.argv = [process.execPath, '-e', 'console.log(JSON.stringify({count:5}));'];
  f.config([drifted]);
  f.commit();
  const before = readFileSync(join(f.root, '.aps/baseline.json'));
  const dbPath = seedCard(f.root);
  const res = f.run(
    ['--base-ref', base, '--update-baseline', '--card', 'TEST-C-0001', '--db', dbPath, '--by', 'worker'],
    1,
  ).value;
  assert.equal(res.gates[0].status, 'fail');
  assert.equal(res.baselineUpdated, false);
  assert.doesNotMatch(res.gates[0].message, /Baseline seeded or tightened/);
  assert.equal(readFileSync(join(f.root, '.aps/baseline.json')).equals(before), true);
  const db = openApsDb(dbPath);
  const link = db.prepare('SELECT detail_json FROM card_links').get() as { detail_json: string };
  assert.equal(JSON.parse(link.detail_json).verdict, 'fail');
  db.close();
});

test('R4: each gate token rule redacts a sample the built-ins miss', () => {
  const cases = [
    { label: 'GitHub PAT', sample: 'ghp_probe_not_real', expected: '[REDACTED_GH_TOKEN]' },
    { label: 'GitHub app token', sample: 'ghs_probe_not_real', expected: '[REDACTED_GH_TOKEN]' },
    { label: 'Authorization header', sample: 'Authorization: Basic YWRtaW4', expected: '[REDACTED_AUTHORIZATION]' },
    { label: 'secret assignment', sample: 'API_KEY=abcdef', expected: '[REDACTED_SECRET]' },
    { label: 'URL userinfo', sample: 'postgres://admin:pa55w0rd@db.example/app', expected: '[REDACTED_URL_USERINFO]' },
    { label: 'AWS access key', sample: 'AKIAIOSFODNN7EXAMPLE', expected: '[REDACTED_AWS_KEY]' },
    { label: 'Slack token', sample: 'xoxb-1234-abcdef', expected: '[REDACTED_SLACK_TOKEN]' },
  ];
  for (const item of cases) {
    const rule = GATE_TOKEN_RULES.find((candidate) => candidate.label === item.label);
    assert.ok(rule, item.label);
    assert.equal(redactContent(item.sample).redacted, item.sample, item.label);
    const redacted = redactBoundedText(redactContent, item.sample, 2048);
    assert.match(redacted, new RegExp(item.expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(
      redacted,
      /ghp_probe_not_real|ghs_probe_not_real|YWRtaW4|abcdef|pa55w0rd|AKIAIOSFODNN7EXAMPLE|xoxb-1234-abcdef/,
    );
  }
  assert.equal(redactBoundedText(redactContent, 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI', 2048), '[REDACTED_SECRET]');
  assert.equal(redactBoundedText(redactContent, 'Secret: hunter2', 2048), '[REDACTED_SECRET]');
});

test('R4: card metric messages redact extraction tokens', (t) => {
  const f = fixture(t);
  const leaked = structuredClone(gate);
  leaked.run.argv = [process.execPath, '-e', 'console.log("TOKEN=ghp_probe_not_real")'];
  f.config([leaked]);
  f.baseline(5);
  const base = f.commit();
  const dbPath = seedCard(f.root);
  const res = f.run(['--base-ref', base, '--card', 'TEST-C-0001', '--db', dbPath, '--by', 'worker'], 1).value;
  assert.doesNotMatch(res.gates[0].metrics[0].message, /ghp_probe_not_real/);
  const db = openApsDb(dbPath);
  const link = db.prepare('SELECT detail_json FROM card_links').get() as { detail_json: string };
  assert.doesNotMatch(link.detail_json, /ghp_probe_not_real/);
  db.close();
});

test('R5: removing when is not drift and the gate still runs', (t) => {
  const f = fixture(t);
  const baseGate = structuredClone(gate);
  baseGate.when = { changedPaths: ['src/**'] };
  f.config([baseGate]);
  f.baseline(5);
  const base = f.commit();
  f.config([structuredClone(gate)]);
  writeFileSync(join(f.root, 'README.md'), 'unrelated\n');
  f.commit();
  const res = f.run(['--base-ref', base], 0).value;
  assert.equal(res.gates[0].status, 'pass');
  assert.notEqual(res.gates[0].exitCode, null);
  assert.doesNotMatch(res.gates[0].message, /when changed|changedPaths narrowed|No matching changed paths/);
});

test('R5: a broader when is not drift and still runs base paths', (t) => {
  const f = fixture(t);
  const baseGate = structuredClone(gate);
  baseGate.when = { changedPaths: ['src/**'] };
  f.config([baseGate]);
  f.baseline(5);
  const base = f.commit();
  const head = structuredClone(baseGate);
  head.when = { changedPaths: ['src/**', 'docs/**'] };
  f.config([head]);
  mkdirSync(join(f.root, 'src'));
  writeFileSync(join(f.root, 'src/a.ts'), 'export const value = 1;\n');
  f.commit();
  const res = f.run(['--base-ref', base], 0).value;
  assert.equal(res.gates[0].status, 'pass');
  assert.equal(res.gates[0].exitCode, 0);
  assert.doesNotMatch(res.gates[0].message, /changedPaths narrowed|when changed/);
});

async function waitForText(path: string): Promise<string> {
  const started = Date.now();
  while (Date.now() - started < 4000) {
    try {
      const text = readFileSync(path, 'utf8').trim();
      if (text) return text;
    } catch {
      // The other process has not created the file yet.
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 20);
    await promise;
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function waitUntilDead(pid: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 4000) {
    if (spawnSync('kill', ['-0', String(pid)]).status !== 0) return;
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 20);
    await promise;
  }
  throw new Error(`pid ${pid} still alive`);
}

test('R6: detached close kills an unrefd grandchild', (t) => {
  const f = fixture(t);
  const pidFile = join(f.root, 'grandchild.pid');
  const utilsPath = resolve(import.meta.dirname, '../../core/dist/utils.js');
  const script = join(f.root, 'close.mjs');
  const child = [
    "const {spawn}=require('node:child_process');const fs=require('node:fs');",
    "const child=spawn('sleep',['30'],{stdio:'ignore'});child.unref();",
    `fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
  ].join('');
  writeFileSync(
    script,
    `import { runCommand } from ${JSON.stringify(utilsPath)};
const result = await runCommand(process.execPath, ['-e', ${JSON.stringify(child)}], { detached: true, timeoutMs: 10000 });
if (result.code !== 0) process.exit(result.code || 1);
`,
  );
  const helper = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 8000 });
  assert.equal(helper.status, 0, `${helper.stdout}\n${helper.stderr}`);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  try {
    // Real process: the grandchild is started by the detached command, so this process cannot fake its lifetime.
    assert.notEqual(spawnSync('kill', ['-0', String(pid)]).status, 0, `grandchild ${pid} still alive`);
  } finally {
    spawnSync('kill', ['-9', String(pid)]);
  }
});

test('R6: SIGTERM kills the helper and its detached command', async (t) => {
  const f = fixture(t);
  const helperPidFile = join(f.root, 'helper.pid');
  const childPidFile = join(f.root, 'child.pid');
  const utilsPath = resolve(import.meta.dirname, '../../core/dist/utils.js');
  const script = join(f.root, 'signal.mjs');
  const child = `require('node:fs').writeFileSync(${JSON.stringify(childPidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
  writeFileSync(
    script,
    `import { writeFileSync } from 'node:fs';
import { runCommand } from ${JSON.stringify(utilsPath)};
writeFileSync(${JSON.stringify(helperPidFile)}, String(process.pid));
await runCommand(process.execPath, ['-e', ${JSON.stringify(child)}], { detached: true, timeoutMs: 60000 });
`,
  );
  const helper = spawn(process.execPath, [script], { stdio: 'ignore' });
  t.after(() => {
    if (helper.pid) spawnSync('kill', ['-9', String(helper.pid)]);
  });
  // Real wait: both pid files are written by other processes after spawn.
  const helperPid = Number(await waitForText(helperPidFile));
  const childPid = Number(await waitForText(childPidFile));
  process.kill(helperPid, 'SIGTERM');
  await waitUntilDead(helperPid);
  await waitUntilDead(childPid);
});
