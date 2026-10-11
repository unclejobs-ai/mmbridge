import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import type { RunResult } from '@mmbridge/core';
import { minimatch } from 'minimatch';
import {
  type Baseline,
  type Exemption,
  type Gate,
  GateConfigError,
  parseDocument,
  repoPath,
} from './aps-gate-config.js';
import { appendGateEvidence } from './aps-gate-ledger.js';
import { type MetricResult, compareMetric, extractMetric, worse } from './aps-gate-metrics.js';
import type { ApsCommandOptions } from './aps-shared.js';
import { importCore } from './helpers.js';

export interface ApsGateOptions extends ApsCommandOptions {
  updateBaseline?: boolean;
  format?: string;
}
interface GateResult {
  id: string;
  item: number;
  mode: Gate['mode'];
  enforcement: 'block' | 'warn';
  status: 'pass' | 'fail' | 'error' | 'skipped' | 'exempt';
  exitCode: number | null;
  durationMs: number;
  exemption: string | null;
  message: string;
  metrics: MetricResult[];
  stdout?: string;
  stderr?: string;
}
interface GateRunResult {
  schema: 'aps-gate-result/1';
  runId: string;
  repo: string;
  headSha: string;
  baseRef: string | null;
  baseSha: string | null;
  configSha256: string;
  baselineSha256: string | null;
  startedAt: string;
  finishedAt: string;
  verdict: 'pass' | 'fail' | 'error';
  gates: GateResult[];
  warnings: string[];
  baselineUpdated: boolean;
}
function optionalFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw new GateConfigError(`cannot read ${path}: ${String(error)}`);
  }
}

