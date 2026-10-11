import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { listMigrations } from './index.js';
import { ApsInputError } from './ledger.js';
import type { RunStatus } from './runs.js';

const LIVE_RUN_STATUSES: readonly RunStatus[] = ['intent', 'launched', 'reported'];

export type CardState =
  | 'issued'
  | 'working'
  | 'reported'
  | 'closed_session'
  | 'inspecting'
  | 'revise'
  | 'accepted'
  | 'merge_wait'
  | 'done'
  | 'rejected';
export type Layer = 'L0' | 'L1' | 'L2' | 'L3';
export interface LaneRow {
  project: string;
  lane: string;
  layer: Layer | null;
  layerOwner: string;
  state: CardState;
  kanbanKo: string;
  stateOrd: number;
  n: number;
  oldestSince: string;
}
export interface TransitionRow {
  fromState: CardState | null;
  toState: CardState;
  byAgent: string;
  note: string;
  at: string;
}
export interface ReportRow {
  id: number;
  attempt: number;
  byAgent: string;
  sha: string;
  branch: string;
  prUrl: string | null;
  filesJson: string;
  evidenceJson: string;
  risks: string;
  status: 'DONE' | 'DONE_WITH_CONCERNS' | 'BLOCKED';
  bodyMd: string;
  at: string;
}
export interface ReviewEvidenceRow {
  id: number;
  attempt: number;
  sha: string;
  reviewer: string;
  layer: Layer;
  verdict: 'accept' | 'revise' | 'reject';
  itemsJson: string;
  at: string;
}
export interface VisionAuditRow {
  id: number;
  attempt: number;
  sha: string;
  auditor: string;
  verdict: 'pass' | 'fail';
  screenshotsJson: string;
  itemsJson: string;
  notes: string;
  at: string;
}
export interface LinkRow {
  kind: string;
  ref: string;
  detailJson: string;
  at: string;
}
export interface RunRow {
  runId: string;
  cardId: string;
  attempt: number;
  agentId: string;
  harness: 'herdr' | 'omp' | 'devin' | 'grok';
  kind: 'omp' | 'devin' | 'grok' | null;
  model: string;
  worktree: string;
  branch: string;
  packetDir: string;
  status: RunStatus;
  since: string;
  workspaceId: string | null;
  tabId: string | null;
  paneId: string | null;
  terminalId: string | null;
  pid: number | null;
  sessionRef: string | null;
  reportPresent: boolean;
  events: { status: RunStatus; byAgent: string; detailJson: string; at: string }[];
}
export interface CardRow {
  cardId: string;
  project: string;
  title: string;
  kind: string;
  state: CardState;
  kanbanKo: string;
  stateOrd: number;
  since: string;
  assignee: string | null;
  layerOwner: string;
  lane: string;
  model: string | null;
  assigneeStatus: string | null;
  herdrPane: string | null;
  attempt: number;
  reworkCount: number;
  needsOwner: number;
  needsVision: number;
  sha: string | null;
  reportStatus: string | null;
  latestReview: string | null;
  latestVision: string | null;
  mergeOk: number;
  ownerOk: number;
  acceptanceCount: number;
  timeline: TransitionRow[];
  reports: ReportRow[];
  reviews: ReviewEvidenceRow[];
  visionAudits: VisionAuditRow[];
  links: LinkRow[];
  runs: RunRow[];
  nextBlockers: string[];
}
export interface ReviewRow {
  cardId: string;
  project: string;
  title: string;
  state: 'reported' | 'closed_session' | 'inspecting';
  since: string;
  attempt: number;
  reworkCount: number;
  needsOwner: number;
  needsVision: number;
  lane: string;
  model: string | null;
  sha: string | null;
  reportStatus: string | null;
  prUrl: string | null;
  reportedAt: string | null;
}
export interface CostLaneRow {
  lane: string;
  runs: number;
  usdActual: number | null;
  ioTokens: number;
  cacheRead: number;
  runsUnknown: number;
  runsUncollected: number;
}
export interface CostCardRow extends CostLaneRow {
  cardId: string;
  project: string;
  harness: RunRow['harness'];
  kind: RunRow['kind'];
  model: string;
}
export interface QuotaRow {
  vendor: string;
  account: string;
  metric: string;
  value: number;
  at: string;
}
export interface HerdrPane {
  paneId: string;
  terminalId: string;
  tabId?: string;
  workspaceId?: string;
  agent: string | null;
  agentStatus: string | null;
  sessionRef?: string | null;
  cwd?: string;
}
export interface HygieneLedgerRow {
  agentId: string;
  lane: string;
  layer: Layer;
  agentStatus: string;
  herdrPane: string | null;
  startedAt: string;
  closedAt: string | null;
  cardId: string | null;
  cardState: CardState | null;
  runId: string | null;
  harness: RunRow['harness'] | null;
  kind: RunRow['kind'];
  runStatus: RunStatus | null;
  runSince: string | null;
  paneId: string | null;
  terminalId: string | null;
  pid: number | null;
  packetDir: string | null;
  sessionRef: string | null;
  /** Observations supplied by the CLI; the classifier never probes files or processes. */
  pidAlive?: boolean;
  yieldPresent?: boolean;
}
export type HygieneClass = 'OK' | 'CLOSE-NOW' | 'LEAK' | 'GHOST' | 'STUCK-INTENT' | 'UNTRACKED' | '?';
export interface HygieneRow {
  classification: HygieneClass;
  agentId: string | null;
  lane: string;
  cardId: string | null;
  runId: string | null;
  paneId: string | null;
  action: string | null;
  ledger: HygieneLedgerRow | null;
  pane: HerdrPane | null;
}
export interface BoardSnapshot {
  readAt: string;
  dbPath: string;
  schemaVersion: number;
  runsAvailable: boolean;
  header: {
    wip: number;
    reviewQueue: number;
    inReview: number;
    feedbackOverdue: number;
    feedbackOpen: number;
    feedbackEscalated: number;
    paused: boolean;
    reviewers: number;
  };
  lanes: LaneRow[];
  cards: CardRow[];
  reviewQueue: ReviewRow[];
  cost: { byLane: CostLaneRow[]; byCard: CostCardRow[]; quota: QuotaRow[] } | null;
  hygiene: HygieneRow[];
  herdr: { ok: boolean; at: string | null; error?: string; shells: number };
  stale: { db?: string; herdr?: string };
}

