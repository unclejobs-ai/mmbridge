import { resolve } from 'node:path';
import type { ApsCommandOptions } from './aps-shared.js';
import { required } from './aps-shared.js';
import { importAps, importCore } from './helpers.js';

/** M02 run events are lifecycle-only; attach repeatable gate evidence without advancing the run. */
export async function appendGateEvidence(options: ApsCommandOptions, result: { runId: string }): Promise<string> {
  const aps = await importAps();
  const by = required(options.by ?? process.env.APS_AGENT, 'by');
  const cardId = required(options.card, 'card');
  const core = await importCore();
  const config = await core.loadConfig(resolve(options.projectDir ?? process.cwd()));
  const db = aps.openApsDb(aps.resolveApsDbPath({ flag: options.db, configPath: config.aps?.dbPath }));
  try {
    aps.doctor(db);
    const ref = `aps-gate:${result.runId}`;
    aps.transaction(db, () => aps.addLink(db, cardId, by, 'other', ref, result));
    return ref;
  } finally {
    db.close();
  }
}
