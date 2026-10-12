import assert from 'node:assert/strict';
import test from 'node:test';
import type { AuditLane, ProviderQuota, VisionVerdict } from '../dist/index.js';
import { buildAudit, classifyModel, lanesFromPs, mechanicalTitle, renderAuditMarkdown } from '../dist/index.js';

const NOW = Date.parse('2026-10-11T10:00:00Z');
const STALL_MS = 30 * 60 * 1000;

function lane(overrides: Partial<AuditLane> & { id: string }): AuditLane {
  return {
    source: 'herdr',
    harness: 'omp',
    model: null,
    tier: 'unknown',
    provider: null,
    status: 'working',
    cwd: null,
    title: null,
    cardKind: null,
    cardKindSource: null,
    lastOutputAt: null,
    agentId: null,
    finished: false,
    recorded: null,
    ...overrides,
  };
}

const EXHAUSTED_ANTHROPIC: ProviderQuota = {
  provider: 'anthropic',
  source: 'omp',
  windows: [
    {
      label: 'Claude 5 Hour',
      accounts: 1,
      usedFraction: 1,
      remainingFraction: 0,
      resetsAt: Date.parse('2026-10-11T12:00:00Z'),
      runsOutBeforeReset: true,
      exhaustsAt: Date.parse('2026-10-11T11:30:00Z'),
    },
  ],
  remainingFraction: 0,
  blocked: true,
  reason: 'Claude 5 Hour 0% left',
};

test('classifyModel maps provider/model selectors to tiers', () => {
  assert.deepEqual(classifyModel('anthropic/claude-opus-5-5:medium'), { tier: 'premium', provider: 'anthropic' });
  assert.deepEqual(classifyModel('openai-codex/gpt-6.1-sol'), { tier: 'premium', provider: 'openai-codex' });
  assert.deepEqual(classifyModel('swe-2-max'), { tier: 'L3', provider: 'devin' });
  assert.deepEqual(classifyModel('opencode-go/deepseek-v4.1-flash:high'), { tier: 'L3', provider: 'opencode-go' });
  assert.deepEqual(classifyModel('google-antigravity/gemini-3.8-flash'), {
    tier: 'L3',
    provider: 'google-antigravity',
  });
  assert.deepEqual(classifyModel('grok-4.7'), { tier: 'L3', provider: 'xai-oauth' });
  assert.deepEqual(classifyModel(null), { tier: 'unknown', provider: null });
  assert.deepEqual(classifyModel(''), { tier: 'unknown', provider: null });
});

test('classifyModel is case-insensitive, strips effort, and prefers premium', () => {
  assert.deepEqual(classifyModel('Anthropic/Claude-Opus-5-5:High'), { tier: 'premium', provider: 'anthropic' });
  assert.deepEqual(classifyModel('anthropic/claude-sonnet-5-5'), { tier: 'unknown', provider: 'anthropic' });
  assert.deepEqual(classifyModel('google-antigravity/gemini-3.1-pro'), {
    tier: 'unknown',
    provider: 'google-antigravity',
  });
  assert.deepEqual(classifyModel('anthropic/claude-haiku-4:low'), { tier: 'L3', provider: 'anthropic' });
  assert.deepEqual(classifyModel('xai-oauth/grok-4.7:high'), { tier: 'L3', provider: 'xai-oauth' });
  assert.deepEqual(classifyModel('zai/glm-5'), { tier: 'L3', provider: 'zai' });
  assert.deepEqual(classifyModel('swe-1-mini:low'), { tier: 'L3', provider: 'devin' });
  assert.deepEqual(classifyModel('acme/mystery-9'), { tier: 'unknown', provider: 'acme' });
  assert.deepEqual(classifyModel('mystery-9'), { tier: 'unknown', provider: null });
});