export function openApsDbReadOnly(path: string): DatabaseSync {
  if (!existsSync(path)) throw new ApsInputError(`ledger not found at ${path}`);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    assertKnownSchema(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function dataVersion(db: DatabaseSync): number {
  return Number(db.prepare('PRAGMA data_version').get()?.data_version);
}

function assertKnownSchema(db: DatabaseSync): number {
  const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
  const latest = listMigrations().at(-1)?.version ?? 0;
  if (version > latest) {
    throw new ApsInputError(`APS-U01: ledger schema v${version} is newer than this build (max v${latest})`);
  }
  return version;
}

/** Maps ledger column names to the board's camelCase JSON contract. */
function rows<T>(db: DatabaseSync, sql: string, ...params: SQLInputValue[]): T[] {
  return db
    .prepare(sql)
    .all(...params)
    .map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), value]),
      ),
    ) as T[];
}

export function classifyHygiene(
  ledgerRows: readonly HygieneLedgerRow[],
  panes: readonly HerdrPane[] | null,
  now: Date = new Date(),
): HygieneRow[] {
  const paneMap = new Map(panes?.map((pane) => [pane.paneId, pane]));
  const matched = new Set<string>();
  const result: HygieneRow[] = [];
  const liveAgents = new Set<string>();
  for (const row of ledgerRows) {
    if (row.runStatus !== null && LIVE_RUN_STATUSES.includes(row.runStatus)) liveAgents.add(row.agentId);
  }
  for (const row of ledgerRows) {
    const terminalRun = row.runStatus !== null && !LIVE_RUN_STATUSES.includes(row.runStatus);
    if (terminalRun && liveAgents.has(row.agentId)) continue;
    // Without a live replacement, terminal runs still identify lingering panes.
    const runStatus = terminalRun ? null : row.runStatus;
    const paneId = row.paneId ?? row.herdrPane;
    const candidate = paneId ? paneMap.get(paneId) : undefined;
    const pane = candidate && (row.terminalId === null || row.terminalId === candidate.terminalId) ? candidate : null;
    if (pane) matched.add(pane.paneId);
    let classification: HygieneClass | null = null;
    let action: string | null = null;
    if (runStatus === 'intent' && row.runSince && now.getTime() - Date.parse(row.runSince) > 120_000) {
      classification = 'STUCK-INTENT';
      action = `inspect ${row.packetDir}/dispatch.log; mmbridge aps collect ${row.cardId} --abandon --by <you>`;
    } else if (paneId && panes === null) {
      classification = '?';
    } else if (pane && row.agentStatus === 'closed') {
      classification = 'LEAK';
      action = `herdr pane close ${pane.paneId}`;
    } else if (
      pane &&
      (['reported', 'closed_session', 'inspecting', 'revise', 'accepted', 'merge_wait', 'done', 'rejected'].includes(
        row.cardState ?? '',
      ) ||
        pane.agentStatus === 'done')
    ) {
      classification = 'CLOSE-NOW';
    } else if (
      row.agentStatus !== 'closed' &&
      ((paneId && !pane) || row.pidAlive === false || row.yieldPresent === true)
    ) {
      classification = 'GHOST';
    } else if (
      row.agentStatus !== 'closed' &&
      row.cardState === 'working' &&
      pane &&
      ['working', 'idle'].includes(pane.agentStatus ?? '')
    ) {
      classification = 'OK';
    } else if (row.agentStatus !== 'closed' && row.cardState === 'working' && pane) {
      classification = '?';
    }
    if (!classification) continue;
    if (classification === 'CLOSE-NOW' || classification === 'GHOST') {
      action = row.cardId ? `mmbridge aps collect ${row.cardId} --by <you>` : null;
    }
    result.push({
      classification,
      agentId: row.agentId,
      lane: row.lane,
      cardId: row.cardId,
      runId: row.runId,
      paneId,
      action,
      ledger: row,
      pane,
    });
  }
  for (const pane of panes ?? []) {
    if (pane.agent && !matched.has(pane.paneId)) {
      result.push({
        classification: 'UNTRACKED',
        agentId: null,
        lane: pane.agent,
        cardId: null,
        runId: null,
        paneId: pane.paneId,
        action: null,
        ledger: null,
        pane,
      });
    }
  }
  return result;
}

