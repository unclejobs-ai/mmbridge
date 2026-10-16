import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ApsInputError as InputError, type Transition } from '@mmbridge/aps';
import { exitWithError, importAps, importCore, jsonOutput } from './helpers.js';

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
  directionRef?: string;
  designAuthority?: string;
  reviewBudget?: string;
  riskTier?: string;
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
  partial?: boolean;
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
  auto?: boolean;
}

const DURATION_UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

/** `90`, `90s`, `30m`, `2h`, `500ms` → ms (bare numbers are seconds); undefined → 0. */
export function parseDuration(value: string | undefined, flag: string): number {
  if (value === undefined) return 0;
  const match = /^(\d+)(ms|s|m|h)?$/.exec(value.trim());
  if (!match) throw new InputError(`--${flag} must look like 90s, 30m or 2h`);
  return Number(match[1]) * DURATION_UNIT_MS[match[2] ?? 's'];
}
export function required(value: unknown, flag: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new InputError(`--${flag} is required`);
  return value;
}
export function choice(value: unknown, flag: string, allowed: string[], fallback?: string): string {
  const text = value === undefined && fallback !== undefined ? fallback : required(value, flag);
  if (!allowed.includes(text)) throw new InputError(`--${flag} must be ${allowed.join('|')}`);
  return text;
}
export function fileText(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    throw new InputError(`cannot read file ${file}`);
  }
}
export function jsonFile(value: string | undefined, flag: string, fallback?: string): string {
  if (value === undefined && fallback !== undefined) return fallback;
  const path = required(value, flag);
  const content = fileText(path.startsWith('@') ? path.slice(1) : path);
  try {
    return JSON.stringify(JSON.parse(content));
  } catch {
    throw new InputError(`--${flag}: invalid JSON in ${path}`);
  }
}
export function sha(value: string | undefined, flag: string): string {
  const text = required(value, flag).toLowerCase();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(text)) throw new InputError(`--${flag} must be a 40 or 64 digit hex SHA`);
  return text;
}
export function emit(value: unknown, json?: boolean): void {
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
export async function withLedger(
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
    aps.doctor(ledger);
    for (const warning of aps.escalateFeedback(ledger)) process.stderr.write(`[mmbridge] ${warning}\n`);
    const result = await aps.commandTransaction(ledger, () => action(ledger, by));
    emit(result, options.json);
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
