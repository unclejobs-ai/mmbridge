import type { ProviderQuota } from './quota.js';

/** L3 = mechanical worker models; premium = Opus/Sol/Astra/Fable (L0–L2 only); unknown = not attributable. */
export type ModelTier = 'L3' | 'premium' | 'unknown';

export interface ModelClass {
  tier: ModelTier;
  /** omp provider id from a `provider/model` selector, or inferred; null when unknown. */
  provider: string | null;
}

export interface AuditLane {
  /** herdr pane id, ledger run id, or `pid:<n>`. */
  id: string;
  source: 'herdr' | 'ledger' | 'process';
  /** Harness/agent program: omp, pi, devin, grok, claude, codex, ... */
  harness: string;
  /** `provider/model` when known. */
  model: string | null;
  tier: ModelTier;
  provider: string | null;
  status: 'working' | 'idle' | 'done' | 'blocked' | 'unknown';
  cwd: string | null;
  title: string | null;
  /** Card kind when known (mech/design/review/vision/research). */
  cardKind: string | null;
  /** Where cardKind came from: ledger card row or title keyword heuristic. */
  cardKindSource: 'ledger' | 'title' | null;
  /** Epoch ms of last observed output (transcript/log mtime); null when unknown. */
  lastOutputAt: number | null;
  /** Work finished (report written / process exited / omp yielded) but the session is still open. */
  finished: boolean;
  /** Open ledger agent mapped by `agents.herdr_pane` = this pane id; null when none. */
  agentId: string | null;
  /**
   * True when a non-closed agent or live run owns the lane; false when known unrecorded;
   * null when the ledger was not checked.
   */
  recorded: boolean | null;
}

export interface VisionVerdict {
  card: string;
  auditorModel: string;
  auditorLayer: string;
}

export interface AuditInput {
  now: number;
  lanes: AuditLane[];
  quota: ProviderQuota[];
  visionVerdicts?: VisionVerdict[];
  /** Default 30 min. */
  stallMs?: number;
  /** Idle or done open session with no output this long is IDLE_OPEN. Default 10 min. */
  idleMs?: number;
  /** Default 0.6 (APS §14 placement rule). */
  minL3Ratio?: number;
}

export type ViolationCode =
  | 'L3_RATIO'
  | 'MECH_ON_PREMIUM'
  | 'L3_VISION_VERDICT'
  | 'EXHAUSTED_PROVIDER'
  | 'STALLED'
  | 'FINISHED_OPEN'
  | 'IDLE_OPEN'
  | 'UNRECORDED_LANE';

export interface AuditViolation {
  code: ViolationCode;
  lane: string | null;
  card: string | null;
  detail: string;
}

export interface AuditReport {
  generatedAt: string;
  lanes: AuditLane[];
  byModel: Array<{ model: string; tier: ModelTier; working: number; idle: number }>;
  workingLanes: number;
  l3Working: number;
  /** l3Working / workingLanes; null when no working lanes. */
  l3Ratio: number | null;
  quota: ProviderQuota[];
  stalled: AuditLane[];
  finishedOpen: AuditLane[];
  /** Idle or done lanes with an open agent and no output for `idleMs`. */
  idleOpen: AuditLane[];
  /** `recorded === false` and status working or idle. */
  unrecorded: AuditLane[];
  violations: AuditViolation[];
}

const DEFAULT_STALL_MS = 30 * 60 * 1000;
const DEFAULT_IDLE_MS = 10 * 60 * 1000;
const DEFAULT_MIN_L3_RATIO = 0.6;
/** A provider with this fraction or less left is treated as exhausted. */
const EXHAUSTED_REMAINING_FRACTION = 0.01;

const PREMIUM_MODEL = /opus|fable|astra|gpt-[0-9.]+-sol|(^|[^a-z])sol([^a-z]|$)/;
// MODEL-ROUTING §0/§3.1: Sonnet is mid-tier and Gemini Pro is the Sol/Opus fallback; neither counts as L3.
const L3_MODEL = /swe-|gemini-[0-9.]+-flash|deepseek|grok|glm|kimi|qwen|luna|haiku/;
const MECHANICAL_TITLE =
  /i18n|국제화|번역|rename|리네임|typo|lint|format|문서|docs?\b|changelog|test gap|커버리지|coverage|mechanical|기계/;

