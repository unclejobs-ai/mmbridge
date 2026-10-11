import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ApsInputError as InputError, type LedgerLink, type Row, type Transition } from '@mmbridge/aps';
import { ContextTree, projectKeyFromDir } from '@mmbridge/context-broker';
import type { Session } from '@mmbridge/session-store';
import { computeGate } from './gate.js';
import { exitWithError, importAps, importCore, importSessionStore, jsonOutput } from './helpers.js';

export interface ApsCommandOptions {
  db?: string;
  json?: boolean;
  by?: string;
  project?: string;
  projectDir?: string;
  name?: string;
  prefix?: string;
  layer?: string;
  model?: string;
  vendor?: string;
  herdrPane?: string;
  title?: string;
  kind?: string;
  size?: string;
  scope?: string;
  acceptance?: string;
  forbidden?: string;
  needsOwner?: string;
  needsVision?: string;
  owner?: string | boolean;
  assignee?: string;
  parent?: string;
  body?: string;
  sourceRef?: string;
  asPrompt?: boolean;
  state?: string;
  sha?: string;
  branch?: string;
  files?: string;
  evidence?: string;
  status?: string;
  risks?: string;
  pr?: string;
  recordedBy?: string;
  note?: string;
  abandon?: boolean;
  verdict?: string;
  items?: string;
  fromSession?: string;
  category?: string;
  shots?: string;
  notes?: string;
  quote?: string;
  mergedSha?: string;
  appliedRef?: string;
  target?: string;
  gate?: boolean;
  baseRef?: string;
  out?: string;
  level?: string;
  since?: string;
  save?: boolean;
  week?: boolean;
  metric?: string;
  days?: string;
  to?: string;
  response?: string;
  reason?: string;
  card?: string;
  text?: string;
  source?: string;
  severity?: string;
  ref?: string;
}
function required(value: unknown, flag: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new InputError(`--${flag} is required`);
  return value;
}
function choice(value: unknown, flag: string, allowed: string[], fallback?: string): string {
  const text = value === undefined && fallback !== undefined ? fallback : required(value, flag);
  if (!allowed.includes(text)) throw new InputError(`--${flag} must be ${allowed.join('|')}`);
  return text;
}
function fileText(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    throw new InputError(`cannot read file ${file}`);
  }
}
function jsonFile(value: string | undefined, flag: string, fallback?: string): string {
  if (value === undefined && fallback !== undefined) return fallback;
  const path = required(value, flag);
  const content = fileText(path.startsWith('@') ? path.slice(1) : path);
  try {
    return JSON.stringify(JSON.parse(content));
  } catch {
    throw new InputError(`--${flag}: invalid JSON in ${path}`);
  }
}
function sha(value: string | undefined, flag: string): string {
  const text = required(value, flag).toLowerCase();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(text)) throw new InputError(`--${flag} must be a 40 or 64 digit hex SHA`);
  return text;
}
function emit(value: unknown, json?: boolean): void {
  if (json) {
    jsonOutput(value);
    return;
  }
  if (typeof value === 'string') process.stdout.write(`${value}\n`);
  else if (Array.isArray(value) && value.every((row) => row && typeof row === 'object' && 'from' in row)) {
    for (const row of value as Transition[])
      process.stdout.write(`${row.card} ${row.from ?? '(new)'}→${row.to} by ${row.by} (attempt ${row.attempt})\n`);
  } else if (value && typeof value === 'object' && 'id' in value) process.stdout.write(`${value.id}\n`);
  else process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
async function withLedger(
  options: ApsCommandOptions,
  action: (db: DatabaseSync, by: string) => Promise<unknown>,
): Promise<void> {
  const aps = await importAps();
  let db: DatabaseSync | undefined;
  try {
    const by = required(options.by ?? process.env.APS_AGENT, 'by');
    const core = await importCore();
    const config = await core.loadConfig(resolve(options.projectDir ?? process.cwd()));
    db = aps.openApsDb(aps.resolveApsDbPath({ flag: options.db, configPath: config.aps?.dbPath }));
    const ledger = db;
    const result = await aps.commandTransaction(ledger, async () => {
      aps.doctor(ledger);
      const warnings = aps.escalateFeedback(ledger);
      const value = await action(ledger, by);
      return { value, warnings };
    });
    for (const warning of result.warnings) process.stderr.write(`[mmbridge] ${warning}\n`);
    emit(result.value, options.json);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = message.startsWith('APS-')
      ? 3
      : error instanceof InputError ||
          error instanceof aps.ApsInputError ||
          /(?:CHECK|NOT NULL|UNIQUE|FOREIGN KEY) constraint failed/.test(message)
        ? 2
        : 1;
    db?.close();
    db = undefined;
    exitWithError(message, code);
  } finally {
    db?.close();
  }
}
export async function runApsCommand(
  command: string,
  id: string | undefined,
  options: ApsCommandOptions,
): Promise<void> {
  const aps = await importAps();
  await withLedger(options, async (db, by) => {
    const cardId = id ?? '';
    const projectDir = resolve(options.projectDir ?? process.cwd());
    switch (command) {
      case 'init':
        return { user_version: db.prepare('PRAGMA user_version').get()?.user_version };
      case 'doctor':
        return aps.doctor(db);
      case 'project-add': {
        aps.transaction(db, () =>
          aps.insertRow(db, 'projects', {
            id: cardId,
            prefix: required(options.prefix, 'prefix'),
            name: required(options.name, 'name'),
          }),
        );
        return { id: cardId };
      }
      case 'agent-new':
        return {
          id: aps.newAgent(db, {
            name: required(options.name, 'name'),
            layer: choice(options.layer, 'layer', ['L0', 'L1', 'L2', 'L3']),
            model: required(options.model, 'model'),
            vendor: required(options.vendor, 'vendor'),
            project: options.project ?? null,
            herdr_pane: options.herdrPane ?? null,
          }),
        };
      case 'card-new': {
        const changes = aps.issueCard(db, {
          project: required(options.project, 'project'),
          title: required(options.title, 'title'),
          kind: choice(options.kind, 'kind', ['mech', 'design', 'review', 'vision', 'research']),
          size: choice(options.size, 'size', ['S', 'M', 'L']),
          scope: required(options.scope, 'scope'),
          acceptance_json: jsonFile(options.acceptance, 'acceptance'),
          forbidden: required(options.forbidden, 'forbidden'),
          needs_owner: Number(choice(options.needsOwner, 'needs-owner', ['0', '1'], '0')),
          needs_vision: Number(choice(options.needsVision, 'needs-vision', ['0', '1'], '0')),
          layer_owner: required(options.owner, 'owner'),
          assignee: options.assignee ?? null,
          parent_card: options.parent ?? null,
          body_md: options.body ? fileText(options.body) : '',
          source_ref: options.sourceRef ?? null,
        });
        const core = await importCore();
        const git = await core.runCommand('git', ['rev-parse', '--is-inside-work-tree'], { cwd: projectDir });
        if (git.ok && git.stdout.trim() === 'true') {
          const { SessionStore } = await importSessionStore();
          const parent = options.parent
            ? db
                .prepare("SELECT ref FROM card_links WHERE card_id=? AND kind='context_node' ORDER BY id DESC LIMIT 1")
                .get(options.parent)
            : null;
          const detail = {
            parentId: parent ? String(parent.ref) : null,
            summary: `${changes[0].card} ${options.title}`,
            projectKey: projectKeyFromDir(projectDir),
          };
          const node = await new ContextTree(new SessionStore().baseDir).append({
            type: 'task',
            ...detail,
            data: { cardId: changes[0].card },
          });
          aps.transaction(db, () => aps.addLink(db, changes[0].card, by, 'context_node', node.id, detail));
        }
        return changes;
      }
      case 'card-show': {
        if (options.asPrompt && options.json) throw new InputError('--as-prompt and --json are mutually exclusive');
        if (options.asPrompt) return aps.renderCardPrompt(db, cardId);
        const card = aps.getCard(db, cardId);
        const links = db.prepare('SELECT * FROM card_links WHERE card_id=? ORDER BY id').all(cardId);
        const { SessionStore } = await importSessionStore();
        const tree = new ContextTree(new SessionStore().baseDir);
        const lineage = [];
        for (const link of links.filter((row) => row.kind === 'context_node')) {
          const detail = JSON.parse(String(link.detail_json));
          lineage.push({
            ...detail,
            ref: link.ref,
            label: (await tree.getNode(String(link.ref), detail.projectKey)) ? 'context' : '(compacted)',
          });
        }
        return {
          ...card,
          current: db.prepare('SELECT * FROM v_card_current WHERE card_id=?').get(cardId),
          history: db.prepare('SELECT * FROM transitions WHERE card_id=? ORDER BY id').all(cardId),
          links,
          lineage,
        };
      }
      case 'card-list':
        return db
          .prepare(
            'SELECT * FROM v_kanban WHERE (? IS NULL OR project=?) AND (? IS NULL OR state=?) AND (? IS NULL OR assignee=?) ORDER BY state_ord,card_id',
          )
          .all(
            options.project ?? null,
            options.project ?? null,
            options.state ?? null,
            options.state ?? null,
            options.assignee ?? null,
            options.assignee ?? null,
          );
      case 'start':
        return aps.startCard(db, cardId, required(options.assignee, 'assignee'));
      case 'return':
        return aps.transaction(db, () => [aps.moveCard(db, cardId, 'issued', by, required(options.note, 'note'))]);
      case 'reject':
        return aps.transaction(db, () => [aps.moveCard(db, cardId, 'rejected', by, required(options.note, 'note'))]);
      case 'done':
        return aps.transaction(db, () => [aps.moveCard(db, cardId, 'done', by)]);
      case 'report': {
        let files = required(options.files, 'files');
        if (files.startsWith('@')) files = fileText(files.slice(1));
        try {
          files = JSON.stringify(JSON.parse(files));
        } catch {
          throw new InputError('--files must be JSON or @file');
        }
        return aps.recordReport(db, cardId, {
          by_agent: by,
          recorded_by: options.recordedBy ?? null,
          sha: sha(options.sha, 'sha'),
          branch: required(options.branch, 'branch'),
          files_json: files,
          evidence_json: jsonFile(options.evidence, 'evidence'),
          status: choice(options.status, 'status', ['DONE', 'DONE_WITH_CONCERNS', 'BLOCKED']),
          risks: options.risks ?? '',
          pr_url: options.pr ?? null,
          body_md: options.body ? fileText(options.body) : '',
        });
      }
      case 'close-session': {
        const agent = aps.getAgent(db, cardId);
        if (agent.herdr_pane) {
          const core = await importCore();
          const result = await core.runCommand('herdr', ['agent', 'list'], { cwd: projectDir });
          if (!result.ok) throw new Error('cannot confirm pane ended: herdr agent list failed');
          const pane = String(agent.herdr_pane);
          if (result.stdout.split(/[^A-Za-z0-9_:.@-]+/).includes(pane))
            throw new Error(`APS-H01: herdr pane ${pane} is still listed by 'herdr agent list'`);
        }
        return aps.closeSession(db, cardId, by, required(options.note, 'note'), Boolean(options.abandon));
      }
      case 'review': {
        const card = aps.getCard(db, cardId);
        let items = jsonFile(options.items, 'items', '[]');
        let session: Session | null = null;
        let gate: string | null = null;
        const links: LedgerLink[] = [];
        if (options.fromSession) {
          const uuid = options.fromSession.toLowerCase();
          if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(uuid))
            throw new InputError('--from-session must be a UUID');
          const { SessionStore, ProjectMemoryStore } = await importSessionStore();
          const store = new SessionStore();
          session = await store.get(uuid);
          if (!session) throw new Error(`APS-H04: mmbridge session ${uuid} not found`);
          if (session.head?.sha !== card.sha)
            throw new Error(
              `APS-H02: mmbridge session ${uuid} head.sha ${session.head?.sha} != reported sha ${card.sha}`,
            );
          const severity = { CRITICAL: 'blocker', WARNING: 'major', INFO: 'minor', REFACTOR: 'nit' };
          const imported = (session.findings ?? [])
            .filter(
              (finding) =>
                !session?.findingDecisions?.some(
                  (decision) =>
                    decision.status === 'dismissed' &&
                    decision.key === `${finding.severity}:${finding.file}:${finding.line ?? ''}:${finding.message}`,
                ),
            )
            .map((finding) => ({
              severity: severity[finding.severity],
              category: options.category ?? 'correctness',
              text: finding.message,
              ref: `${finding.file}${finding.line === null ? '' : `:${finding.line}`}`,
            }));
          items = JSON.stringify([...JSON.parse(items), ...imported]);
          const computed = await computeGate(session.projectDir, { mode: session.mode, baseRef: session.baseRef });
          if (computed.latestSessionId !== uuid) {
            computed.result.status = 'warn';
            computed.result.warnings.push({
              code: 'stale-review',
              message: `Imported session ${uuid} is not the latest session`,
              nextCommand: `mmbridge gate --project ${session.projectDir}`,
            });
          }
          gate = JSON.stringify({ ...computed.result, baseRef: computed.baseRef, diffDigest: computed.diffDigest });
          if (session.runId) links.push({ kind: 'mmbridge_run', ref: session.runId });
          if (session.handoffId || session.handoffPath) {
            const memory = new ProjectMemoryStore(store.baseDir);
            const document = await memory.getHandoffBySession(session.projectDir, uuid);
            links.push({
              kind: 'handoff',
              ref: session.handoffId ?? uuid,
              detail: {
                sessionId: uuid,
                markdownPath: document?.artifact.markdownPath ?? session.handoffPath,
                jsonPath:
                  document?.artifact.jsonPath ?? resolve(memory.handoffsDir(session.projectDir), `${uuid}.json`),
              },
            });
          }
        }
        return aps.recordReview(
          db,
          cardId,
          by,
          {
            verdict: choice(options.verdict, 'verdict', ['accept', 'revise', 'reject']),
            items_json: items,
            on_behalf_of: options.owner ? 'owner' : null,
            mmbridge_session_id: session?.id.toLowerCase() ?? null,
            gate_json: gate,
          },
          links,
        );
      }
      case 'vision':
        return aps.recordVision(db, cardId, by, {
          screenshots_json: jsonFile(options.shots, 'shots'),
          verdict: choice(options.verdict, 'verdict', ['pass', 'fail']),
          items_json: jsonFile(options.items, 'items', '[]'),
          notes: options.notes ?? '',
        });
      case 'owner-ok':
        return aps.transaction(db, () => ({
          id: aps.insertRow(db, 'owner_oks', {
            card_id: cardId,
            sha: aps.getCard(db, cardId).sha,
            recorded_by: by,
            quote: required(options.quote, 'quote'),
            source_ref: options.sourceRef ?? null,
          }),
        }));
      case 'merge': {
        if (Boolean(options.mergedSha) === Boolean(options.appliedRef))
          throw new InputError('specify exactly one of --merged-sha or --applied-ref');
        const card = aps.getCard(db, cardId);
        let verify: string;
        let merged: string | null = null;
        if (options.mergedSha) {
          merged = sha(options.mergedSha, 'merged-sha');
          const core = await importCore();
          const result = await core.runCommand('git', ['merge-base', '--is-ancestor', String(card.sha), merged], {
            cwd: projectDir,
          });
          if (!result.ok)
            throw new Error(`APS-H03: ${merged} does not contain ${card.sha} (git merge-base --is-ancestor failed)`);
          verify = `git merge-base --is-ancestor ${card.sha} ${merged}`;
        } else verify = `applied ${required(options.appliedRef, 'applied-ref')}`;
        const gate = options.gate ? await computeGate(projectDir, { baseRef: options.baseRef }) : null;
        return aps.transaction(db, () => ({
          id: aps.insertRow(db, 'merges', {
            card_id: cardId,
            sha: card.sha,
            merged_sha: merged,
            applied_ref: options.appliedRef ?? null,
            target: required(options.target, 'target'),
            verified_by: by,
            verify_command: verify,
            gate_json: gate
              ? JSON.stringify({ ...gate.result, baseRef: gate.baseRef, diffDigest: gate.diffDigest })
              : null,
          }),
        }));
      }
      case 'todo-render': {
        const markdown = aps.renderTodo(db, options.project);
        if (!options.out) return options.json ? { markdown } : markdown;
        const path = resolve(options.out);
        mkdirSync(dirname(path), { recursive: true });
        const temp = `${path}.${randomUUID()}.tmp`;
        try {
          writeFileSync(temp, markdown, { mode: 0o600 });
          renameSync(temp, path);
        } finally {
          try {
            unlinkSync(temp);
          } catch {}
        }
        return { out: path };
      }
      case 'metrics':
      case 'brief': {
        const metrics = aps.ledgerPeriodMetrics(db, options);
        if (command === 'metrics') return metrics;
        const level = choice(options.level, 'level', ['L0', 'L1', 'L2']);
        const briefing = aps.ledgerBrief(db, by, level, metrics, options);
        return options.json
          ? briefing
          : `${briefing.markdown}${briefing.id ? `\nSaved briefing ${briefing.id}\n` : ''}`;
      }
      case 'chart': {
        const days = Number(options.days ?? '14');
        if (!Number.isInteger(days) || days < 1 || days > 3660)
          throw new InputError('--days must be an integer from 1 to 3660');
        const metric = choice(options.metric, 'metric', ['rework', 'pass', 'cycle']) as 'rework' | 'pass' | 'cycle';
        return aps.ledgerChart(db, metric, days);
      }
      case 'feedback-new':
        return aps.transaction(db, () => ({
          id: aps.insertRow(db, 'feedback', {
            from_agent: by,
            to_agent: required(options.to, 'to'),
            kind: choice(options.kind, 'kind', ['objection', 'proposal', 'andon']),
            body: required(options.body, 'body'),
            card_id: options.card ?? null,
          }),
        }));
      case 'feedback-respond': {
        const response = choice(options.response, 'response', ['accept', 'partial', 'reject']);
        return aps.respondFeedback(db, Number(cardId), by, response, options.reason);
      }
      case 'defect-add':
        return aps.transaction(db, () => {
          const card = aps.getCard(db, cardId);
          const values: Row = {
            card_id: cardId,
            attempt: card.attempt,
            source: choice(options.source, 'source', ['ci', 'revert', 'owner']),
            category: required(options.category, 'category'),
            severity: choice(options.severity, 'severity', ['blocker', 'major', 'minor', 'nit']),
            description: required(options.text, 'text'),
            ref: options.ref ?? null,
            opportunity_count: (JSON.parse(String(card.acceptance_json)) as unknown[]).length,
            recorded_by: by,
          };
          return { id: aps.insertRow(db, 'defects', values) };
        });
      default:
        throw new InputError(`unknown APS command ${command}`);
    }
  });
}
