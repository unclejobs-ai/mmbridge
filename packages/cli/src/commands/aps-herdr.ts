import type { RunResult } from '@mmbridge/core';
import { importCore } from './helpers.js';

const TIMEOUT_MS = 15_000;
const PANE_GET_ERROR = 'cannot confirm pane ended: herdr pane get failed';

type JsonObject = Record<string, unknown>;

export interface HerdrPane {
  pane_id: string;
  terminal_id: string;
  tab_id: string;
  workspace_id: string;
  agent?: string;
  agent_status?: string;
  agent_session?: { value: string; [key: string]: unknown };
  cwd?: string;
}

export interface HerdrWorkspace {
  workspace_id: string;
  label: string;
}

export type PaneState = { state: 'absent' } | { state: 'present'; pane: HerdrPane };

export interface PaneEndEvidence {
  probe: 'herdr pane get';
  argv: string[];
  exit: number;
  stdout_head: string;
  stderr_head: string;
  at: string;
}

function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected a JSON object');
  return value as JsonObject;
}

function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('expected a non-empty string');
  return value;
}

function parsePane(value: unknown): HerdrPane {
  const pane = object(value);
  text(pane.pane_id);
  text(pane.terminal_id);
  text(pane.tab_id);
  text(pane.workspace_id);
  if (pane.agent_session !== undefined) text(object(pane.agent_session).value);
  return pane as unknown as HerdrPane;
}

async function run(args: string[], timeoutMs = TIMEOUT_MS): Promise<RunResult> {
  const core = await importCore();
  return core.runCommand('herdr', args, { timeoutMs });
}

export function parseHerdrEnvelope(raw: Pick<RunResult, 'code' | 'stdout' | 'stderr'>): JsonObject {
  // herdr emits error envelopes on stderr; failed commands must never trust stdout.
  return object(JSON.parse(raw.code !== 0 || !raw.stdout.trim() ? raw.stderr : raw.stdout));
}

function response(result: RunResult): JsonObject {
  const envelope = parseHerdrEnvelope(result);
  if (!result.ok || envelope.error !== undefined) throw new Error('herdr command failed');
  return object(envelope.result);
}

async function command(args: string[], timeoutMs = TIMEOUT_MS): Promise<{ result: JsonObject; raw: RunResult }> {
  const raw = await run(args, timeoutMs);
  try {
    return { result: response(raw), raw };
  } catch (cause) {
    throw new Error(`herdr ${args.slice(0, 2).join(' ')} failed`, {
      cause: new Error(`herdr command exited ${raw.code}; stderr: ${raw.stderr.slice(0, 1024)}`, { cause }),
    });
  }
}

export async function listPanes(): Promise<HerdrPane[]> {
  const { result } = await command(['pane', 'list']);
  try {
    if (!Array.isArray(result.panes)) throw new Error('expected panes');
    return result.panes.map(parsePane);
  } catch (cause) {
    throw new Error('herdr pane list failed', { cause });
  }
}

async function probePane(id: string): Promise<{ state: PaneState; raw: RunResult }> {
  const raw = await run(['pane', 'get', id]);
  try {
    const envelope = parseHerdrEnvelope(raw);
    // Only herdr's explicit not-found response proves absence, never a timeout or transport error.
    if (raw.code === 1 && object(envelope.error ?? {}).code === 'pane_not_found') {
      return { state: { state: 'absent' }, raw };
    }
    if (!raw.ok || envelope.error !== undefined) throw new Error('herdr command failed');
    const pane = parsePane(object(envelope.result).pane);
    if (pane.pane_id !== id) throw new Error('pane get returned another pane');
    return { state: { state: 'present', pane }, raw };
  } catch (cause) {
    throw new Error(PANE_GET_ERROR, { cause });
  }
}

export async function getPane(id: string): Promise<PaneState> {
  return (await probePane(id)).state;
}

export async function confirmPaneEnded(id: string, terminalId?: string | null): Promise<PaneEndEvidence> {
  const { state, raw } = await probePane(id);
  if (state.state === 'present' && (terminalId == null || state.pane.terminal_id === terminalId)) {
    throw new Error(`APS-H01: herdr pane ${id} is still open`);
  }
  return {
    probe: 'herdr pane get',
    argv: ['pane', 'get', id],
    exit: raw.code,
    stdout_head: raw.stdout.slice(0, 1024),
    stderr_head: raw.stderr.slice(0, 1024),
    at: new Date().toISOString(),
  };
}

export async function listWorkspaces(): Promise<HerdrWorkspace[]> {
  const { result } = await command(['workspace', 'list']);
  try {
    if (!Array.isArray(result.workspaces)) throw new Error('expected workspaces');
    return result.workspaces.map((value: unknown) => {
      const workspace = object(value);
      return { workspace_id: text(workspace.workspace_id), label: text(workspace.label) };
    });
  } catch (cause) {
    throw new Error('herdr workspace list failed', { cause });
  }
}

export async function createTab(options: {
  workspace: string;
  cwd: string;
  label: string;
}): Promise<{ tabId: string; paneId: string; terminalId: string }> {
  await command([
    'tab',
    'create',
    '--workspace',
    options.workspace,
    '--cwd',
    options.cwd,
    '--label',
    options.label,
    '--no-focus',
  ]);
  // Resolve by label and workspace rather than depending on the tab-create response shape.
  const { result } = await command(['tab', 'list']);
  let tabId: string;
  try {
    if (!Array.isArray(result.tabs)) throw new Error('expected tabs');
    const tabs = result.tabs
      .map(object)
      .filter((tab) => tab.label === options.label && tab.workspace_id === options.workspace);
    if (tabs.length !== 1) throw new Error('expected exactly one tab');
    tabId = text(tabs[0].tab_id);
  } catch (cause) {
    throw new Error(`cannot resolve herdr tab for label ${options.label} in workspace ${options.workspace}`, { cause });
  }
  const panes = (await listPanes()).filter((pane) => pane.tab_id === tabId && pane.workspace_id === options.workspace);
  if (panes.length !== 1) throw new Error(`cannot resolve exactly one herdr pane for tab ${tabId}`);
  return { tabId, paneId: panes[0].pane_id, terminalId: panes[0].terminal_id };
}

export async function startAgent(options: {
  name: string;
  kind: 'omp' | 'devin' | 'grok';
  pane: string;
  args?: string[];
}): Promise<RunResult> {
  return (
    await command(
      [
        'agent',
        'start',
        options.name,
        '--kind',
        options.kind,
        '--pane',
        options.pane,
        '--timeout',
        '60000',
        '--',
        ...(options.args ?? []),
      ],
      70_000,
    )
  ).raw;
}

export async function promptAgent(target: string, prompt: string): Promise<RunResult> {
  return (
    await command(
      ['agent', 'prompt', target, prompt, '--wait', '--until', 'working', '--timeout', String(TIMEOUT_MS)],
      20_000,
    )
  ).raw;
}

export async function closePane(id: string): Promise<RunResult> {
  return (await command(['pane', 'close', id])).raw;
}
