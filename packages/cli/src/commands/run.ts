import path from 'node:path';
import type { AdapterResult, AdapterRuntimeStatus } from '@mmbridge/adapters';
import { importAdapters, importCore, jsonOutput } from './helpers.js';

export interface RunTaskCommandOptions {
  task: string;
  tool?: string;
  project?: string;
  readonly?: boolean;
  json?: boolean;
}

interface RuntimeSelection {
  runtime: AdapterRuntimeStatus | null;
  reason: string;
  error?: string;
}

interface RunReport {
  ok: boolean;
  readonly: boolean;
  runtimes: AdapterRuntimeStatus[];
  selected: { name: string; reason: string } | null;
  worker: {
    status: 'done' | 'failed';
    text: string;
    resumable: boolean;
  };
  evidence: {
    command: string | null;
    args: string[];
    exitCode: number | null;
    durationMs: number;
    stdoutTail: string;
    stderrTail: string;
  };
  error?: string;
}

export function selectRuntime(runtimes: AdapterRuntimeStatus[], requestedTool?: string): RuntimeSelection {
  if (requestedTool) {
    const runtime = runtimes.find((candidate) => candidate.name === requestedTool);
    if (!runtime) {
      return { runtime: null, reason: 'explicit selection', error: `Unknown adapter: ${requestedTool}` };
    }
    if (!runtime.installed) {
      return {
        runtime: null,
        reason: 'explicit selection',
        error: `Adapter "${requestedTool}" is not installed`,
      };
    }
    if (!runtime.capabilities.run || !runtime.capabilities.readOnly) {
      return {
        runtime: null,
        reason: 'explicit selection',
        error: `Adapter "${requestedTool}" does not support declared read-only task runs`,
      };
    }
    return { runtime, reason: 'explicit --tool selection' };
  }

  const runtime = runtimes.find(
    (candidate) => candidate.installed && candidate.capabilities.run && candidate.capabilities.readOnly,
  );
  if (!runtime) {
    return {
      runtime: null,
      reason: 'automatic capability match',
      error: 'No installed adapter supports declared read-only task runs',
    };
  }
  return { runtime, reason: 'first installed adapter with declared read-only task support' };
}

export async function runTaskCommand(options: RunTaskCommandOptions): Promise<void> {
  const projectDir = path.resolve(options.project ?? process.cwd());
  const readonly = options.readonly === true;
  const core = await importCore();
  const cleanError = (value: string): string => core.limitBytes(core.redactContent(value).redacted, 4096);
  let adapters: Awaited<ReturnType<typeof importAdapters>>;
  let runtimes: AdapterRuntimeStatus[];

  try {
    await core.loadConfig(projectDir);
    adapters = await importAdapters(projectDir);
    runtimes = await adapters.defaultRegistry.listRuntimeStatuses();
  } catch (error) {
    const message = cleanError(error instanceof Error ? error.message : String(error));
    emitReport(failedReport(readonly, [], message), options.json);
    process.exitCode = 2;
    return;
  }

  if (!readonly) {
    emitReport(failedReport(readonly, runtimes, 'The first mmbridge run slice requires --readonly'), options.json);
    process.exitCode = 2;
    return;
  }

  const selection = selectRuntime(runtimes, options.tool);
  if (!selection.runtime) {
    emitReport(failedReport(readonly, runtimes, selection.error ?? 'No runtime selected'), options.json);
    process.exitCode = 2;
    return;
  }

  const startedAt = Date.now();
  let result: AdapterResult;
  try {
    result = await adapters.runTaskAdapter(selection.runtime.name, {
      cwd: projectDir,
      task: options.task,
      readonly: true,
    });
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const message = cleanError(error instanceof Error ? error.message : String(error));
    const report = failedReport(readonly, runtimes, message, {
      selected: { name: selection.runtime.name, reason: selection.reason },
      durationMs,
    });
    emitReport(report, options.json);
    process.exitCode = 1;
    return;
  }

  const durationMs = Date.now() - startedAt;
  const report = await buildRunReport({
    runtimes,
    selection: { ...selection, runtime: selection.runtime },
    result,
    durationMs,
  });
  emitReport(report, options.json);
  if (!report.ok) process.exitCode = 1;
}

async function buildRunReport({
  runtimes,
  selection,
  result,
  durationMs,
}: {
  runtimes: AdapterRuntimeStatus[];
  selection: RuntimeSelection & { runtime: AdapterRuntimeStatus };
  result: AdapterResult;
  durationMs: number;
}): Promise<RunReport> {
  const { limitBytes, redactContent } = await importCore();
  const clean = (value: string, maxBytes: number): string => limitBytes(redactContent(value).redacted, maxBytes);
  const tail = (value: string): string => {
    const redacted = redactContent(value).redacted;
    const bytes = Buffer.from(redacted, 'utf8');
    if (bytes.byteLength <= 4096) return redacted;
    return `[truncated]\n${bytes.subarray(bytes.byteLength - 4096).toString('utf8')}`;
  };
  const stdoutSummary = result.stdout
    ? `[captured ${Buffer.byteLength(result.stdout, 'utf8')} bytes; content omitted]`
    : '';
  const selectedName = selection.runtime.name;

  return {
    ok: result.ok,
    readonly: true,
    runtimes: runtimes.map((runtime) =>
      runtime.name === selectedName ? { ...runtime, health: result.ok ? 'healthy' : 'failed' } : runtime,
    ) as AdapterRuntimeStatus[],
    selected: { name: selectedName, reason: selection.reason },
    worker: {
      status: result.ok ? 'done' : 'failed',
      text: clean(result.text, 16_384),
      resumable: Boolean(result.externalSessionId && result.followupSupported),
    },
    evidence: {
      command: clean(result.command, 1024),
      args: result.args.map((arg) => clean(arg, 2048)),
      exitCode: result.code,
      durationMs,
      stdoutTail: stdoutSummary,
      stderrTail: tail(result.stderr),
    },
    ...(result.ok ? {} : { error: clean(result.stderr || result.text || 'Adapter execution failed', 4096) }),
  };
}

function failedReport(
  readonly: boolean,
  runtimes: AdapterRuntimeStatus[],
  error: string,
  extra: { selected?: { name: string; reason: string }; durationMs?: number } = {},
): RunReport {
  return {
    ok: false,
    readonly,
    runtimes,
    selected: extra.selected ?? null,
    worker: { status: 'failed', text: '', resumable: false },
    evidence: {
      command: null,
      args: [],
      exitCode: null,
      durationMs: extra.durationMs ?? 0,
      stdoutTail: '',
      stderrTail: '',
    },
    error,
  };
}

function emitReport(report: RunReport, json: boolean | undefined): void {
  if (json) {
    jsonOutput(report);
    return;
  }

  const selected = report.selected ? ` via ${report.selected.name}` : '';
  process.stdout.write(`${report.ok ? 'DONE' : 'FAILED'}${selected}\n`);
  if (report.worker.text) process.stdout.write(`${report.worker.text}\n`);
  if (report.error) process.stderr.write(`[mmbridge] ${report.error}\n`);
}