test('mechanicalTitle flags mechanical work titles', () => {
  const mechanical = [
    'i18n: move strings',
    '국제화 카드',
    '번역 누락 수정',
    'rename module',
    '리네임 작업',
    'typo fix',
    'lint cleanup',
    'format code',
    '문서 정리',
    'docs: aps audit',
    'changelog entry',
    'test gap: audit',
    '커버리지 올리기',
    'coverage up',
    'mechanical rename',
    '기계 작업',
  ];
  for (const title of mechanical) assert.equal(mechanicalTitle(title), true, title);
  for (const title of [null, '', 'design the board UI', 'vision audit of screenshots', 'research routing'])
    assert.equal(mechanicalTitle(title), false, String(title));
});

test('buildAudit counts working lanes, L3 ratio, and groups lanes by model', () => {
  const report = buildAudit({
    now: NOW,
    quota: [],
    lanes: [
      lane({ id: 'pane-opus', model: 'anthropic/claude-opus-5-5', tier: 'premium', provider: 'anthropic' }),
      lane({ id: 'pane-sol', model: 'openai-codex/gpt-6.1-sol', tier: 'premium', provider: 'openai-codex' }),
      lane({ id: 'pane-deepseek', model: 'opencode-go/deepseek-v4.1-flash', tier: 'L3', provider: 'opencode-go' }),
      lane({
        id: 'pane-idle',
        status: 'idle',
        model: 'anthropic/claude-opus-5-5',
        tier: 'premium',
        provider: 'anthropic',
      }),
      lane({
        id: 'pane-finished',
        status: 'done',
        model: 'swe-2-max',
        tier: 'L3',
        provider: 'devin',
        finished: true,
      }),
    ],
  });

  assert.equal(report.generatedAt, '2026-10-11T10:00:00.000Z');
  assert.equal(report.workingLanes, 3);
  assert.equal(report.l3Working, 1);
  assert.equal(report.l3Ratio, 1 / 3);
  assert.equal(report.lanes.length, 5);
  assert.deepEqual(report.byModel, [
    { model: 'anthropic/claude-opus-5-5', tier: 'premium', working: 1, idle: 1 },
    { model: 'openai-codex/gpt-6.1-sol', tier: 'premium', working: 1, idle: 0 },
    { model: 'opencode-go/deepseek-v4.1-flash', tier: 'L3', working: 1, idle: 0 },
    { model: 'swe-2-max', tier: 'L3', working: 0, idle: 0 },
  ]);
  assert.deepEqual(report.stalled, []);
  assert.deepEqual(
    report.finishedOpen.map((entry) => entry.id),
    ['pane-finished'],
  );
  assert.deepEqual(report.violations, [
    { code: 'L3_RATIO', lane: null, card: null, detail: 'L3 1/3 = 33% < 60%' },
    { code: 'FINISHED_OPEN', lane: 'pane-finished', card: null, detail: 'finished but session still open' },
  ]);
});

test('buildAudit groups lanes without a model under unknown', () => {
  const report = buildAudit({
    now: NOW,
    quota: [],
    minL3Ratio: 0,
    lanes: [lane({ id: 'pane-a', status: 'idle' }), lane({ id: 'pane-b', status: 'done' })],
  });
  assert.deepEqual(report.byModel, [{ model: 'unknown', tier: 'unknown', working: 0, idle: 1 }]);
});

test('MECH_ON_PREMIUM fires for premium lanes on mechanical cards only', () => {
  const report = buildAudit({
    now: NOW,
    quota: [],
    minL3Ratio: 0,
    lanes: [
      lane({
        id: 'pane-mech',
        model: 'anthropic/claude-opus-5-5',
        tier: 'premium',
        provider: 'anthropic',
        title: 'i18n rename',
        cardKind: 'mech',
        cardKindSource: 'title',
      }),
      lane({
        id: 'pane-design',
        model: 'anthropic/claude-opus-5-5',
        tier: 'premium',
        provider: 'anthropic',
        cardKind: 'design',
        cardKindSource: 'ledger',
      }),
      lane({
        id: 'pane-l3-mech',
        model: 'opencode-go/deepseek-v4.1-flash',
        tier: 'L3',
        provider: 'opencode-go',
        cardKind: 'mech',
        cardKindSource: 'ledger',
      }),
    ],
  });

  assert.deepEqual(report.violations, [
    {
      code: 'MECH_ON_PREMIUM',
      lane: 'pane-mech',
      card: null,
      detail: 'anthropic/claude-opus-5-5 on mechanical work (title)',
    },
  ]);
});

