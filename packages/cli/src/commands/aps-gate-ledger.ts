import { resolve } from 'node:path';
import type { ApsCommandOptions } from './aps-shared.js';
import { required } from './aps-shared.js';
import { importAps, importCore } from './helpers.js';

export async function validateLedgerOptions(options: ApsCommandOptions): Promise<void> {
  const aps = await importAps();
  required(options.by ?? process.env.APS_AGENT, 'by');
  const cardId = required(options.card, 'card');
  const core = await importCore();
  const config = await core.loadConfig(resolve(options.projectDir ?? process.cwd()));
  const db = aps.openApsDb(aps.resolveApsDbPath({ flag: options.db, configPath: config.aps?.dbPath }));
  try {
    aps.doctor(db);
    aps.getCard(db, cardId);
  } finally {
    db.close();
  }
}

/** M02 run events are lifecycle-only; attach repeatable gate evidence without advancing the run. */
export async function appendGateEvidence(
  options: ApsCommandOptions,
  result: { runId: string; gates?: unknown[] },
): Promise<string> {
  const aps = await importAps();
  const by = required(options.by ?? process.env.APS_AGENT, 'by');
  const cardId = required(options.card, 'card');
  const core = await importCore();
  const config = await core.loadConfig(resolve(options.projectDir ?? process.cwd()));
  const db = aps.openApsDb(aps.resolveApsDbPath({ flag: options.db, configPath: config.aps?.dbPath }));
  try {
    aps.doctor(db);
    const ref = `aps-gate:${result.runId}`;
    // Omit stdout/stderr from the --card detail
    const ledgerDetail = {
      ...result,
      gates: Array.isArray(result.gates)
        ? (result.gates as Array<Record<string, unknown>>).map(({ stdout: _out, stderr: _err, ...rest }) => rest)
        : result.gates,
    };
    aps.transaction(db, () => aps.addLink(db, cardId, by, 'other', ref, ledgerDetail));
    return ref;
  } finally {
    db.close();
  }
}
