import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import addFormats from 'ajv-formats';
import { Ajv2020 } from 'ajv/dist/2020.js';
import schema from './aps-gate-schema.js';

export class GateConfigError extends Error {}
export interface Source {
  kind: 'json' | 'regex' | 'count-lines' | 'exit-code';
  file?: string;
  pointer?: string;
  pattern?: string;
  flags?: string;
  group?: number;
}
export interface Metric {
  id: string;
  source: Source;
  direction: 'lower' | 'higher';
  min?: number;
  max?: number;
  tolerance?: number;
  target?: number;
}
export interface Gate {
  id: string;
  item: number;
  title: string;
  mode: 'required' | 'threshold' | 'ratchet' | 'report';
  enforcement?: 'block' | 'warn';
  when?: { changedPaths: string[] };
  run: { argv: string[]; cwd?: string; timeoutSec?: number; okExitCodes?: number[]; env?: Record<string, string> };
  metrics?: Metric[];
}
export interface GateConfig {
  version: 1;
  repo: string;
  baselineFile?: string;
  exemptionsFile?: string;
  gates: Gate[];
}
export interface BaselineEntry {
  value: number;
  sha: string;
  measuredAt: string;
}
export interface Baseline {
  version: 1;
  gates: Record<string, Record<string, BaselineEntry>>;
}
export interface Exemption {
  id: string;
  gate: string;
  metric?: string;
  effect: 'waive' | 'allow';
  allow?: number;
  createdAt: string;
  expiresAt: string;
}
export interface Exemptions {
  version: 1;
  exemptions: Exemption[];
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats.default(ajv);
ajv.addSchema(schema);
const validators = {
  config: ajv.getSchema<GateConfig>(schema.$id),
  baseline: ajv.compile<Baseline>({ $ref: `${schema.$id}#/$defs/baselineFile` }),
  exemptions: ajv.compile<Exemptions>({ $ref: `${schema.$id}#/$defs/exemptionsFile` }),
};

export function parseDocument<T extends keyof typeof validators>(
  text: string,
  kind: T,
  label: string,
): T extends 'config' ? GateConfig : T extends 'baseline' ? Baseline : Exemptions {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new GateConfigError(`${label}: invalid JSON`);
  }
  const validate = validators[kind];
  if (!validate || !validate(value)) throw new GateConfigError(`${label}: ${ajv.errorsText(validate?.errors)}`);
  if (kind === 'config') {
    const config = value as GateConfig;
    const families = ['tests', 'mutation', 'static', 'arch', 'contract', 'security', 'change', 'metrics', 'review'];
    const ids = new Set<string>();
    for (const gate of config.gates) {
      if (ids.has(gate.id)) throw new GateConfigError(`${label}: duplicate gate ${gate.id}`);
      ids.add(gate.id);
      if (gate.id.split('.')[0] !== families[gate.item - 1])
        throw new GateConfigError(`${label}: ${gate.id} does not match item ${gate.item}`);
      const metrics = new Set<string>();
      for (const metric of gate.metrics ?? []) {
        if (metrics.has(metric.id)) throw new GateConfigError(`${label}: duplicate metric ${gate.id}/${metric.id}`);
        metrics.add(metric.id);
        if (metric.min !== undefined && metric.max !== undefined && metric.min > metric.max)
          throw new GateConfigError(`${label}: ${gate.id}/${metric.id} min exceeds max`);
        try {
          if (metric.source.pattern !== undefined) new RegExp(metric.source.pattern, metric.source.flags);
        } catch {
          throw new GateConfigError(`${label}: invalid regex for ${gate.id}/${metric.id}`);
        }
      }
    }
  }
  if (kind === 'exemptions') {
    const ids = new Set<string>();
    for (const exemption of (value as Exemptions).exemptions) {
      const duration = Date.parse(exemption.expiresAt) - Date.parse(exemption.createdAt);
      if (duration < 0 || duration > 30 * 86400000)
        throw new GateConfigError(`${label}: ${exemption.id} exemption must expire within 30 days`);
      if (ids.has(exemption.id)) throw new GateConfigError(`${label}: duplicate exemption ${exemption.id}`);
      ids.add(exemption.id);
    }
  }
  return value as T extends 'config' ? GateConfig : T extends 'baseline' ? Baseline : Exemptions;
}

/** Resolve existing symlinks too: config paths cannot read/write outside the repository. */
export function repoPath(root: string, path: string): string {
  const target = resolve(root, path);
  function check(candidate: string) {
    const rel = relative(realpathSync(root), candidate);
    if (rel === '..' || rel.startsWith('../') || isAbsolute(rel))
      throw new GateConfigError(`path escapes repository: ${path}`);
  }
  check(target);
  let ancestor = target;
  const suffix: string[] = [];
  while (true) {
    try {
      check(resolve(realpathSync(ancestor), ...suffix));
      return target;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      const parent = resolve(ancestor, '..');
      suffix.unshift(relative(parent, ancestor));
      ancestor = parent;
    }
  }
}
