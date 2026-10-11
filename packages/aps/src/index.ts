import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

export * from './analytics.js';
export * from './audit.js';
export * from './board.js';
export * from './ledger.js';
export * from './quota.js';
export * from './render.js';
export * from './runs.js';
export * from './usage.js';
export * from './workers.js';
export const APS_DB_ENV = 'MMBRIDGE_APS_DB';
export const APS_SQL_DIR = fileURLToPath(new URL('../sql/', import.meta.url));

const MIGRATION_FILE = /^(\d{4})_[a-z0-9_]+\.sql$/;

export interface ApsDbPathSources {
  /** `--db <path>` flag */
  flag?: string;
  /** `.mmbridge.config.json` → `aps.dbPath` */
  configPath?: string;
  env?: NodeJS.ProcessEnv;
}

/** Precedence: --db flag > MMBRIDGE_APS_DB > config aps.dbPath > ~/ss-work/aps/aps.db */
export function resolveApsDbPath(sources: ApsDbPathSources = {}): string {
  const env = sources.env ?? process.env;
  return (
    sources.flag || env[APS_DB_ENV] || env.APS_DB || sources.configPath || join(homedir(), 'ss-work', 'aps', 'aps.db')
  );
}

export interface ApsMigration {
  version: number;
  file: string;
}

export function listMigrations(sqlDir: string = APS_SQL_DIR): ApsMigration[] {
  const migrations = readdirSync(sqlDir)
    .map((file) => ({ file, match: MIGRATION_FILE.exec(file) }))
    .filter((entry): entry is { file: string; match: RegExpExecArray } => entry.match !== null)
    .map(({ file, match }) => ({ version: Number(match[1]), file }))
    .sort((a, b) => a.version - b.version);
  for (let i = 1; i < migrations.length; i++) {
    if (migrations[i].version === migrations[i - 1].version) {
      throw new Error(
        `duplicate APS migration version ${migrations[i].version}: ${migrations[i - 1].file}, ${migrations[i].file}`,
      );
    }
  }
  return migrations;
}

function userVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  return row.user_version;
}

/**
 * Opens the ledger, sets the connection pragmas every writer needs, and applies pending migrations in order.
 * Each migration file sets its own `PRAGMA user_version` inside its transaction.
 */
export function openApsDb(path: string, sqlDir: string = APS_SQL_DIR): DatabaseSync {
  const migrations = listMigrations(sqlDir);
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

  const latest = migrations.at(-1)?.version ?? 0;
  const current = userVersion(db);
  if (current > latest) {
    db.close();
    throw new Error(`APS-U01: ledger schema v${current} is newer than this build (max v${latest})`);
  }
  for (const migration of migrations) {
    if (migration.version <= current) continue;
    try {
      db.exec(readFileSync(join(sqlDir, migration.file), 'utf8'));
      const applied = userVersion(db);
      if (applied !== migration.version) {
        throw new Error(`APS migration ${migration.file} set user_version ${applied}, expected ${migration.version}`);
      }
    } catch (error) {
      // Closing with the migration transaction still open rolls it back.
      db.close();
      throw error;
    }
  }
  return db;
}
