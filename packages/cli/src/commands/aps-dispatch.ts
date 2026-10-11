import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  constants,
  accessSync,
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ApsInputError, type WorkerKind } from '@mmbridge/aps';
import { getPane, listPanes, listWorkspaces, parseHerdrEnvelope } from './aps-herdr.js';
import { type ApsCommandOptions, choice, emit, required } from './aps-shared.js';
import { exitWithError, importAps, importCore } from './helpers.js';

export interface ApsDispatchOptions extends ApsCommandOptions {
  harness?: string;
  lane?: string;
  worktree?: string;
  workspace?: string;
  permissionMode?: string;
  ompId?: string;
  /** omp agent definition appended as system prompt for headless omp runs (e.g. w-gemini). */
  ompAgent?: string;
  dryRun?: boolean;
}

export type DispatchRecord = Record<string, unknown>;

const HEADLESS_RUNNER = `
const fs = require('node:fs');
const {spawn} = require('node:child_process');
const [binary, args, packet, output] = process.argv.slice(1);
const out = fs.openSync(packet + '/' + output, 'a');
const err = output === 'out.json' ? fs.openSync(packet + '/err.log', 'a') : out;
// IPC is only a launch acknowledgement: losing dispatch must not stop supervision.
const notify = message => {
  try { if (process.connected) process.send?.(message, () => {}); } catch {}
};
const child = spawn(binary, JSON.parse(args), {stdio: ['ignore', out, err]});
child.on('spawn', () => notify({ready: true}));
child.on('error', error => { fs.appendFileSync(packet + '/dispatch.log', error.message + '\\n'); fs.writeFileSync(packet + '/exit', '127\\n'); notify({error: error.message}); process.exitCode = 127; });
child.on('exit', code => { fs.writeFileSync(packet + '/exit', String(code ?? 128) + '\\n'); process.exitCode = code ?? 128; });
`;

/** Presence check only: workers are spawned by bare name (MBP's `devin` wrapper must not be bypassed by path). */
function requireOnPath(binary: string): void {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const path = resolve(dir, binary);
    try {
      accessSync(path, constants.X_OK);
      if (statSync(path).isFile()) return;
    } catch {}
  }
  throw new ApsInputError(`${binary} is not on PATH`);
}

function contract(run: string, card: string, attempt: number, packet: string, branch: string): string {
  return `\n## Collect contract\nThis section supersedes the manual reporting steps above. Do not run aps report or close-session yourself.\nRun: ${run}\nCard: ${card}\nAttempt: ${attempt}\nBranch: ${branch}\nPacket: ${packet}\n\nWhen done, write ${join(packet, 'report.md')} in COMPLETION-REPORT form (CARD, RESULT, BRANCH/SHA, FILES, EVIDENCE, RISKS, STATUS, CLOSED). Write report.json.tmp, then atomically rename it to report.json in this packet directory, following report.schema.json. Then exit your session (omp task workers: yield). Collect closes the recorded herdr pane; do not close someone else's pane.\n\nreport.json fields: run, card, attempt, status (DONE|DONE_WITH_CONCERNS|BLOCKED), sha (40/64 lowercase hex), branch, pr (URL or null), files (paths), evidence (one {ac, command, output, ok, artifact?} per acceptance criterion), risks (required for DONE_WITH_CONCERNS), blocked (required iff BLOCKED; "BLOCKED: <cause> <tried command>"). Report only exercised evidence.\n`;
}

function reportSchema(run: string, card: string, attempt: number, branch: string) {
  const text = { type: 'string' };
  const nonempty = { type: 'string', minLength: 1, pattern: '\\S' };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: false,
    required: ['run', 'card', 'attempt', 'status', 'sha', 'branch', 'pr', 'files', 'evidence'],
    properties: {
      run: { const: run },
      card: { const: card },
      attempt: { const: attempt },
      branch: { const: branch },
      status: { enum: ['DONE', 'DONE_WITH_CONCERNS', 'BLOCKED'] },
      sha: { type: 'string', pattern: '^(?:[a-f0-9]{40}|[a-f0-9]{64})$' },
      pr: { anyOf: [{ type: 'string', format: 'uri' }, { type: 'null' }] },
      files: { type: 'array', items: nonempty },
      evidence: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['ac', 'command', 'output', 'ok'],
          properties: { ac: nonempty, command: text, output: text, ok: { type: 'boolean' }, artifact: text },
        },
      },
      risks: nonempty,
      blocked: { type: 'string', pattern: '^BLOCKED: .+' },
    },
    oneOf: [
      { properties: { status: { const: 'DONE' } }, not: { required: ['blocked'] } },
      {
        properties: { status: { const: 'DONE_WITH_CONCERNS' } },
        required: ['risks'],
        not: { required: ['blocked'] },
      },
      { properties: { status: { const: 'BLOCKED' } }, required: ['blocked'] },
    ],
  };
}