export function classifyModel(model: string | null): ModelClass {
  const raw = model?.trim().toLowerCase() ?? '';
  // Strip a `:<effort>` suffix (`claude-opus-5-5:high` → `claude-opus-5-5`) before matching.
  const colon = raw.lastIndexOf(':');
  const selector = colon === -1 ? raw : raw.slice(0, colon);
  if (selector === '') return { tier: 'unknown', provider: null };
  const slash = selector.indexOf('/');
  let provider: string | null = null;
  if (slash === -1) {
    // No `provider/model` selector: the harness name is the only provider hint.
    if (selector.startsWith('swe-') || selector.startsWith('devin')) provider = 'devin';
    else if (selector.startsWith('grok')) provider = 'xai-oauth';
  } else {
    provider = selector.slice(0, slash) || null;
  }
  const modelPart = slash === -1 ? selector : selector.slice(slash + 1);
  if (PREMIUM_MODEL.test(modelPart)) return { tier: 'premium', provider };
  if (L3_MODEL.test(modelPart)) return { tier: 'L3', provider };
  return { tier: 'unknown', provider };
}

export function mechanicalTitle(title: string | null): boolean {
  return title !== null && MECHANICAL_TITLE.test(title.toLowerCase());
}

export function buildAudit(input: AuditInput): AuditReport {
  const stallMs = input.stallMs ?? DEFAULT_STALL_MS;
  const idleMs = input.idleMs ?? DEFAULT_IDLE_MS;
  const minL3Ratio = input.minL3Ratio ?? DEFAULT_MIN_L3_RATIO;
  const working = input.lanes.filter((lane) => lane.status === 'working');
  const l3Working = working.filter((lane) => lane.tier === 'L3');
  const l3Ratio = working.length === 0 ? null : l3Working.length / working.length;
  const stalled = working.filter((lane) => lane.lastOutputAt !== null && input.now - lane.lastOutputAt > stallMs);
  const finishedOpen = input.lanes.filter((lane) => lane.finished);
  const idleOpen = input.lanes.filter(
    (lane) =>
      lane.agentId !== null &&
      (lane.status === 'idle' || lane.status === 'done') &&
      lane.lastOutputAt !== null &&
      input.now - lane.lastOutputAt >= idleMs,
  );
  const violations: AuditViolation[] = [];

  if (l3Ratio !== null && l3Ratio < minL3Ratio) {
    violations.push({
      code: 'L3_RATIO',
      lane: null,
      card: null,
      detail: `L3 ${l3Working.length}/${working.length} = ${percent(l3Ratio)}% < ${percent(minL3Ratio)}%`,
    });
  }
  for (const lane of working) {
    if (lane.tier !== 'premium' || lane.cardKind !== 'mech') continue;
    violations.push({
      code: 'MECH_ON_PREMIUM',
      lane: lane.id,
      card: null,
      detail: `${lane.model ?? 'unknown'} on mechanical work (${lane.cardKindSource ?? 'unknown'})`,
    });
  }
  for (const verdict of input.visionVerdicts ?? []) {
    if (verdict.auditorLayer !== 'L3' && classifyModel(verdict.auditorModel).tier !== 'L3') continue;
    violations.push({
      code: 'L3_VISION_VERDICT',
      lane: null,
      card: verdict.card,
      detail: `vision verdict by ${verdict.auditorModel} (${verdict.auditorLayer})`,
    });
  }
  for (const lane of working) {
    if (lane.provider === null) continue;
    const providerQuota = input.quota.find((entry) => entry.provider === lane.provider);
    if (providerQuota === undefined || providerQuota.remainingFraction > EXHAUSTED_REMAINING_FRACTION) continue;
    violations.push({
      code: 'EXHAUSTED_PROVIDER',
      lane: lane.id,
      card: null,
      detail: `${lane.model ?? 'unknown'} running on ${lane.provider} with ${percent(providerQuota.remainingFraction)}% left`,
    });
  }
  for (const lane of stalled) {
    if (lane.lastOutputAt === null) continue;
    violations.push({
      code: 'STALLED',
      lane: lane.id,
      card: null,
      detail: `no output for ${Math.floor((input.now - lane.lastOutputAt) / 60_000)} min`,
    });
  }
  for (const lane of finishedOpen) {
    violations.push({ code: 'FINISHED_OPEN', lane: lane.id, card: null, detail: 'finished but session still open' });
  }
  for (const lane of idleOpen) {
    if (lane.agentId === null || lane.lastOutputAt === null) continue;
    violations.push({
      code: 'IDLE_OPEN',
      lane: lane.id,
      card: null,
      detail: `agent ${lane.agentId} idle ${Math.floor((input.now - lane.lastOutputAt) / 60_000)} min`,
    });
  }
  const unrecorded = input.lanes.filter(
    (lane) => lane.recorded === false && (lane.status === 'working' || lane.status === 'idle'),
  );
  for (const lane of unrecorded) {
    violations.push({ code: 'UNRECORDED_LANE', lane: lane.id, card: null, detail: unrecordedDetail(lane) });
  }

  return {
    generatedAt: new Date(input.now).toISOString(),
    lanes: input.lanes,
    byModel: groupByModel(input.lanes),
    workingLanes: working.length,
    l3Working: l3Working.length,
    l3Ratio,
    quota: input.quota,
    stalled,
    finishedOpen,
    idleOpen,
    unrecorded,
    violations,
  };
}

