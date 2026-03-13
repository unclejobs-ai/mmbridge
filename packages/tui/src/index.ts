import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// ─── Domain interfaces ────────────────────────────────────────────────────────

export interface DashboardModel {
  tool: string;
  binary: string;
  installed: boolean | null;
  totalSessions: number;
  latestMode: string | null;
  latestCreatedAt: string | null;
  latestSummary: string | null;
  latestExternalSessionId: string | null;
  latestResultIndex: Record<string, unknown> | null;
  latestContextIndex: Record<string, unknown> | null;
  latestBatchId: string | null;
  latestFollowupSupported?: boolean;
  latestFollowupLocalSessionId?: string | null;
  latestFollowupExternalSessionId?: string | null;
  aggregateStats: Record<string, number> | null;
}

export interface DashboardSession {
  id: string;
  tool: string;
  mode: string;
  batchId?: string | null;
  projectDir?: string;
  externalSessionId?: string | null;
  parentSessionId?: string | null;
  createdAt?: string;
  summary?: string;
  findings?: Array<{ severity?: string; file?: string; line?: number; message?: string }>;
  contextIndex?: Record<string, unknown> | null;
  resultIndex?: Record<string, unknown> | null;
}

export interface DashboardData {
  modeFilter: string;
  models: DashboardModel[];
  sessions: DashboardSession[];
  projectDir: string;
  projectState: Record<string, unknown> | null;
  projectContext: Record<string, unknown> | null;
}

export interface DashboardPayload {
  sessions?: DashboardSession[];
  models?: DashboardModel[];
  modeFilter?: string;
  projectDir?: string;
  projectState?: Record<string, unknown>;
  projectContext?: Record<string, unknown>;
  ui?: string;
}

export interface SummaryRow {
  key: string;
  value: string;
}

export interface DoctorReport {
  generatedAt: string;
  checks: Array<{ binary: string; installed: boolean }>;
  mmbridgeHome: string;
  claudeAgentsDir: string;
  runtimeAuthModel: string;
  sessionFileHints: Record<string, string>;
}

export interface ReviewReport {
  localSessionId?: string;
  externalSessionId?: string;
  workspace?: string;
  summary?: string;
  findings?: Array<{ severity?: string; file?: string; line?: number; message?: string }>;
  resultIndex?: Record<string, unknown>;
  changedFiles?: string | number;
  copiedFiles?: string | number;
  followupSupported?: boolean;
}

// ─── Blessed minimal interfaces ───────────────────────────────────────────────

interface BlessedScreen {
  append(widget: BlessedWidget): void;
  render(): void;
  destroy(): void;
  key(keys: string[], fn: () => void): void;
  on(event: string, fn: (...args: unknown[]) => void): void;
  destroyed: boolean;
  width: number;
}

interface BlessedWidget {
  setContent(content: string): void;
  setItems?(items: string[]): void;
  select?(index: number): void;
  selected?: number;
  focus?(): void;
  on?(event: string, fn: (...args: unknown[]) => void): void;
  setScroll?(position: number): void;
}