function workerArgs(kind: WorkerKind, model: string, worktree: string, mode: string | undefined) {
  if (kind === 'omp') return ['--model', model, '--cwd', worktree];
  // Owner rule 2026-10-11: Devin never waits on a permission prompt. Print mode rejects edits and shell under
  // smart/auto/accept-edits, and a TUI in accept mode stalls on prompts, so herdr and headless both run dangerous.
  if (kind === 'devin')
    return ['--respect-workspace-trust', 'false', '--model', model, '--permission-mode', mode ?? 'dangerous'];
  return ['--model', model, '--permission-mode', mode ?? 'acceptEdits', '--no-subagents'];
}

/** Disables omp's own retry.fallbackChains for this run so the ledger model is the model that ran. */
export function ompNoFallbackConfig(model: string): string {
  const bare = model.replace(/:[a-z]+$/, '');
  const keys = new Set([bare, model]);
  if (bare.includes('/')) keys.add(`${bare.split('/')[0]}/*`);
  const chains = [...keys].map((key) => `    ${JSON.stringify(key)}: []`).join('\n');
  return `retry:\n  usageAwareFallback: false\n  fallbackChains:\n${chains}\n`;
}

export function dispatchExitCode(error: unknown): 1 | 2 | 3 {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith('APS-')) return 3;
  return error instanceof ApsInputError || /(?:CHECK|NOT NULL|UNIQUE|FOREIGN KEY) constraint failed/.test(message)
    ? 2
    : 1;
}

async function headless(binary: string, args: string[], packet: string, worktree: string, output: string) {
  const fd = openSync(join(packet, 'dispatch.log'), 'a');
  try {
    const child = spawn(process.execPath, ['-e', HEADLESS_RUNNER, binary, JSON.stringify(args), packet, output], {
      cwd: worktree,
      detached: true,
      stdio: ['ignore', fd, fd, 'ipc'],
    });
    const [message] = (await Promise.race([
      once(child, 'message'),
      once(child, 'exit').then(() => {
        throw new Error('headless launcher exited before spawning worker');
      }),
    ])) as [{ ready?: boolean; error?: string }];
    if (!message.ready) throw new Error(message.error ?? 'headless worker spawn failed');
    child.disconnect();
    const pid = child.pid;
    if (!pid) throw new Error('headless launcher did not return a pid');
    child.unref();
    return pid;
  } finally {
    closeSync(fd);
  }
}

export async function runApsDispatchCommand(
  _action: string,
  id: string | undefined,
  options: ApsDispatchOptions,
): Promise<void> {
  try {
    emit(await dispatchCard(id, options), options.json);
  } catch (error) {
    exitWithError(error instanceof Error ? error.message : String(error), dispatchExitCode(error));
  }
}