export function renderAuditMarkdown(report: AuditReport): string {
  const lines = [
    `# APS audit ${report.generatedAt}`,
    '',
    `- Working lanes: ${report.workingLanes} · L3: ${report.l3Working} · L3 ratio: ${
      report.l3Ratio === null ? 'n/a' : `${percent(report.l3Ratio)}%`
    } (target ≥ 60%)`,
    `- Violations: ${report.violations.length}`,
    '',
    '## Lanes by model',
    '',
    '| model | tier | working | idle |',
    '| --- | --- | --- | --- |',
  ];
  for (const row of report.byModel) lines.push(tableRow([row.model, row.tier, row.working, row.idle]));
  lines.push(
    '',
    '## Quota',
    '',
    '| provider | source | window | used | left | resets | pace | status |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  );
  for (const providerQuota of report.quota) {
    for (const window of providerQuota.windows) {
      lines.push(
        tableRow([
          providerQuota.provider,
          providerQuota.source,
          window.label,
          `${percent(window.usedFraction)}%`,
          `${percent(window.remainingFraction)}%`,
          isoMinute(window.resetsAt),
          window.runsOutBeforeReset ? `runs out ${isoMinute(window.exhaustsAt)}` : 'ok',
          providerQuota.blocked ? 'BLOCKED' : 'ok',
        ]),
      );
    }
  }
  lines.push('', '## Stalled (>30 min)', '', ...renderLaneList(report.stalled));
  lines.push('', '## Finished but open', '', ...renderLaneList(report.finishedOpen));
  lines.push('', '## Idle open sessions', '', ...renderIdleOpen(report));
  lines.push('', '## Unrecorded lanes', '');
  if (report.unrecorded.length === 0) lines.push('- none');
  else {
    lines.push('| id | harness | model | status | cwd | title |', '| --- | --- | --- | --- | --- | --- |');
    for (const lane of report.unrecorded) {
      lines.push(tableRow([lane.id, lane.harness, lane.model ?? '', lane.status, lane.cwd ?? '', lane.title ?? '']));
    }
  }
  lines.push('', '## Violations', '');
  if (report.violations.length === 0) {
    lines.push('- none');
  } else {
    lines.push('| code | lane | card | detail |', '| --- | --- | --- | --- |');
    for (const violation of report.violations) {
      lines.push(tableRow([violation.code, violation.lane ?? '', violation.card ?? '', violation.detail]));
    }
  }
  return `${lines.join('\n')}\n`;
}

function groupByModel(lanes: AuditLane[]): AuditReport['byModel'] {
  // Runtime-inserted model keys; insertion order is not part of the output (sorted below).
  const groups = new Map<string, { model: string; tier: ModelTier; working: number; idle: number }>();
  for (const lane of lanes) {
    const model = lane.model ?? 'unknown';
    const group = groups.get(model) ?? { model, tier: lane.tier, working: 0, idle: 0 };
    if (lane.status === 'working') group.working += 1;
    else if (lane.status === 'idle') group.idle += 1;
    groups.set(model, group);
  }
  return [...groups.values()].sort((a, b) => b.working - a.working || a.model.localeCompare(b.model));
}

/** Integer percent: 1/3 → 33. */
function percent(fraction: number): number {
  return Math.round(fraction * 100);
}

/** `YYYY-MM-DDTHH:MMZ`, `-` when unknown. */
function isoMinute(epochMs: number | null): string {
  return epochMs === null ? '-' : `${new Date(epochMs).toISOString().slice(0, 16)}Z`;
}

function tableRow(cells: Array<string | number>): string {
  return `| ${cells
    .map((cell) =>
      String(cell)
        .replace(/\|/g, '\\|')
        .replace(/[\r\n]/g, ' '),
    )
    .join(' | ')} |`;
}

function renderLaneList(lanes: AuditLane[]): string[] {
  if (lanes.length === 0) return ['- none'];
  return lanes.map((lane) => `- ${lane.id} ${lane.harness} ${lane.model ?? 'unknown'} ${lane.cwd ?? ''}`);
}

function renderIdleOpen(report: AuditReport): string[] {
  if (report.idleOpen.length === 0) return ['- none'];
  const now = Date.parse(report.generatedAt);
  const lines = ['| pane | agent | status | idle min |', '| --- | --- | --- | --- |'];
  for (const lane of report.idleOpen) {
    const minutes = lane.lastOutputAt === null ? '-' : Math.floor((now - lane.lastOutputAt) / 60_000);
    lines.push(tableRow([lane.id, lane.agentId ?? '', lane.status, minutes]));
  }
  return lines;
}

const PROCESS_HARNESS: Record<string, true> = { omp: true, grok: true, claude: true, devin: true };

export interface ProcessScan {
  /** Output of `ps -axo pid=,ppid=,command=`. */
  ps: string;
  /** Live run pids. The process or any ancestor in this set is skipped. */
  runPids?: readonly number[];
  /** `--ignore-pid`. The pid itself is skipped; descendants are not. */
  ignorePids?: readonly number[];
  /** Audit process pid. Its ancestors are skipped. */
  selfPid: number;
}

interface PsProc {
  pid: number;
  ppid: number;
  command: string;
  argv0: string;
}

/** Opt-in process lanes: omp/grok/claude/devin not covered by herdr, a live run, or the audit's own parents. */
export function lanesFromPs(scan: ProcessScan): AuditLane[] {
  const rows = parsePs(scan.ps);
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const runPids = new Set(scan.runPids ?? []);
  const ignorePids = new Set(scan.ignorePids ?? []);
  const selfAncestors = new Set(pidChain(scan.selfPid, byPid).filter((pid) => pid !== scan.selfPid));
  const lanes: AuditLane[] = [];
  const seen = new Set<number>();
  for (const row of rows) {
    if (seen.has(row.pid)) continue;
    seen.add(row.pid);
    if (!PROCESS_HARNESS[row.argv0]) continue;
    if (ignorePids.has(row.pid) || selfAncestors.has(row.pid)) continue;
    const chain = pidChain(row.pid, byPid);
    if (chain.some((pid) => runPids.has(pid))) continue;
    if (chain.slice(1).some((pid) => byPid.get(pid)?.argv0 === 'herdr')) continue;
    const model = modelFlag(row.command);
    const classified = classifyModel(model);
    lanes.push({
      id: `pid:${row.pid}`,
      source: 'process',
      harness: row.argv0,
      model,
      tier: classified.tier,
      provider: classified.provider,
      status: 'working',
      cwd: null,
      title: row.command,
      cardKind: null,
      cardKindSource: null,
      lastOutputAt: null,
      finished: false,
      recorded: false,
      agentId: null,
    });
  }
  return lanes;
}

function unrecordedDetail(lane: AuditLane): string {
  const where = [lane.cwd, lane.title].filter((part): part is string => part !== null && part !== '');
  return [lane.harness, lane.model ?? 'unknown', ...where].join(' ');
}

function parsePs(text: string): PsProc[] {
  const rows: PsProc[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const match = /^\s*(\d+)\s+(\d+)\s+(\S.*)$/.exec(line);
    if (!match) continue;
    const command = match[3].trim();
    const argv0 = command.split(/\s+/)[0] ?? '';
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command, argv0: basename(argv0) });
  }
  return rows;
}

/** Self, then each ancestor pid. Stops when a parent is missing from the snapshot. */
function pidChain(pid: number, byPid: Map<number, PsProc>): number[] {
  const chain = [pid];
  const seen = new Set<number>([pid]);
  let current = byPid.get(pid)?.ppid ?? 0;
  while (current > 0 && !seen.has(current)) {
    chain.push(current);
    seen.add(current);
    const parent = byPid.get(current);
    if (!parent) break;
    current = parent.ppid;
  }
  return chain;
}

function modelFlag(command: string): string | null {
  const tokens = command.split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? '';
    if (token === '--model') {
      const value = tokens[i + 1];
      return value && !value.startsWith('-') ? value : null;
    }
    if (token.startsWith('--model=')) return token.slice('--model='.length) || null;
  }
  return null;
}

function basename(token: string): string {
  const slash = Math.max(token.lastIndexOf('/'), token.lastIndexOf('\\'));
  return slash === -1 ? token : token.slice(slash + 1);
}