test('L3_VISION_VERDICT fires for L3 auditors or an L3 auditor model', () => {
  const visionVerdicts: VisionVerdict[] = [
    { card: 'CARD-1', auditorModel: 'google-antigravity/gemini-3.8-flash', auditorLayer: 'L2' },
    { card: 'CARD-2', auditorModel: 'anthropic/claude-opus-5-5', auditorLayer: 'L3' },
    { card: 'CARD-3', auditorModel: 'anthropic/claude-opus-5-5', auditorLayer: 'L0' },
  ];
  const report = buildAudit({ now: NOW, lanes: [], quota: [], visionVerdicts, minL3Ratio: 0 });

  assert.equal(report.l3Ratio, null);
  assert.deepEqual(report.violations, [
    {
      code: 'L3_VISION_VERDICT',
      lane: null,
      card: 'CARD-1',
      detail: 'vision verdict by google-antigravity/gemini-3.8-flash (L2)',
    },
    {
      code: 'L3_VISION_VERDICT',
      lane: null,
      card: 'CARD-2',
      detail: 'vision verdict by anthropic/claude-opus-5-5 (L3)',
    },
  ]);
});

test('EXHAUSTED_PROVIDER fires for working lanes at or below 1% remaining', () => {
  const report = buildAudit({
    now: NOW,
    minL3Ratio: 0,
    lanes: [
      lane({ id: 'pane-opus', model: 'anthropic/claude-opus-5-5', tier: 'premium', provider: 'anthropic' }),
      lane({ id: 'pane-edge', model: 'zai/glm-5', tier: 'L3', provider: 'zai' }),
      lane({ id: 'pane-ok', model: 'opencode-go/deepseek-v4.1-flash', tier: 'L3', provider: 'opencode-go' }),
    ],
    quota: [
      EXHAUSTED_ANTHROPIC,
      { provider: 'zai', source: 'omp', windows: [], remainingFraction: 0.01, blocked: true, reason: 'zai 1% left' },
      { provider: 'opencode-go', source: 'omp', windows: [], remainingFraction: 0.5, blocked: false, reason: null },
    ],
  });

  assert.deepEqual(report.violations, [
    {
      code: 'EXHAUSTED_PROVIDER',
      lane: 'pane-opus',
      card: null,
      detail: 'anthropic/claude-opus-5-5 running on anthropic with 0% left',
    },
    { code: 'EXHAUSTED_PROVIDER', lane: 'pane-edge', card: null, detail: 'zai/glm-5 running on zai with 1% left' },
  ]);
});

test('STALLED fires only past the stall threshold', () => {
  const report = buildAudit({
    now: NOW,
    quota: [],
    minL3Ratio: 0,
    lanes: [
      lane({ id: 'pane-exact', model: 'swe-2-max', tier: 'L3', provider: 'devin', lastOutputAt: NOW - STALL_MS }),
      lane({ id: 'pane-late', model: 'swe-2-max', tier: 'L3', provider: 'devin', lastOutputAt: NOW - STALL_MS - 1 }),
      lane({ id: 'pane-fresh', model: 'swe-2-max', tier: 'L3', provider: 'devin', lastOutputAt: NOW - 60_000 }),
    ],
  });

  assert.deepEqual(
    report.stalled.map((entry) => entry.id),
    ['pane-late'],
  );
  assert.deepEqual(report.violations, [
    { code: 'STALLED', lane: 'pane-late', card: null, detail: 'no output for 30 min' },
  ]);
});

