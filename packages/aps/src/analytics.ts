import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import { ApsInputError, insertRow, transaction } from './ledger.js';
import { renderTodo } from './render.js';

const DAY = 86_400_000;
export interface LedgerMetrics {
  since: string;
  until: string;
  wip: number;
  reviewQueue: number;
  reported: number;
  revised: number;
  reworkRate: number | null;
  defects: number;
  opportunities: number;
  dpmo: number | null;
  cycleHours: number | null;
  flowEfficiency: number | null;
  passByModel: Record<string, SQLOutputValue>[];
  quota: Record<string, SQLOutputValue>[];
}
export function ledgerPeriodMetrics(db: DatabaseSync, options: { since?: string; week?: boolean }) {
  if (options.since && options.week) throw new ApsInputError('--since and --week are mutually exclusive');
  if (options.since && Number.isNaN(Date.parse(options.since))) throw new ApsInputError('--since must be an ISO date');
  const since = options.since
    ? new Date(options.since).toISOString()
    : options.week
      ? new Date(Date.now() - 7 * DAY).toISOString()
      : '1970-01-01T00:00:00.000Z';
  return ledgerMetrics(db, since);
}
export function ledgerBrief(
  db: DatabaseSync,
  by: string,
  level: string,
  metrics: LedgerMetrics,
  options: { save?: boolean; project?: string },
) {
  const markdown = `# APS ${level} briefing\n\nPeriod: ${metrics.since} → ${metrics.until}\n\nWIP: ${metrics.wip}\nReview queue: ${metrics.reviewQueue}\nRework rate: ${metrics.reworkRate ?? 'N/A'}\nDPMO: ${metrics.dpmo ?? 'N/A'}\nCycle hours: ${metrics.cycleHours ?? 'N/A'}\nFlow efficiency: ${metrics.flowEfficiency ?? 'N/A'}\n\n${renderTodo(db, options.project)}`;
  const id = options.save
    ? transaction(db, () =>
        insertRow(db, 'briefings', {
          level,
          author: by,
          period_from: metrics.since,
          period_to: metrics.until,
          body_md: markdown,
          metrics_json: JSON.stringify(metrics),
        }),
      )
    : null;
  return { markdown, metrics, id };
}
export function ledgerMetrics(db: DatabaseSync, since: string, until = new Date().toISOString()): LedgerMetrics {
  const count = (sql: string): number => Number(db.prepare(sql).get(since, until)?.n ?? 0);
  const reported = count("SELECT count(*) n FROM transitions WHERE to_state='reported' AND at>=? AND at<=?");
  const revised = count("SELECT count(*) n FROM transitions WHERE to_state='revise' AND at>=? AND at<=?");
  const defects = count('SELECT count(*) n FROM defects WHERE at>=? AND at<=?');
  const opportunities = count(
    `SELECT coalesce(sum(json_array_length(c.acceptance_json)),0) n FROM cards c JOIN
      (SELECT DISTINCT t.card_id, (SELECT count(*) FROM transitions w WHERE w.card_id=t.card_id AND w.to_state='working' AND w.id<t.id) attempt
       FROM transitions t WHERE t.to_state='inspecting' AND t.at>=? AND t.at<=?) inspected ON inspected.card_id=c.id`,
  );
  const cycles = db
    .prepare(`SELECT c.id, c.created_at,
    (SELECT min(at) FROM transitions WHERE card_id=c.id AND to_state='working') started,
    (SELECT max(at) FROM transitions WHERE card_id=c.id AND to_state='done') finished
    FROM cards c WHERE EXISTS(SELECT 1 FROM transitions WHERE card_id=c.id AND to_state='done' AND at>=? AND at<=?)`)
    .all(since, until);
  const cycleTimes: number[] = [];
  const efficiencies: number[] = [];
  for (const card of cycles) {
    const start = Date.parse(String(card.started));
    const end = Date.parse(String(card.finished));
    cycleTimes.push((end - start) / 3_600_000);
    const transitions = db.prepare('SELECT to_state,at FROM transitions WHERE card_id=? ORDER BY id').all(card.id);
    let working = 0;
    for (let i = 0; i < transitions.length - 1; i++) {
      if (transitions[i].to_state === 'working')
        working += Date.parse(String(transitions[i + 1].at)) - Date.parse(String(transitions[i].at));
    }
    const elapsed = end - Date.parse(String(card.created_at));
    if (elapsed > 0) efficiencies.push(working / elapsed);
  }
  const passByModel = db
    .prepare(`SELECT a.model,count(*) attempts,sum(v.verdict='accept') passed,
    1.0*sum(v.verdict='accept')/count(*) pass_rate FROM reviews v
    JOIN reports r ON r.id=(SELECT min(id) FROM reports WHERE card_id=v.card_id AND attempt=v.attempt AND status IN ('DONE','DONE_WITH_CONCERNS'))
    JOIN agents a ON a.id=r.by_agent WHERE v.id=(SELECT min(id) FROM reviews WHERE card_id=v.card_id AND attempt=v.attempt)
    AND v.at>=? AND v.at<=? GROUP BY a.model ORDER BY a.model`)
    .all(since, until);
  return {
    since,
    until,
    wip: Number(db.prepare("SELECT count(*) n FROM cards WHERE state NOT IN ('issued','done','rejected')").get()?.n),
    reviewQueue: Number(
      db.prepare("SELECT count(*) n FROM cards WHERE state IN ('reported','closed_session')").get()?.n,
    ),
    reported,
    revised,
    reworkRate: reported ? revised / reported : null,
    defects,
    opportunities,
    dpmo: opportunities ? (defects * 1_000_000) / opportunities : null,
    cycleHours: cycleTimes.length ? cycleTimes.reduce((a, b) => a + b, 0) / cycleTimes.length : null,
    flowEfficiency: efficiencies.length ? efficiencies.reduce((a, b) => a + b, 0) / efficiencies.length : null,
    passByModel,
    quota: db.prepare('SELECT * FROM quota_samples WHERE at>=? AND at<=? ORDER BY at,id').all(since, until),
  };
}
export function ledgerChart(db: DatabaseSync, metric: 'rework' | 'pass' | 'cycle', days: number, now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - (days - 1) * DAY);
  const points = Array.from({ length: days }, (_, index) => {
    const day = new Date(start.getTime() + index * DAY).toISOString().slice(0, 10);
    if (metric === 'cycle') {
      const rows = db
        .prepare(
          `SELECT (julianday(t.at)-julianday((SELECT min(at) FROM transitions WHERE card_id=t.card_id AND to_state='working')))*24 value FROM transitions t WHERE t.to_state='done' AND substr(t.at,1,10)=?`,
        )
        .all(day);
      const values = rows.map((row) => Number(row.value));
      return {
        day,
        n: values.length,
        numerator: values.reduce((a, b) => a + b, 0),
        values,
        value: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
      };
    }
    const row =
      metric === 'rework'
        ? db
            .prepare(
              "SELECT sum(to_state='reported') n,sum(to_state='revise') numerator FROM transitions WHERE substr(at,1,10)=?",
            )
            .get(day)
        : db
            .prepare(
              "SELECT count(*) n,sum(verdict='accept') numerator FROM reviews v WHERE substr(at,1,10)=? AND id=(SELECT min(id) FROM reviews WHERE card_id=v.card_id AND attempt=v.attempt)",
            )
            .get(day);
    const n = Number(row?.n ?? 0);
    const numerator = Number(row?.numerator ?? 0);
    return { day, n, numerator, values: [], value: n ? numerator / n : null };
  });
  const n = points.reduce((sum, point) => sum + point.n, 0);
  const centre = n ? points.reduce((sum, point) => sum + point.numerator, 0) / n : null;
  const values = points.flatMap((point) => point.values);
  const variance =
    centre !== null && values.length > 1
      ? values.reduce((sum, value) => sum + (value - centre) ** 2, 0) / (values.length - 1)
      : null;
  return {
    metric,
    days,
    centre,
    points: points.map(({ values: _values, ...point }) => {
      const spread =
        point.n && centre !== null
          ? metric === 'cycle'
            ? variance === null
              ? null
              : 3 * Math.sqrt(variance / point.n)
            : 3 * Math.sqrt(Math.max(0, centre * (1 - centre)) / point.n)
          : null;
      return {
        ...point,
        centre,
        ucl:
          spread === null || centre === null
            ? null
            : metric === 'cycle'
              ? centre + spread
              : Math.min(1, centre + spread),
        lcl: spread === null || centre === null ? null : Math.max(0, centre - spread),
      };
    }),
  };
}
