import { resolve } from 'node:path';
import type { ApsCommandOptions } from './aps-shared.js';
import { required } from './aps-shared.js';
import { importAps, importCore } from './helpers.js';

const GATE_TOKEN_RULES = [
  { pattern: 'ghp_[A-Za-z0-9_]+', replacement: '[REDACTED_GH_TOKEN]', label: 'GitHub PAT' },
  { pattern: 'ghs_[A-Za-z0-9_]+', replacement: '[REDACTED_GH_TOKEN]', label: 'GitHub app token' },
  {
    pattern: '(?:TOKEN|token|secret|password)\\s*[:=]\\s*\\S+',
    replacement: '[REDACTED_SECRET]',
    label: 'token assignment',
  },
];

export function redactBoundedText(
  redact: (value: string, rules?: typeof GATE_TOKEN_RULES) => { redacted: string },
  text: string,
  maxBytes: number,
): string {
  const redacted = redact(text, GATE_TOKEN_RULES).redacted;
  const buf = Buffer.from(redacted, 'utf8');
  if (buf.byteLength <= maxBytes) return redacted;
  return buf.subarray(buf.byteLength - maxBytes).toString('utf8');
}
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
    // Never persist raw stdout/stderr. Message is a short redacted tail.
    const ledgerDetail = {
      ...result,
      gates: Array.isArray(result.gates)
        ? (result.gates as Array<Record<string, unknown>>).map(({ stdout: _out, stderr: _err, message, ...rest }) => ({
            ...rest,
            message: redactBoundedText(core.redactContent, typeof message === 'string' ? message : '', 2048),
          }))
        : result.gates,
    };
    aps.transaction(db, () => aps.addLink(db, cardId, by, 'other', ref, ledgerDetail));
    return ref;
  } finally {
    db.close();
  }
}