test('STALLED honours a custom stallMs and floors the minutes', () => {
  const report = buildAudit({
    now: NOW,
    quota: [],
    minL3Ratio: 0,
    stallMs: 5 * 60 * 1000,
    lanes: [
      lane({ id: 'pane-a', model: 'swe-2-max', tier: 'L3', provider: 'devin', lastOutputAt: NOW - 5 * 60 * 1000 - 1 }),
      lane({
        id: 'pane-b',
        model: 'swe-2-max',
        tier: 'L3',
        provider: 'devin',
        lastOutputAt: NOW - 11 * 60 * 1000 - 59_000,
      }),
    ],
  });

  assert.deepEqual(report.violations, [
    { code: 'STALLED', lane: 'pane-a', card: null, detail: 'no output for 5 min' },
    { code: 'STALLED', lane: 'pane-b', card: null, detail: 'no output for 11 min' },
  ]);
});

test('IDLE_OPEN fires at 10 min for idle or done lanes with an open agent', () => {
  const tenMin = 10 * 60 * 1000;
  const report = buildAudit({
    now: NOW,
    quota: [],
    minL3Ratio: 0,
    lanes: [
      lane({ id: 'under', status: 'idle', agentId: 'a-under', lastOutputAt: NOW - tenMin + 1000 }),
      lane({ id: 'exact', status: 'idle', agentId: 'a-exact', lastOutputAt: NOW - tenMin }),
      lane({ id: 'done-idle', status: 'done', agentId: 'a-done', lastOutputAt: NOW - tenMin, finished: true }),
      lane({
        id: 'working',
        status: 'working',
        agentId: 'a-work',
        model: 'swe-2-max',
        tier: 'L3',
        provider: 'devin',
        lastOutputAt: NOW - tenMin,
      }),
      lane({ id: 'no-agent', status: 'idle', agentId: null, lastOutputAt: NOW - tenMin }),
      lane({ id: 'no-output', status: 'idle', agentId: 'a-none', lastOutputAt: null }),
      lane({ id: 'blocked', status: 'blocked', agentId: 'a-blocked', lastOutputAt: NOW - tenMin }),
    ],
  });

  assert.deepEqual(
    report.idleOpen.map((entry) => entry.id),
    ['exact', 'done-idle'],
  );
  assert.deepEqual(
    report.violations.filter((violation) => violation.code === 'IDLE_OPEN'),
    [
      { code: 'IDLE_OPEN', lane: 'exact', card: null, detail: 'agent a-exact idle 10 min' },
      { code: 'IDLE_OPEN', lane: 'done-idle', card: null, detail: 'agent a-done idle 10 min' },
    ],
  );
  assert.equal(
    report.violations.some((violation) => violation.code === 'IDLE_OPEN' && violation.lane === 'working'),
    false,
  );
  assert.equal(
    report.violations.some((violation) => violation.lane === 'under' || violation.lane === 'no-agent'),
    false,
  );
  const markdown = renderAuditMarkdown(report);
  assert.equal(markdown.includes('## Idle open sessions\n\n| pane | agent | status | idle min |'), true);
  assert.equal(markdown.includes('| exact | a-exact | idle | 10 |'), true);
  assert.equal(markdown.includes('| done-idle | a-done | done | 10 |'), true);
});

test('IDLE_OPEN honours a custom idleMs', () => {
  const report = buildAudit({
    now: NOW,
    quota: [],
    minL3Ratio: 0,
    idleMs: 5 * 60 * 1000,
    lanes: [
      lane({ id: 'early', status: 'idle', agentId: 'a', lastOutputAt: NOW - 5 * 60 * 1000 + 1 }),
      lane({ id: 'due', status: 'done', agentId: 'a', lastOutputAt: NOW - 5 * 60 * 1000 }),
    ],
  });
  assert.deepEqual(
    report.idleOpen.map((entry) => entry.id),
    ['due'],
  );
});