export async function executeApsGates(options: ApsGateOptions): Promise<GateRunResult> {
  if (options.format !== undefined && !['json', 'table'].includes(options.format))
    throw new GateConfigError('--format must be table|json');
  const root = realpathSync(resolve(options.projectDir ?? process.cwd()));
  const startedAt = new Date().toISOString();
  const configText = optionalFile(repoPath(root, '.aps/gates.json'));
  if (configText === null) throw new GateConfigError('missing .aps/gates.json');
  const config = parseDocument(configText, 'config', '.aps/gates.json');
  const baselineFile = config.baselineFile ?? '.aps/baseline.json';
  const exemptionsFile = config.exemptionsFile ?? '.aps/exemptions.json';
  const baselinePath = repoPath(root, baselineFile);
  const exemptionsPath = repoPath(root, exemptionsFile);
  if (baselinePath === exemptionsPath || baselinePath === repoPath(root, '.aps/gates.json'))
    throw new GateConfigError('baselineFile must not overwrite configuration or exemptions');
  const baselineText = optionalFile(baselinePath);
  const headBaseline: Baseline =
    baselineText === null ? { version: 1, gates: {} } : parseDocument(baselineText, 'baseline', baselineFile);
  const headExemptionsText = optionalFile(exemptionsPath);
  const headExemptions =
    headExemptionsText === null ? [] : parseDocument(headExemptionsText, 'exemptions', exemptionsFile).exemptions;
  const core = await importCore();
  async function git(args: string[], raw = false): Promise<string> {
    const result = await core.runCommand('git', args, { cwd: root });
    if (!result.ok) throw new GateConfigError(`git ${args.join(' ')}: ${result.stderr.trim()}`);
    return raw ? result.stdout : result.stdout.trim();
  }
  const headSha = await git(['rev-parse', '--verify', 'HEAD^{commit}']);
  let baseSha: string | null = null;
  let changedPaths: string[] = [];
  let baseBaseline: Baseline = { version: 1, gates: {} };
  let exemptions: Exemption[] = [];
  if (options.baseRef) {
    baseSha = await git(['rev-parse', '--verify', `${options.baseRef}^{commit}`]);
    const mergeBase = await git(['merge-base', baseSha, headSha]);
    const paths = await git(['diff', '--name-only', '-z', `${mergeBase}..${headSha}`], true);
    changedPaths = paths.split('\0').filter(Boolean);
    async function baseFile(path: string): Promise<string | null> {
      const exists = await git(['ls-tree', '--name-only', baseSha as string, '--', path]);
      return exists ? git(['show', `${baseSha}:${path}`], true) : null;
    }
    const baseText = await baseFile(baselineFile);
    if (baseText !== null) baseBaseline = parseDocument(baseText, 'baseline', `base:${baselineFile}`);
    const exemptionsText = await baseFile(exemptionsFile);
    if (exemptionsText !== null)
      exemptions = parseDocument(exemptionsText, 'exemptions', `base:${exemptionsFile}`).exemptions;
  }
  const warnings: string[] = [];
  if (!options.baseRef) {
    exemptions = headExemptions;
    warnings.push('local-mode: head baseline/exemptions trusted');
  }
  for (const exemption of headExemptions) {
    if (!exemptions.some((entry) => entry.id === exemption.id && JSON.stringify(entry) === JSON.stringify(exemption)))
      warnings.push(`pending-exemption: ${exemption.id} is not approved in the base-ref file`);
  }
  const today = new Date().toISOString().slice(0, 10);
  exemptions = exemptions.filter((entry) => {
    if (entry.expiresAt < today) {
      warnings.push(`expired-exemption: ${entry.id}`);
      return false;
    }
    return entry.createdAt <= today;
  });
  // Validate every configured path before executing any gate.
  for (const gate of config.gates) {
    const cwd = repoPath(root, gate.run.cwd ?? '.');
    for (const metric of gate.metrics ?? [])
      if (metric.source.file) repoPath(root, relative(root, resolve(cwd, metric.source.file)));
  }
  const gates: GateResult[] = [];
  for (const gate of config.gates) {
    const cwd = repoPath(root, gate.run.cwd ?? '.');
    const row: GateResult = {
      id: gate.id,
      item: gate.item,
      mode: gate.mode,
      enforcement: gate.mode === 'report' ? 'warn' : (gate.enforcement ?? 'block'),
      status: 'pass',
      exitCode: null,
      durationMs: 0,
      exemption: null,
      message: '',
      metrics: [],
    };
    gates.push(row);
    if (
      options.baseRef &&
      gate.when &&
      !changedPaths.some((path) => gate.when?.changedPaths.some((glob) => minimatch(path, glob, { dot: true })))
    ) {
      row.status = 'skipped';
      row.message = 'No matching changed paths';
      continue;
    }
    const start = Date.now();
    const command: RunResult = await core.runCommand(gate.run.argv[0], gate.run.argv.slice(1), {
      cwd,
      env: { ...process.env, ...gate.run.env },
      timeoutMs: (gate.run.timeoutSec ?? 900) * 1000,
    });
    row.durationMs = Date.now() - start;
    row.exitCode = command.code < 0 ? null : command.code;
    row.stdout = command.stdout;
    row.stderr = command.stderr;
    const gateExemption = exemptions.find(
      (entry) => entry.gate === gate.id && !entry.metric && entry.effect === 'waive',
    );
    if (command.code < 0 || !(gate.run.okExitCodes ?? [0]).includes(command.code)) {
      row.status = command.code >= 0 && gate.mode === 'required' ? (gateExemption ? 'exempt' : 'fail') : 'error';
      row.exemption = row.status === 'exempt' ? (gateExemption?.id ?? null) : null;
      row.message = command.stderr.trim() || `Command exited ${command.code}`;
      continue;
    }
    for (const metric of gate.metrics ?? []) {
      const exemption =
        exemptions.find((entry) => entry.gate === gate.id && entry.metric === metric.id) ?? gateExemption;
      try {
        const value = extractMetric(metric, cwd, command.stdout, command.code, root);
        const measured = compareMetric(
          gate,
          metric,
          value,
          baseBaseline.gates[gate.id]?.[metric.id],
          headBaseline.gates[gate.id]?.[metric.id],
          Boolean(options.baseRef),
          exemption,
        );
        row.metrics.push(measured);
        if (measured.status === 'exempt' || measured.baselineSource === 'exemption')
          row.exemption = exemption?.id ?? null;
      } catch (error) {
        row.metrics.push({
          id: metric.id,
          value: null,
          baseline: null,
          baselineSource: null,
          limit: null,
          delta: null,
          improved: false,
          status: 'error',
          message: String(error),
        });
      }
    }
    row.status = row.metrics.some((metric) => metric.status === 'error')
      ? 'error'
      : row.metrics.some((metric) => ['fail', 'no-baseline', 'seed-mismatch'].includes(metric.status))
        ? 'fail'
        : row.metrics.some((metric) => metric.status === 'exempt')
          ? 'exempt'
          : 'pass';
    row.message = row.metrics
      .filter((metric) => !['pass', 'exempt'].includes(metric.status))
      .map((metric) => `${metric.id}: ${metric.message ?? metric.status}`)
      .join('; ');
  }
  let baselineUpdated = false;
  if (options.updateBaseline) {
    let refused = false;
    for (const [index, gate] of config.gates.entries()) {
      const row = gates[index];
      if (row.status === 'skipped') continue;
      if (
        row.status === 'error' ||
        (gate.mode === 'required' && row.exitCode !== null && !(gate.run.okExitCodes ?? [0]).includes(row.exitCode))
      )
        refused = true;
      for (const [metricIndex, metric] of (gate.metrics ?? []).entries()) {
        const value = row.metrics[metricIndex]?.value;
        if (value === undefined || value === null) {
          refused = true;
          continue;
        }
        const base = baseBaseline.gates[gate.id]?.[metric.id];
        const head = headBaseline.gates[gate.id]?.[metric.id];
        if (
          (base && worse(value, base.value, metric)) ||
          (head && worse(value, head.value, metric)) ||
          (['threshold', 'ratchet'].includes(gate.mode) &&
            ((metric.min !== undefined && value < metric.min) || (metric.max !== undefined && value > metric.max)))
        )
          refused = true;
      }
    }
    if (refused)
      warnings.push('baseline-update-refused: regression, threshold failure or tool error; baseline unchanged');
    else {
      const next: Baseline = structuredClone(headBaseline);
      for (const [index, gate] of config.gates.entries()) {
        if (gates[index].status === 'skipped') continue;
        for (const [metricIndex, metric] of (gate.metrics ?? []).entries()) {
          const result = gates[index].metrics[metricIndex];
          const value = result.value as number;
          const previous = headBaseline.gates[gate.id]?.[metric.id];
          const base = baseBaseline.gates[gate.id]?.[metric.id];
          const candidates = [value, ...(previous ? [previous.value] : []), ...(base ? [base.value] : [])];
          const best = metric.direction === 'lower' ? Math.min(...candidates) : Math.max(...candidates);
          next.gates[gate.id] ??= {};
          next.gates[gate.id][metric.id] = { value: best, sha: headSha, measuredAt: new Date().toISOString() };
          if (['no-baseline', 'seed-mismatch'].includes(result.status)) result.status = 'pass';
        }
        if (
          gates[index].status === 'fail' &&
          gates[index].metrics.every((metric) => ['pass', 'exempt'].includes(metric.status))
        ) {
          gates[index].status = 'pass';
          gates[index].message = 'Baseline seeded or tightened';
        }
      }
      mkdirSync(dirname(baselinePath), { recursive: true });
      const temp = `${baselinePath}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx' });
        renameSync(temp, baselinePath);
      } catch (error) {
        try {
          unlinkSync(temp);
        } catch (cleanupError) {
          if (!(cleanupError instanceof Error && 'code' in cleanupError && cleanupError.code === 'ENOENT'))
            throw new AggregateError([error, cleanupError], 'Baseline write and cleanup failed');
        }
        throw error;
      }
      baselineUpdated = true;
    }
  }
  const blocking = gates.filter((gate) => gate.enforcement === 'block');
  const verdict = blocking.some((gate) => gate.status === 'error')
    ? 'error'
    : blocking.some((gate) => gate.status === 'fail') ||
        warnings.some((warning) => warning.startsWith('baseline-update-refused:'))
      ? 'fail'
      : 'pass';
  return {
    schema: 'aps-gate-result/1',
    runId: randomUUID(),
    repo: config.repo,
    headSha,
    baseRef: options.baseRef ?? null,
    baseSha,
    configSha256: createHash('sha256').update(configText).digest('hex'),
    baselineSha256: baselineText === null ? null : createHash('sha256').update(baselineText).digest('hex'),
    startedAt,
    finishedAt: new Date().toISOString(),
    verdict,
    gates,
    warnings,
    baselineUpdated,
  };
}

export async function runApsGateCommand(options: ApsGateOptions): Promise<void> {
  try {
    const result = await executeApsGates(options);
    if (options.card) await appendGateEvidence(options, result);
    if (options.json || options.format === 'json') process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else {
      process.stdout.write('GATE                              MODE       STATUS    METRICS\n');
      for (const gate of result.gates) {
        const metrics = gate.metrics
          .map((metric) => `${metric.id}=${metric.value ?? '?'} (baseline ${metric.baseline ?? '-'}; ${metric.status})`)
          .join(', ');
        process.stdout.write(`${gate.id.padEnd(34)}${gate.mode.padEnd(11)}${gate.status.padEnd(10)}${metrics}\n`);
        if (gate.message) process.stdout.write(`  ${gate.message}\n`);
      }
      for (const warning of result.warnings) process.stdout.write(`Warning: ${warning}\n`);
      process.stdout.write(
        `APS gates: ${result.verdict.toUpperCase()}${result.baselineUpdated ? ' (baseline updated)' : ''}\n`,
      );
    }
    process.exitCode = result.verdict === 'pass' ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.json || options.format === 'json')
      process.stdout.write(`${JSON.stringify({ verdict: 'error', message })}\n`);
    else process.stderr.write(`[mmbridge] ${message}\n`);
    process.exitCode = 2;
  }
}
