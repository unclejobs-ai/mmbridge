import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import type { BaselineEntry, Exemption, Gate, Metric } from './aps-gate-config.js';
import { repoPath } from './aps-gate-config.js';

export interface MetricResult {
  id: string;
  value: number | null;
  baseline: number | null;
  baselineSource: 'base' | 'head' | 'head-seed' | 'exemption' | null;
  limit: number | null;
  delta: number | null;
  improved: boolean;
  target?: number;
  targetGap?: number;
  status: 'pass' | 'fail' | 'error' | 'no-baseline' | 'seed-mismatch' | 'exempt';
  message?: string;
}

export function extractMetric(metric: Metric, cwd: string, stdout: string, exitCode: number, root: string): number {
  const source = metric.source;
  if (source.kind === 'exit-code') return exitCode;
  const text = source.file ? readFileSync(repoPath(root, relative(root, resolve(cwd, source.file))), 'utf8') : stdout;
  let value: unknown;
  if (source.kind === 'json') {
    value = JSON.parse(text);
    for (const token of (source.pointer ?? '').split('/').slice(1)) {
      const key = token.replaceAll('~1', '/').replaceAll('~0', '~');
      if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key))
        throw new Error(`JSON pointer ${source.pointer} not found`);
      value = (value as Record<string, unknown>)[key];
    }
    if (Array.isArray(value)) value = value.length;
  } else if (source.kind === 'regex') {
    const match = new RegExp(source.pattern ?? '', source.flags).exec(text);
    const capture = match?.[source.group ?? 1];
    if (capture === undefined || !capture.trim()) throw new Error('regex capture not found');
    value = Number(capture);
  } else {
    const pattern = source.pattern === undefined ? null : new RegExp(source.pattern);
    value = text.split(/\r?\n/).filter((line) => line.trim() && (!pattern || pattern.test(line))).length;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('metric must be a finite number');
  return value;
}

export function compareMetric(
  gate: Gate,
  metric: Metric,
  value: number,
  base: BaselineEntry | undefined,
  head: BaselineEntry | undefined,
  seed: boolean,
  exemption?: Exemption,
): MetricResult {
  const tolerance = metric.tolerance ?? 0;
  const baseline = base ?? head;
  const result: MetricResult = {
    id: metric.id,
    value,
    baseline: baseline?.value ?? null,
    baselineSource: base ? 'base' : head ? (seed ? 'head-seed' : 'head') : null,
    limit: null,
    delta: baseline ? value - baseline.value : null,
    improved: baseline ? (metric.direction === 'lower' ? value < baseline.value : value > baseline.value) : false,
    status: 'pass',
  };
  if (metric.target !== undefined) {
    result.target = metric.target;
    result.targetGap = Math.max(0, metric.direction === 'lower' ? value - metric.target : metric.target - value);
  }
  if (gate.mode === 'required' || gate.mode === 'report') return result;
  if (exemption?.effect === 'allow' && exemption.allow !== undefined) {
    result.baselineSource = 'exemption';
    result.limit = exemption.allow;
    result.status = worse(value, exemption.allow, metric) ? 'fail' : 'pass';
    return result;
  }
  if (metric.min !== undefined && value < metric.min) {
    result.status = 'fail';
    result.limit = metric.min;
  }
  if (metric.max !== undefined && value > metric.max) {
    result.status = 'fail';
    result.limit = metric.max;
  }
  if (gate.mode === 'ratchet') {
    if (!baseline) result.status = 'no-baseline';
    else if (!base && seed && Math.abs(value - baseline.value) > tolerance) result.status = 'seed-mismatch';
    else if (worse(value, baseline.value, metric)) {
      result.status = 'fail';
      result.limit = baseline.value;
    }
  }
  if (exemption?.effect === 'waive' && result.status !== 'pass') result.status = 'exempt';
  return result;
}

export function worse(value: number, baseline: number, metric: Metric): boolean {
  const tolerance = metric.tolerance ?? 0;
  return metric.direction === 'lower' ? value > baseline + tolerance : value < baseline - tolerance;
}