function blockers(card: CardRow): string[] {
  switch (card.state) {
    case 'issued':
      return ['dispatch (none assigned)'];
    case 'working': {
      const run = card.runs.at(-1);
      return [
        run?.status ?? 'working (no tracked run)',
        run ? `report.json ${run.reportPresent ? 'present' : 'missing'}` : 'no packet directory',
      ];
    }
    case 'reported':
      return [`S01: session not closed → mmbridge aps collect ${card.cardId}`];
    case 'closed_session':
      return ['manager inspect'];
    case 'inspecting':
      return [`review needed (independent of ${card.lane})`];
    case 'accepted':
    case 'merge_wait':
      return [
        !card.mergeOk && 'D02 merge/apply',
        card.needsVision && card.latestVision !== 'pass' && 'D04 vision',
        card.needsOwner && !card.ownerOk && 'D05 owner OK',
      ].filter((item): item is string => typeof item === 'string');
    case 'revise':
      return [`rework count ${card.reworkCount}/3${card.reworkCount >= 3 ? ' (reject only: D6)' : ''}`];
    default:
      return [];
  }
}

export interface BoardReadOptions {
  project?: string;
  since?: string;
  now?: Date;
  /** null/omitted means unavailable, never an empty successful observation. */
  panes?: readonly HerdrPane[] | null;
  herdrAt?: string;
  herdrError?: string;
  /** Adds process/yield observations without making the read model perform I/O. */
  observations?: Readonly<Record<string, { pidAlive?: boolean; yieldPresent?: boolean }>>;
}