test('no working lanes yields a null ratio and no L3_RATIO violation', () => {
  const report = buildAudit({
    now: NOW,
    quota: [],
    lanes: [
      lane({ id: 'pane-idle', status: 'idle', model: 'anthropic/claude-opus-5-5', tier: 'premium' }),
      lane({ id: 'pane-done', status: 'done' }),
    ],
  });

  assert.equal(report.workingLanes, 0);
  assert.equal(report.l3Working, 0);
  assert.equal(report.l3Ratio, null);
  assert.deepEqual(report.byModel, [
    { model: 'anthropic/claude-opus-5-5', tier: 'premium', working: 0, idle: 1 },
    { model: 'unknown', tier: 'unknown', working: 0, idle: 0 },
  ]);
  assert.deepEqual(report.violations, []);
  assert.equal(renderAuditMarkdown(report).includes('L3 ratio: n/a (target ≥ 60%)'), true);
});

test('renderAuditMarkdown renders the summary, quota table, and escapes pipes', () => {
  const report = buildAudit({
    now: NOW,
    minL3Ratio: 0,
    lanes: [
      lane({
        id: 'pane-pipe',
        model: 'anthropic/claude-opus-5-5',
        tier: 'premium',
        provider: 'anthropic',
        title: 'design | work',
      }),
      lane({
        id: 'pane-stall',
        model: 'swe-2-max',
        tier: 'L3',
        provider: 'devin',
        cwd: '/tmp/proj',
        lastOutputAt: NOW - 31 * 60 * 1000,
      }),
    ],
    quota: [
      { ...EXHAUSTED_ANTHROPIC, windows: [{ ...EXHAUSTED_ANTHROPIC.windows[0], label: 'Claude 5 Hour | pool' }] },
    ],
  });

  const markdown = renderAuditMarkdown(report);

  assert.equal(markdown.startsWith('# APS audit 2026-10-11T10:00:00.000Z\n'), true);
  assert.equal(markdown.includes('- Working lanes: 2 · L3: 1 · L3 ratio: 50% (target ≥ 60%)'), true);
  assert.equal(markdown.includes('- Violations: 2'), true);
  assert.equal(markdown.includes('| model | tier | working | idle |'), true);
  assert.equal(markdown.includes('| anthropic/claude-opus-5-5 | premium | 1 | 0 |'), true);
  assert.equal(
    markdown.includes(
      '| anthropic | omp | Claude 5 Hour \\| pool | 100% | 0% | 2026-10-11T12:00Z | runs out 2026-10-11T11:30Z | BLOCKED |',
    ),
    true,
  );
  assert.equal(markdown.includes('## Stalled (>30 min)\n\n- pane-stall omp swe-2-max /tmp/proj\n'), true);
  assert.equal(markdown.includes('## Finished but open\n\n- none\n'), true);
  assert.equal(markdown.includes('| code | lane | card | detail |'), true);
  assert.equal(
    markdown.includes(
      '| EXHAUSTED_PROVIDER | pane-pipe |  | anthropic/claude-opus-5-5 running on anthropic with 0% left |',
    ),
    true,
  );
  assert.equal(markdown.endsWith('\n'), true);
});

test('renderAuditMarkdown prints - none for empty lists and an empty quota table', () => {
  const markdown = renderAuditMarkdown(buildAudit({ now: NOW, lanes: [], quota: [] }));

  assert.equal(
    markdown.includes('# APS audit 2026-10-11T10:00:00.000Z\n\n- Working lanes: 0 · L3: 0 · L3 ratio: n/a'),
    true,
  );
  assert.equal(markdown.includes('- Violations: 0'), true);
  assert.equal(markdown.includes('| provider | source | window | used | left | resets | pace | status |'), true);
  assert.equal(markdown.includes('## Stalled (>30 min)\n\n- none\n'), true);
  assert.equal(markdown.includes('## Finished but open\n\n- none\n'), true);
  assert.equal(markdown.includes('## Unrecorded lanes\n\n- none\n'), true);
  assert.equal(markdown.includes('## Violations\n\n- none\n'), true);
  assert.equal(markdown.includes('## Idle open sessions\n\n- none\n'), true);
});

