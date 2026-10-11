import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { AuditLane, AuditReport, VisionVerdict } from '@mmbridge/aps';
import { herdrLanes, ledgerLanes, recentVisionVerdicts } from './aps-lanes.js';
import { probeQuota } from './aps-quota.js';
import { exitWithError, importAps, importCore, jsonOutput } from './helpers.js';

export interface ApsAuditOptions {
  db?: string;
  json?: boolean;
  out?: string;
  quotaJson?: string;
  projectDir?: string;
  herdr?: boolean;
  stallMin?: string;
}

/** Exit code when the audit ran but found violations (distinct from 1 = audit failed). */
export const AUDIT_VIOLATION_EXIT = 4;

export interface AuditRun {
  report: AuditReport;
  markdown: string;
  probes: { quotaSource: string | null; ledger: string | null; errors: string[] };
}

/** Read-only: herdr lanes + live ledger runs + quota probe → APS §14 audit. Never writes the ledger. */
export async function runAudit(options: ApsAuditOptions, now = Date.now()): Promise<AuditRun> {
  const aps = await importAps();
  const core = await importCore();
  const errors: string[] = [];
  let lanes: AuditLane[] = [];
  if (options.herdr !== false) {
    try {
      lanes = await herdrLanes();
    } catch (error) {
      errors.push(`herdr: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const config = await core.loadConfig(resolve(options.projectDir ?? process.cwd()));
  const dbPath = aps.resolveApsDbPath({ flag: options.db, configPath: config.aps?.dbPath });
  let ledger: string | null = null;
  let visionVerdicts: VisionVerdict[] = [];
  if (existsSync(dbPath)) {
    const db = aps.openApsDbReadOnly(dbPath);
    try {
      const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
      if (version >= 2) lanes = [...lanes, ...(await ledgerLanes(db, lanes))];
      else errors.push(`ledger ${dbPath} is schema v${version}: run lanes need v2 (FAC-M12 cutover)`);
      visionVerdicts = recentVisionVerdicts(db, now);
      ledger = `${dbPath} (v${version})`;
    } finally {
      db.close();
    }
  } else errors.push(`ledger not found at ${dbPath}`);
  const quota = await probeQuota(options.quotaJson, now);
  errors.push(...quota.errors);
  const stallMin = Number(options.stallMin ?? '30');
  const report = aps.buildAudit({ now, lanes, quota: quota.quota, visionVerdicts, stallMs: stallMin * 60_000 });
  const footer = [
    '',
    '## Probes',
    '',
    `- quota: ${quota.source ?? 'unavailable'}`,
    `- ledger: ${ledger ?? 'unavailable'}`,
    ...errors.map((error) => `- warning: ${error}`),
  ];
  return {
    report,
    markdown: `${aps.renderAuditMarkdown(report)}${footer.join('\n')}\n`,
    probes: { quotaSource: quota.source, ledger, errors },
  };
}

export async function runApsAuditCommand(options: ApsAuditOptions): Promise<void> {
  let run: AuditRun;
  try {
    run = await runAudit(options);
  } catch (error) {
    exitWithError(error instanceof Error ? error.message : String(error), 1);
  }
  if (options.out) {
    const out = resolve(options.out);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(`${out}.tmp`, run.markdown);
    renameSync(`${out}.tmp`, out);
  }
  if (options.json) jsonOutput({ ...run.report, probes: run.probes });
  else process.stdout.write(run.markdown);
  if (run.report.violations.length > 0) process.exitCode = AUDIT_VIOLATION_EXIT;
}