/** All ledger reads share one deferred read transaction; this never escalates feedback or migrates. */
export function readBoardSnapshot(db: DatabaseSync, options: BoardReadOptions = {}): BoardSnapshot {
  const now = options.now ?? new Date();
  const readAt = now.toISOString();
  const since = options.since
    ? new Date(options.since).toISOString()
    : new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const today = `${readAt.slice(0, 10)}T00:00:00.000Z`;
  const project = options.project ?? null;
  db.exec('BEGIN');
  try {
    const schemaVersion = assertKnownSchema(db);
    const runsAvailable = schemaVersion >= 2;
    const cards = rows<CardRow>(
      db,
      `SELECT k.*, v.sha, v.report_status, v.latest_review, v.latest_vision,
      v.merge_ok, v.owner_ok, v.acceptance_count, coalesce(a.name,'(unassigned)') lane, a.model,
      a.status assignee_status, a.herdr_pane FROM v_kanban k JOIN v_card_current v ON v.card_id=k.card_id
      LEFT JOIN agents a ON a.id=k.assignee WHERE (? IS NULL OR k.project=?) ORDER BY k.project,k.state_ord,k.since,k.card_id`,
      project,
      project,
    );
    for (const card of cards) {
      card.timeline = rows(
        db,
        'SELECT from_state,to_state,by_agent,note,at FROM transitions WHERE card_id=? ORDER BY id',
        card.cardId,
      );
      card.reports = rows(db, 'SELECT * FROM reports WHERE card_id=? ORDER BY id DESC LIMIT 3', card.cardId);
      card.reviews = rows(db, 'SELECT * FROM reviews WHERE card_id=? ORDER BY id', card.cardId);
      card.visionAudits = rows(db, 'SELECT * FROM vision_audits WHERE card_id=? ORDER BY id', card.cardId);
      card.links = rows(db, 'SELECT kind,ref,detail_json,at FROM card_links WHERE card_id=? ORDER BY id', card.cardId);
      card.runs = runsAvailable
        ? rows(db, 'SELECT * FROM v_run_current WHERE card_id=? ORDER BY since,run_id', card.cardId)
        : [];
      for (const run of card.runs) {
        run.events = rows(
          db,
          'SELECT status,by_agent,detail_json,at FROM run_events WHERE run_id=? ORDER BY id',
          run.runId,
        );
        run.reportPresent = existsSync(join(run.packetDir, 'report.json'));
      }
      card.nextBlockers = blockers(card);
    }
    const lanes = rows<LaneRow>(
      db,
      `SELECT k.project,coalesce(a.name,'(unassigned)') lane,min(a.layer) layer,min(k.layer_owner) layer_owner,
      k.state,k.kanban_ko,k.state_ord,count(*) n,min(k.since) oldest_since FROM v_kanban k LEFT JOIN agents a ON a.id=k.assignee
      WHERE (? IS NULL OR k.project=?) AND (k.state NOT IN ('done','rejected') OR k.since>=?)
      GROUP BY k.project,lane,CASE WHEN a.id IS NULL THEN k.layer_owner END,k.state,k.kanban_ko,k.state_ord
      ORDER BY k.project,lane,k.state_ord,layer_owner`,
      project,
      project,
      today,
    );
    const counts = rows<{ wip: number; reviewQueue: number; inReview: number }>(
      db,
      `SELECT
      coalesce(sum(state NOT IN ('issued','done','rejected')),0) wip,
      coalesce(sum(state IN ('reported','closed_session')),0) review_queue,
      coalesce(sum(state='inspecting'),0) in_review FROM cards WHERE (? IS NULL OR project=?)`,
      project,
      project,
    )[0];
    const reviewers = Number(
      db.prepare("SELECT count(*) n FROM agents WHERE status<>'closed' AND layer IN ('L1','L2')").get()?.n,
    );
    const minutes = Number(
      db.prepare("SELECT value FROM settings WHERE key='feedback_escalate_minutes'").get()?.value ?? 30,
    );
    const cutoff = new Date(now.getTime() - (Number.isFinite(minutes) ? minutes : 30) * 60_000).toISOString();
    const feedback = rows<{ feedbackOpen: number; feedbackEscalated: number; feedbackOverdue: number }>(
      db,
      `SELECT
      coalesce(sum(f.response IS NULL),0) feedback_open,coalesce(sum(f.response IS NULL AND f.escalated=1),0) feedback_escalated,
      coalesce(sum(f.response IS NULL AND f.escalated=0 AND f.created_at<=?),0) feedback_overdue
      FROM feedback f`,
      cutoff,
    )[0];
    const reviewQueue = rows<ReviewRow>(
      db,
      `SELECT k.card_id,k.project,k.title,k.state,k.since,k.attempt,k.rework_count,
      k.needs_owner,k.needs_vision,coalesce(a.name,'(unassigned)') lane,a.model,v.sha,v.report_status,r.pr_url,r.at reported_at
      FROM v_kanban k JOIN v_card_current v ON v.card_id=k.card_id LEFT JOIN agents a ON a.id=k.assignee
      LEFT JOIN reports r ON r.id=v.report_id WHERE k.state IN ('reported','closed_session','inspecting') AND (? IS NULL OR k.project=?)
      ORDER BY (k.state='reported') DESC,k.since,k.card_id`,
      project,
      project,
    );
    let cost: BoardSnapshot['cost'] = null;
    if (runsAvailable) {
      const totals = `count(DISTINCT wr.id) runs,sum(rc.usd_actual) usd_actual,coalesce(sum(rc.io_tokens),0) io_tokens,
        coalesce(sum(rc.cache_read_tokens),0) cache_read,sum(rc.unknown_rows>0) runs_unknown,sum(rc.usage_rows=0) runs_uncollected`;
      const source = `FROM worker_runs wr JOIN agents a ON a.id=wr.agent_id JOIN cards c ON c.id=wr.card_id
        JOIN v_run_cost rc ON rc.run_id=wr.id WHERE wr.at>=? AND (? IS NULL OR c.project=?)`;
      cost = {
        byLane: rows(
          db,
          `SELECT a.name lane,${totals} ${source} GROUP BY a.name ORDER BY usd_actual DESC NULLS LAST,lane`,
          since,
          project,
          project,
        ),
        byCard: rows(
          db,
          `SELECT a.name lane,wr.card_id,c.project,wr.harness,wr.kind,wr.model,${totals} ${source}
          GROUP BY a.name,wr.card_id,c.project,wr.harness,wr.kind,wr.model ORDER BY usd_actual DESC NULLS LAST,wr.card_id`,
          since,
          project,
          project,
        ),
        quota: rows(
          db,
          `SELECT q.vendor,q.account,q.metric,q.value,q.at FROM quota_samples q WHERE q.id=(
          SELECT x.id FROM quota_samples x WHERE x.vendor=q.vendor AND x.account=q.account AND x.metric=q.metric ORDER BY x.at DESC,x.id DESC LIMIT 1)
          ORDER BY q.vendor,q.account,q.metric`,
        ),
      };
    }
    const runFields = runsAvailable
      ? 'r.run_id,r.harness,r.kind,r.status run_status,r.since run_since,r.pane_id,r.terminal_id,r.pid,r.packet_dir,r.session_ref'
      : 'NULL run_id,NULL harness,NULL kind,NULL run_status,NULL run_since,NULL pane_id,NULL terminal_id,NULL pid,NULL packet_dir,NULL session_ref';
    const ledgerRows = rows<HygieneLedgerRow>(
      db,
      `SELECT a.id agent_id,a.name lane,a.layer,a.status agent_status,a.herdr_pane,a.started_at,a.closed_at,
      c.id card_id,c.state card_state,${runFields} FROM agents a ${runsAvailable ? 'LEFT JOIN v_run_current r ON r.agent_id=a.id' : ''}
      LEFT JOIN cards c ON c.assignee=a.id AND c.state NOT IN ('done','rejected') ${runsAvailable ? 'AND (r.card_id IS NULL OR c.id=r.card_id)' : ''}
      WHERE (a.status<>'closed' OR (a.herdr_pane IS NOT NULL AND a.closed_at>=?) ${runsAvailable ? "OR r.status IN ('intent','launched','reported')" : ''})
      AND (? IS NULL OR c.project=? OR a.project=?)`,
      new Date(now.getTime() - 86_400_000).toISOString(),
      project,
      project,
      project,
    );
    for (const row of ledgerRows) Object.assign(row, options.observations?.[row.runId ?? row.agentId]);
    const panes = options.panes ?? null;
    const snapshot: BoardSnapshot = {
      readAt,
      dbPath: String(
        db
          .prepare('PRAGMA database_list')
          .all()
          .find((row) => row.name === 'main')?.file ?? '',
      ),
      schemaVersion,
      runsAvailable,
      header: { ...counts, ...feedback, reviewers, paused: counts.reviewQueue > 2 * reviewers },
      lanes,
      cards,
      reviewQueue,
      cost,
      hygiene: classifyHygiene(ledgerRows, panes, now),
      herdr: {
        ok: panes !== null,
        at: options.herdrAt ?? null,
        shells: panes?.filter((pane) => !pane.agent).length ?? 0,
        ...(options.herdrError ? { error: options.herdrError } : {}),
      },
      stale: options.herdrError ? { herdr: options.herdrError } : {},
    };
    db.exec('COMMIT');
    return snapshot;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