interface BlessedFactory {
  screen(opts: Record<string, unknown>): BlessedScreen;
  box(opts: Record<string, unknown>): BlessedWidget;
  list(opts: Record<string, unknown>): BlessedWidget;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const TOOL_ORDER = ['kimi', 'qwen', 'codex', 'gemini'];
const BINARY_BY_TOOL: Record<string, string> = {
  kimi: 'kimi',
  qwen: 'qwen',
  codex: 'codex',
  gemini: 'opencode',
};

// ─── Blessed loader ───────────────────────────────────────────────────────────

let _blessed: BlessedFactory | null = null;

async function loadBlessed(): Promise<BlessedFactory> {
  if (_blessed) return _blessed;
  try {
    // Try dynamic import first (ESM)
    const mod = await import('blessed') as { default?: BlessedFactory } & BlessedFactory;
    _blessed = (mod.default ?? mod) as BlessedFactory;
  } catch {
    // Fallback: resolve from node_modules path
    const blessedPath = path.resolve(
      path.dirname(pathToFileURL(import.meta.url).pathname),
      '../node_modules/blessed/lib/blessed.js',
    );
    const mod = await import(pathToFileURL(blessedPath).href) as { default?: BlessedFactory } & BlessedFactory;
    _blessed = (mod.default ?? mod) as BlessedFactory;
  }
  return _blessed;
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

function formatDate(iso: string | null | undefined): string {
  if (!iso) return 'N/A';
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

function truncate(str: string | null | undefined, len: number): string {
  if (!str) return '';
  return str.length > len ? str.slice(0, len - 1) + '…' : str;
}

function pad(str: string, width: number): string {
  return str.length >= width ? str : str + ' '.repeat(width - str.length);
}

function severityColor(sev: string | undefined): string {
  switch ((sev ?? '').toUpperCase()) {
    case 'CRITICAL': return '{red-fg}';
    case 'WARNING':  return '{yellow-fg}';
    case 'INFO':     return '{cyan-fg}';
    case 'REFACTOR': return '{blue-fg}';
    default:         return '{white-fg}';
  }
}

function colorEnd(): string {
  return '{/}';
}

// ─── Summary table builder ────────────────────────────────────────────────────

function buildSummaryTable(rows: SummaryRow[]): string {
  const keyWidth = Math.max(...rows.map((r) => r.key.length), 10);
  return rows
    .map((r) => `{bold}${pad(r.key, keyWidth)}{/bold}  ${r.value}`)
    .join('\n');
}

// ─── Doctor render ────────────────────────────────────────────────────────────

function buildDoctorContent(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push('{bold}{cyan-fg}MMBridge Doctor Report{/}{/bold}');
  lines.push(`Generated: ${formatDate(report.generatedAt)}`);
  lines.push('');
  lines.push('{bold}Binary Checks:{/bold}');
  for (const check of report.checks) {
    const icon = check.installed ? '{green-fg}✓{/}' : '{red-fg}✗{/}';
    lines.push(`  ${icon} ${check.binary}`);
  }
  lines.push('');
  lines.push('{bold}Paths:{/bold}');
  lines.push(`  mmbridge home  : ${report.mmbridgeHome}`);
  lines.push(`  claude agents  : ${report.claudeAgentsDir}`);
  lines.push(`  auth model     : ${report.runtimeAuthModel}`);
  lines.push('');
  lines.push('{bold}Session File Hints:{/bold}');
  for (const [tool, hint] of Object.entries(report.sessionFileHints)) {
    lines.push(`  ${pad(tool, 10)}: ${hint}`);
  }
  return lines.join('\n');
}

export async function renderDoctor(report: DoctorReport): Promise<void> {
  const blessed = await loadBlessed();
  const screen = blessed.screen({ smartCSR: true, title: 'MMBridge Doctor' });
  const box = blessed.box({
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    content: buildDoctorContent(report),
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    keys: true,
    vi: true,
    border: { type: 'line' },
    style: { border: { fg: 'cyan' }, fg: 'white', bg: 'black' },
  });
  screen.append(box);
  screen.key(['q', 'escape', 'C-c'], () => {
    screen.destroy();
  });
  screen.render();
  return new Promise((resolve) => {
    screen.on('destroy', resolve);
  });
}

// ─── Setup Wizard render ──────────────────────────────────────────────────────

function buildSetupContent(report: DoctorReport): string {
  const allInstalled = report.checks.every((c) => c.installed);
  const lines: string[] = [];
  lines.push('{bold}{cyan-fg}MMBridge Setup Wizard{/}{/bold}');
  lines.push('');
  if (allInstalled) {
    lines.push('{green-fg}All required binaries are installed.{/}');
    lines.push('');
    lines.push('Your environment is ready to use mmbridge.');
  } else {
    lines.push('{yellow-fg}Some binaries are missing. Install them to use all features:{/}');
    lines.push('');
    for (const check of report.checks) {
      if (!check.installed) {
        lines.push(`  {red-fg}✗{/} {bold}${check.binary}{/bold} — not found in PATH`);
      } else {
        lines.push(`  {green-fg}✓{/} ${check.binary}`);
      }
    }
  }
  lines.push('');
  lines.push('{bold}Paths:{/bold}');
  lines.push(`  mmbridge home  : ${report.mmbridgeHome}`);
  lines.push(`  claude agents  : ${report.claudeAgentsDir}`);
  lines.push(`  auth model     : ${report.runtimeAuthModel}`);
  lines.push('');
  lines.push('{dim}Press q or Esc to exit{/dim}');
  return lines.join('\n');
}

export async function renderSetupWizard(report: DoctorReport): Promise<void> {
  const blessed = await loadBlessed();
  const screen = blessed.screen({ smartCSR: true, title: 'MMBridge Setup' });
  const box = blessed.box({
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    content: buildSetupContent(report),
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    keys: true,
    vi: true,
    border: { type: 'line' },
    style: { border: { fg: 'blue' }, fg: 'white', bg: 'black' },
  });
  screen.append(box);
  screen.key(['q', 'escape', 'C-c'], () => {
    screen.destroy();
  });
  screen.render();
  return new Promise((resolve) => {
    screen.on('destroy', resolve);
  });
}

// ─── Review Console render ────────────────────────────────────────────────────

function buildReviewContent(report: ReviewReport): string {
  const lines: string[] = [];
  lines.push('{bold}{cyan-fg}Review Result{/}{/bold}');
  lines.push('');

  const summaryRows: SummaryRow[] = [
    { key: 'Session ID',  value: report.localSessionId ?? 'N/A' },
    { key: 'External ID', value: report.externalSessionId ?? 'N/A' },
    { key: 'Workspace',   value: report.workspace ?? 'N/A' },
    { key: 'Changed',     value: String(report.changedFiles ?? 'N/A') },
    { key: 'Copied',      value: String(report.copiedFiles ?? 'N/A') },
    { key: 'Followup',    value: report.followupSupported ? 'yes' : 'no' },
  ];
  lines.push(buildSummaryTable(summaryRows));
  lines.push('');

  if (report.summary) {
    lines.push('{bold}Summary:{/bold}');
    lines.push(report.summary);
    lines.push('');
  }

  const findings = report.findings ?? [];
  if (findings.length > 0) {
    lines.push(`{bold}Findings (${findings.length}):{/bold}`);
    for (const f of findings) {
      const col = severityColor(f.severity);
      const loc = f.file ? `${f.file}${f.line != null ? `:${f.line}` : ''}` : '';
      lines.push(
        `  ${col}[${(f.severity ?? 'INFO').padEnd(8)}]${colorEnd()} ${loc ? `{dim}${loc}{/dim} ` : ''}${f.message ?? ''}`,
      );
    }
    lines.push('');
  }

  if (report.resultIndex) {
    lines.push('{bold}Result Index:{/bold}');
    lines.push(JSON.stringify(report.resultIndex, null, 2));
  }

  lines.push('');
  lines.push('{dim}Press q or Esc to exit{/dim}');
  return lines.join('\n');
}

export async function renderReviewConsole(report: ReviewReport): Promise<void> {
  const blessed = await loadBlessed();
  const screen = blessed.screen({ smartCSR: true, title: 'MMBridge Review' });
  const box = blessed.box({
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    content: buildReviewContent(report),
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    keys: true,
    vi: true,
    border: { type: 'line' },
    style: { border: { fg: 'green' }, fg: 'white', bg: 'black' },
  });
  screen.append(box);
  screen.key(['q', 'escape', 'C-c'], () => {
    screen.destroy();
  });
  screen.render();
  return new Promise((resolve) => {
    screen.on('destroy', resolve);
  });
}

// ─── Dashboard render ─────────────────────────────────────────────────────────

function buildModelRow(model: DashboardModel, screenWidth: number): string {
  const installed = model.installed === null
    ? '{yellow-fg}?{/}'
    : model.installed ? '{green-fg}✓{/}' : '{red-fg}✗{/}';
  const latest = formatDate(model.latestCreatedAt);
  const summary = truncate(model.latestSummary, Math.max(20, screenWidth - 60));
  const sessions = String(model.totalSessions).padStart(4);
  const mode = (model.latestMode ?? '').padEnd(10);
  return `${installed} ${pad(model.tool, 8)} ${sessions}  ${mode}  ${pad(latest, 20)}  ${summary}`;
}

function buildModelsContent(models: DashboardModel[], screenWidth: number): string {
  const sorted = [...models].sort(
    (a, b) => TOOL_ORDER.indexOf(a.tool) - TOOL_ORDER.indexOf(b.tool),
  );
  const header =
    `  ${pad('Tool', 8)} ${pad('Sess', 4)}  ${pad('Mode', 10)}  ${pad('Latest', 20)}  Summary`;
  const rows = sorted.map((m) => buildModelRow(m, screenWidth));
  return ['{bold}Models:{/bold}', header, ...rows].join('\n');
}

function buildSessionsContent(sessions: DashboardSession[], screenWidth: number): string {
  if (sessions.length === 0) return 'No sessions.';
  const lines: string[] = ['{bold}Recent Sessions:{/bold}'];
  for (const s of sessions.slice(0, 50)) {
    const date = formatDate(s.createdAt);
    const summary = truncate(s.summary, Math.max(20, screenWidth - 70));
    const findCount = s.findings?.length ?? 0;
    lines.push(
      `  {dim}${date}{/dim}  ${pad(s.tool, 8)} ${pad(s.mode, 10)}  finds:${String(findCount).padStart(3)}  ${summary}`,
    );
  }
  return lines.join('\n');
}

function buildProjectContent(
  projectDir: string,
  projectState: Record<string, unknown> | null,
  projectContext: Record<string, unknown> | null,
): string {
  const lines: string[] = [];
  lines.push(`{bold}Project:{/bold} ${projectDir || os.cwd()}`);
  if (projectContext) {
    lines.push('');
    lines.push('{bold}Context:{/bold}');
    for (const [k, v] of Object.entries(projectContext)) {
      if (typeof v === 'object' && v !== null) continue; // skip nested objects in overview
      lines.push(`  ${pad(String(k), 18)}: ${String(v)}`);
    }
  }
  if (projectState) {
    lines.push('');
    lines.push('{bold}State:{/bold}');
    lines.push(JSON.stringify(projectState, null, 2));
  }
  return lines.join('\n');
}

function buildDashboardMainContent(data: DashboardData, screenWidth: number): string {
  return [
    buildProjectContent(data.projectDir, data.projectState, data.projectContext),
    '',
    buildModelsContent(data.models, screenWidth),
    '',
    buildSessionsContent(data.sessions, screenWidth),
    '',
    `{dim}Mode filter: ${data.modeFilter || 'all'}  |  Press q or Esc to exit{/dim}`,
  ].join('\n');
}

function normaliseDashboardPayload(payload: DashboardPayload): DashboardData {
  return {
    modeFilter: payload.modeFilter ?? 'all',
    models: (payload.models ?? []).map((m) => ({
      ...m,
      binary: m.binary ?? BINARY_BY_TOOL[m.tool] ?? m.tool,
    })),
    sessions: payload.sessions ?? [],
    projectDir: payload.projectDir ?? '',
    projectState: payload.projectState ?? null,
    projectContext: payload.projectContext ?? null,
  };
}

export async function renderDashboard(payload: DashboardPayload): Promise<void> {
  // JSON output mode — no TUI
  if (payload.ui === 'json') {
    const data = normaliseDashboardPayload(payload);
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    return;
  }

  const blessed = await loadBlessed();
  const data = normaliseDashboardPayload(payload);
  const screen = blessed.screen({ smartCSR: true, title: 'MMBridge Dashboard' });

  const mainBox = blessed.box({
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    content: buildDashboardMainContent(data, screen.width),
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    keys: true,
    vi: true,
    border: { type: 'line' },
    style: { border: { fg: 'cyan' }, fg: 'white', bg: 'black' },
    label: ' MMBridge Dashboard ',
  });

  screen.append(mainBox);

  screen.key(['q', 'escape', 'C-c'], () => {
    screen.destroy();
  });

  screen.key(['r'], () => {
    mainBox.setContent(buildDashboardMainContent(data, screen.width));
    screen.render();
  });

  screen.render();

  return new Promise((resolve) => {
    screen.on('destroy', resolve);
  });
}