test('UNRECORDED_LANE fires only for working or idle lanes with recorded false', () => {
  const report = buildAudit({
    now: NOW,
    quota: [],
    minL3Ratio: 0,
    lanes: [
      lane({
        id: 'working',
        recorded: false,
        harness: 'omp',
        model: 'xai-oauth/grok-4.7',
        cwd: '/work',
        title: 'manual',
      }),
      lane({ id: 'idle', status: 'idle', recorded: false, harness: 'grok', model: null }),
      lane({ id: 'done', status: 'done', recorded: false }),
      lane({ id: 'blocked', status: 'blocked', recorded: false }),
      lane({ id: 'unchecked', recorded: null }),
      lane({ id: 'known', recorded: true }),
    ],
  });

  assert.deepEqual(
    report.unrecorded.map((entry) => entry.id),
    ['working', 'idle'],
  );
  assert.deepEqual(report.violations, [
    {
      code: 'UNRECORDED_LANE',
      lane: 'working',
      card: null,
      detail: 'omp xai-oauth/grok-4.7 /work manual',
    },
    { code: 'UNRECORDED_LANE', lane: 'idle', card: null, detail: 'grok unknown' },
  ]);
  const markdown = renderAuditMarkdown(report);
  assert.equal(markdown.includes('## Unrecorded lanes\n\n| id | harness | model | status | cwd | title |'), true);
  assert.equal(markdown.includes('| working | omp | xai-oauth/grok-4.7 | working | /work | manual |'), true);
  assert.equal(markdown.includes('| idle | grok |  | idle |  |  |'), true);
});

test('lanesFromPs skips covered processes and reports a bare omp --model', () => {
  const ps = [
    '  1   0 /sbin/launchd',
    '  10  1 /opt/homebrew/bin/herdr serve',
    '  11  10 /bin/zsh -l',
    '  12  11 /usr/local/bin/omp --model hidden -p',
    '  20  1 /usr/bin/node runner.js',
    '  21  20 omp --model child -p',
    '  22  21 omp --model grandchild -p',
    '  30  1 /bin/zsh',
    '  31  30 grok --model skipme',
    '  32  31 claude --model kept',
    '  40  1 /bin/zsh',
    '  41  40 omp --model x -p',
    '  50  1 /Users/me/.local/bin/claude --model opus',
    '  60  50 node mmbridge audit --ps',
    '  90  1 omp --model owned -p',
    'not a process',
  ].join('\n');
  const lanes = lanesFromPs({ ps, runPids: [20, 90], ignorePids: [31], selfPid: 60 });

  assert.deepEqual(
    lanes.map((entry) => entry.id),
    ['pid:32', 'pid:41'],
  );
  assert.equal(
    lanes.some((entry) => entry.id === 'pid:12'),
    false,
    'herdr descendant',
  );
  assert.equal(
    lanes.some((entry) => entry.id === 'pid:21' || entry.id === 'pid:22'),
    false,
    'run-pid descendant',
  );
  assert.equal(
    lanes.some((entry) => entry.id === 'pid:90'),
    false,
    'live run pid',
  );
  assert.equal(
    lanes.some((entry) => entry.id === 'pid:31'),
    false,
    'ignore-pid',
  );
  assert.equal(lanes.find((entry) => entry.id === 'pid:32')?.model, 'kept');
  assert.equal(
    lanes.some((entry) => entry.id === 'pid:50'),
    false,
    'ancestor of the audit process',
  );
  const reported = lanes.find((entry) => entry.id === 'pid:41');
  assert.ok(reported);
  assert.equal(reported.harness, 'omp');
  assert.equal(reported.model, 'x');
  assert.equal(reported.source, 'process');
  assert.equal(reported.status, 'working');
  assert.equal(reported.recorded, false);
  assert.equal(reported.title, 'omp --model x -p');
});