/** Preflight + intent + launch for one worker. Returns the emitted record; throws on refusal or launch failure. */
export async function dispatchCard(id: string | undefined, options: ApsDispatchOptions): Promise<DispatchRecord> {
  const aps = await importAps();
  let db: DatabaseSync | undefined;
  try {
    const cardId = required(id, 'card');
    const by = required(options.by ?? process.env.APS_AGENT, 'by');
    const harness = choice(options.harness, 'harness', ['herdr', 'omp', 'devin', 'grok']) as 'herdr' | WorkerKind;
    const kind = harness === 'herdr' ? (choice(options.kind, 'kind', ['omp', 'devin', 'grok']) as WorkerKind) : harness;
    if (harness !== 'herdr' && options.kind !== undefined) throw new ApsInputError('--kind is only valid for herdr');
    if (harness !== 'herdr' && options.workspace !== undefined)
      throw new ApsInputError('--workspace is only valid for herdr');
    const lane = required(options.lane, 'lane');
    const layer = choice(options.layer, 'layer', ['L2', 'L3']);
    const model = required(options.model, 'model');
    const worktree = required(options.worktree, 'worktree');
    if (!isAbsolute(worktree) || !existsSync(worktree) || !statSync(worktree).isDirectory())
      throw new ApsInputError('--worktree must be an existing absolute directory');
    // omp with --omp-id = pointer for the parent's task tool; omp without it = headless `omp -p` run.
    const ompId = harness === 'omp' ? options.ompId : undefined;
    if (ompId !== undefined && !/^[A-Za-z0-9._@-]+$/.test(ompId))
      throw new ApsInputError('--omp-id must be a task agent ID');
    if (harness !== 'omp' && options.ompId !== undefined)
      throw new ApsInputError('--omp-id is only valid for omp task dispatch');
    if (options.ompAgent !== undefined && (harness !== 'omp' || ompId !== undefined))
      throw new ApsInputError('--omp-agent is only valid for headless omp dispatch');
    const ompAgentFile = options.ompAgent
      ? join(homedir(), '.omp', 'agent', 'agents', `${options.ompAgent}.md`)
      : undefined;
    if (ompAgentFile && !existsSync(ompAgentFile)) throw new ApsInputError(`omp agent ${options.ompAgent} not found`);
    const headlessOmp = harness === 'omp' && ompId === undefined;
    if (options.permissionMode !== undefined) {
      if (kind === 'omp') throw new ApsInputError('--permission-mode is not supported for omp');
      choice(
        options.permissionMode,
        'permission-mode',
        kind === 'devin' ? ['dangerous'] : ['default', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions', 'plan'],
      );
    }
    const core = await importCore();
    const config = await core.loadConfig(resolve(options.projectDir ?? process.cwd()));
    const dbPath = aps.resolveApsDbPath({ flag: options.db, configPath: config.aps?.dbPath });
    // Opening read-only makes invalid input and --dry-run truly write-free, including migrations/escalations.
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 5000');
    aps.doctor(db);
    const card = aps.getCard(db, cardId);
    if (aps.getLiveRun(db, cardId)) throw new Error('APS-N01: card already has a live run');
    if (card.state !== 'issued' && card.state !== 'revise')
      throw new ApsInputError(`card ${cardId} must be issued or revise`);
    const manager = aps.getAgent(db, by);
    if (manager.status === 'closed') throw new ApsInputError('--by must name a live manager agent');
    const git = async (args: string[]) => {
      const result = await core.runCommand('git', ['-C', worktree, ...args]);
      if (!result.ok) throw new ApsInputError(`worktree git ${args.join(' ')} failed: ${result.stderr.trim()}`);
      return result.stdout.trim();
    };
    if (await git(['status', '--porcelain'])) throw new ApsInputError('--worktree must be clean');
    const currentBranch = await git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
    const branch = options.branch ?? currentBranch;
    if (!branch || branch !== currentBranch)
      throw new ApsInputError('--branch must match the checked-out worktree branch');
    const baseSha = await git(['rev-parse', '--verify', 'HEAD']);
    let workspace: string | undefined;
    if (harness !== 'omp' || headlessOmp) requireOnPath(harness);
    const binary = harness === 'omp' && !headlessOmp ? undefined : harness;
    if (harness === 'herdr') {
      const wanted = options.workspace ?? String(card.project);
      const matches = (await listWorkspaces()).filter((ws) => ws.workspace_id === wanted || ws.label === wanted);
      if (matches.length !== 1) throw new ApsInputError(`unknown or ambiguous herdr workspace ${wanted}`);
      workspace = matches[0].workspace_id;
    }
    const queue = Number(
      db.prepare("SELECT count(*) AS n FROM cards WHERE state IN ('reported','closed_session')").get()?.n,
    );
    const reviewers = Number(
      db.prepare("SELECT count(*) AS n FROM agents WHERE status <> 'closed' AND layer IN ('L1','L2')").get()?.n,
    );
    if (queue > 2 * reviewers)
      process.stderr.write('[mmbridge] DISPATCH PAUSED: review queue exceeds 2× active L1/L2 agents (warning only)\n');
    const attempt = Number(card.attempt) + 1;
    const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    let run = `${cardId}-a${attempt}-${stamp}`;
    if (db.prepare('SELECT 1 FROM worker_runs WHERE id=?').get(run)) run += `-${randomUUID().slice(0, 8)}`;
    const herdrName = harness === 'herdr' ? `aps-${randomUUID().replaceAll('-', '').slice(0, 28)}` : undefined;
    const packet = join(dirname(dbPath), 'dispatch', run);
    const pointer = `Read ${join(packet, 'card.md')} and follow it exactly. Hand off by writing ${join(packet, 'report.json')} and ${join(packet, 'report.md')}.`;
    const ompPrompt = `${pointer} Yield when report.json is written.`;
    const args = workerArgs(kind, model, worktree, options.permissionMode);
    const spawnArgs =
      harness === 'devin'
        ? [...args, '--prompt-file', join(packet, 'card.md'), '-p']
        : harness === 'grok'
          ? ['--cwd', worktree, ...args, '--prompt-file', join(packet, 'card.md'), '--output-format', 'json']
          : headlessOmp
            ? [
                '-p',
                '--no-title',
                '--auto-approve',
                '--mode',
                'json',
                ...args,
                '--session-dir',
                join(packet, 'session'),
                '--config',
                join(packet, 'omp-config.yml'),
                ...(ompAgentFile ? ['--append-system-prompt', ompAgentFile] : []),
                `${pointer} Stop once report.json is written.`,
              ]
            : args;
    const plan =
      harness === 'herdr'
        ? [
            ['herdr', 'tab', 'create', '--workspace', workspace, '--cwd', worktree, '--label', run, '--no-focus'],
            ['herdr', 'tab', 'list'],
            ['herdr', 'pane', 'list'],
            [
              'herdr',
              'agent',
              'start',
              herdrName,
              '--kind',
              kind,
              '--pane',
              '<resolved-pane>',
              '--timeout',
              '60000',
              '--',
              ...args,
            ],
            ['herdr', 'agent', 'prompt', herdrName, pointer, '--wait', '--until', 'working', '--timeout', '15000'],
            ['herdr', 'pane', 'get', '<resolved-pane>'],
          ]
        : harness === 'omp' && !headlessOmp
          ? []
          : [
              [
                process.execPath,
                '-e',
                HEADLESS_RUNNER,
                binary,
                JSON.stringify(spawnArgs),
                packet,
                harness === 'grok' ? 'out.json' : 'out.log',
              ],
            ];
    const metadata = {
      run,
      card: cardId,
      attempt,
      worktree,
      branch,
      base_sha: baseSha,
      harness,
      kind: harness === 'herdr' ? kind : null,
      herdr_name: herdrName,
      model,
    };
    const schema = reportSchema(run, cardId, attempt, branch);
    if (options.dryRun) {
      return {
        ...metadata,
        dryRun: true,
        packet,
        cardMd: aps.renderCardPrompt(db, cardId) + contract(run, cardId, attempt, packet, branch),
        reportSchema: schema,
        spawnArgv: plan,
        ...(ompId ? { ompPrompt, omp_id: ompId } : {}),
      };
    }
    db.close();
    db = aps.openApsDb(dbPath);
    aps.doctor(db);
    const ledger = db;
    const agent = await aps.commandTransaction(ledger, async () => {
      if (aps.getLiveRun(ledger, cardId)) throw new Error('APS-N01: card already has a live run');
      const agent = aps.newAgent(ledger, {
        name: lane,
        layer,
        model,
        vendor: options.vendor ?? 'unknown',
        project: card.project,
      });
      aps.startCard(ledger, cardId, agent);
      aps.createRun(ledger, {
        id: run,
        card_id: cardId,
        attempt,
        agent_id: agent,
        harness,
        kind: harness === 'herdr' ? kind : null,
        model,
        worktree,
        branch,
        base_sha: baseSha,
        packet_dir: packet,
        created_by: by,
      });
      return agent;
    });
    let step = 'packet';
    let paneId: string | undefined;
    let terminalId: string | undefined;
    let tabId: string | undefined;
    let tabCreated = false;
    const log = (value: unknown) => appendFileSync(join(packet, 'dispatch.log'), `${JSON.stringify(value)}\n`);
    const herdr = async (argv: string[], timeoutMs = 15_000) => {
      step = argv.slice(0, 2).join(' ');
      const result = await core.runCommand('herdr', argv, { timeoutMs });
      log({ argv, ...result });
      const envelope = parseHerdrEnvelope(result);
      const error = envelope.error;
      const errorCode = error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
      const payload = envelope.result;
      if (!result.ok || error || !payload || typeof payload !== 'object' || Array.isArray(payload))
        throw new Error(`herdr ${step} failed${errorCode ? `: ${errorCode}` : ''}`);
      return payload as { tabs?: { tab_id: string; label: string; workspace_id: string }[] };
    };
    try {
      mkdirSync(packet, { recursive: true });
      writeFileSync(
        join(packet, 'card.md'),
        aps.renderCardPrompt(ledger, cardId) + contract(run, cardId, attempt, packet, branch),
      );
      writeFileSync(join(packet, 'report.schema.json'), `${JSON.stringify(schema, null, 2)}\n`);
      writeFileSync(join(packet, 'dispatch.json'), `${JSON.stringify({ ...metadata, agent }, null, 2)}\n`);
      if (headlessOmp) writeFileSync(join(packet, 'omp-config.yml'), ompNoFallbackConfig(model));
      let launch: Record<string, unknown>;
      if (harness === 'herdr') {
        await herdr([
          'tab',
          'create',
          '--workspace',
          workspace as string,
          '--cwd',
          worktree,
          '--label',
          run,
          '--no-focus',
        ]);
        tabCreated = true;
        const tabs = (await herdr(['tab', 'list'])).tabs;
        const matching = Array.isArray(tabs)
          ? tabs.filter((tab) => tab.label === run && tab.workspace_id === workspace)
          : [];
        if (matching.length !== 1 || typeof matching[0].tab_id !== 'string')
          throw new Error(`cannot resolve herdr tab for ${run}`);
        tabId = matching[0].tab_id;
        step = 'pane list';
        const panes = (await listPanes()).filter((pane) => pane.tab_id === tabId && pane.workspace_id === workspace);
        log({ step, panes });
        if (panes.length !== 1) throw new Error(`cannot resolve exactly one herdr pane for tab ${tabId}`);
        paneId = panes[0].pane_id;
        terminalId = panes[0].terminal_id;
        await herdr(
          [
            'agent',
            'start',
            herdrName as string,
            '--kind',
            kind,
            '--pane',
            paneId,
            '--timeout',
            '60000',
            '--',
            ...args,
          ],
          70_000,
        );
        await herdr(
          ['agent', 'prompt', herdrName as string, pointer, '--wait', '--until', 'working', '--timeout', '15000'],
          20_000,
        );
        step = 'pane get';
        const pane = await getPane(paneId);
        log({ step, pane });
        if (pane.state !== 'present' || pane.pane.terminal_id !== terminalId)
          throw new Error('launched pane is absent or terminal changed');
        launch = {
          workspace_id: workspace,
          herdr_name: herdrName,
          tab_id: tabId,
          pane_id: paneId,
          terminal_id: terminalId,
          session_ref: pane.pane.agent_session?.value ?? null,
        };
      } else if (harness === 'omp' && !headlessOmp) {
        step = 'omp task prompt';
        // Task tools inherit the parent's session directory, which need not be the worker worktree.
        // Collect must resolve this glob unambiguously or require --omp-session-dir.
        launch = {
          omp_id: ompId,
          session_ref: join(homedir(), '.omp', 'agent', 'sessions', '*', '*', `${ompId}.jsonl`),
        };
        log({ step, ompPrompt, ...launch });
      } else {
        step = `${harness} spawn`;
        log({ binary, argv: spawnArgs, cwd: worktree });
        launch = {
          pid: await headless(
            binary as string,
            spawnArgs,
            packet,
            worktree,
            harness === 'grok' ? 'out.json' : 'out.log',
          ),
          ...(headlessOmp ? { session_ref: join(packet, 'session') } : {}),
        };
      }
      step = 'record launch';
      await aps.commandTransaction(ledger, async () => {
        aps.addRunEvent(ledger, run, 'launched', by, launch);
        if (paneId) ledger.prepare('UPDATE agents SET herdr_pane=? WHERE id=?').run(paneId, agent);
      });
      return {
        run,
        agent,
        card: cardId,
        attempt,
        packet,
        harness,
        model,
        ...launch,
        ...(paneId ? { pane: paneId } : {}),
        ...(ompId ? { ompPrompt } : {}),
        next: `mmbridge aps collect ${cardId} --by ${by} --wait 90m`,
      };
    } catch (error) {
      const failedStep = step;
      const message = error instanceof Error ? error.message : String(error);
      const cleanup: unknown[] = [];
      if (tabCreated) {
        try {
          if (!tabId) {
            const tabs = (await herdr(['tab', 'list'])).tabs;
            const matching = Array.isArray(tabs)
              ? tabs.filter((tab) => tab.label === run && tab.workspace_id === workspace)
              : [];
            if (matching.length === 1) tabId = matching[0].tab_id;
          }
          const panes = paneId
            ? [paneId]
            : tabId
              ? (await listPanes())
                  .filter((p) => p.tab_id === tabId && p.workspace_id === workspace)
                  .map((p) => p.pane_id)
              : [];
          for (const pane of panes) {
            const result = await core.runCommand('herdr', ['pane', 'close', pane]);
            cleanup.push({ pane, ...result });
          }
        } catch (closeError) {
          cleanup.push({ error: String(closeError) });
        }
      }
      await aps.commandTransaction(ledger, async () => {
        aps.addRunEvent(ledger, run, 'failed', by, { error: message, step: failedStep, cleanup });
        aps.closeSession(ledger, agent, by, `dispatch failed: ${failedStep}: ${message}`, true);
      });
      throw new Error(`dispatch failed: ${failedStep}: ${message}`);
    }
  } finally {
    db?.close();
  }
}
