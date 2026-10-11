import { resolve } from 'node:path';
import type { ApsCommandOptions } from './aps-shared.js';
import { required } from './aps-shared.js';
import { importAps, importCore } from './helpers.js';

export const GATE_TOKEN_RULES = [
  { pattern: 'ghp_[A-Za-z0-9_]+', replacement: '[REDACTED_GH_TOKEN]', label: 'GitHub PAT' },
  { pattern: 'ghs_[A-Za-z0-9_]+', replacement: '[REDACTED_GH_TOKEN]', label: 'GitHub app token' },
  {
    pattern: 'Authorization:\\s*\\S+(?:\\s+\\S+)?',
    replacement: '[REDACTED_AUTHORIZATION]',
    label: 'Authorization header',
    flags: 'i',
  },
  {
    // Fail-safe: bounded {0,32} trailing segment after keyword + negative-lookahead list of safe continuations (gi).
    // Replaces closed suffix list; redacts PASSWORD2= etc while leaving author, auth_failures, tokenizer, keyboard, key_count=4 unredacted.
    pattern:
      '(?<![A-Za-z0-9_])[A-Za-z0-9_]{0,128}(?:key|secret|token|passw(?:or)?d|pwd|credential|auth)(?!(?:or|ors|ority|ored|oring|ori[sz]ation|ori[sz]e[ds]?|enticat[a-z]*|izer|izers|ization|board|boards|_?count|_?failures?|_?errors?|_?total|_?type|_?url|_?file|_?path|_?name|_?tokens?)(?![A-Za-z0-9]))[A-Za-z0-9_]{0,32}(?![A-Za-z0-9_])["\']?\\s*[:=]\\s*(?!\\[REDACTED_)(?:"(?:[^"\\\\]|\\\\.)*"|\'[^\']*\'|\\S+)',
    replacement: '[REDACTED_SECRET]',
    label: 'secret assignment',
    flags: 'gi',
  },
  {
    // Userinfo only: stop at quotes and at a path @ (scoped packages). Password may contain / or @. Use lookbehind to not match /@ in paths.
    pattern: '[a-z][a-z0-9+.-]{0,32}://[^\\s/:"@]{1,256}(?::[^\\s"]{0,512})?(?<!/)@(?=[^\\s/"@])',
    replacement: '[REDACTED_URL_USERINFO]',
    label: 'URL userinfo',
    flags: 'i',
  },
  { pattern: 'AKIA[0-9A-Z]{16}', replacement: '[REDACTED_AWS_KEY]', label: 'AWS access key' },
  { pattern: 'xox[abprs]-[0-9A-Za-z-]+', replacement: '[REDACTED_SLACK_TOKEN]', label: 'Slack token' },
];

const REDACT_TAIL_SLACK_BYTES = 4096;

export function redactBoundedText(
  redact: (value: string, rules?: typeof GATE_TOKEN_RULES) => { redacted: string },
  text: string,
  maxBytes: number,
): string {
  const buf = Buffer.from(text, 'utf8');
  const windowBytes = maxBytes + REDACT_TAIL_SLACK_BYTES;
  let slice = buf.byteLength <= windowBytes ? text : buf.subarray(buf.byteLength - windowBytes).toString('utf8');
  if (buf.byteLength > windowBytes) {
    const newline = slice.indexOf('\n');
    if (newline >= 0) slice = slice.slice(newline + 1);
  }
  const redacted = redact(slice, GATE_TOKEN_RULES).redacted;
  const out = Buffer.from(redacted, 'utf8');
  if (out.byteLength <= maxBytes) return redacted;
  return out.subarray(out.byteLength - maxBytes).toString('utf8');
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
  result: { runId: string; gates?: unknown[]; warnings?: unknown[] },
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
    const redactText = (value: string): string => redactBoundedText(core.redactContent, value, 2048);
    // Never persist raw stdout/stderr. Messages, metric messages, and warnings are short redacted tails.
    const ledgerDetail = {
      ...result,
      warnings: Array.isArray(result.warnings)
        ? result.warnings.map((warning) => (typeof warning === 'string' ? redactText(warning) : warning))
        : result.warnings,
      gates: Array.isArray(result.gates)
        ? result.gates.map((gate) => {
            if (gate === null || typeof gate !== 'object') return gate;
            const { stdout: _out, stderr: _err, message, metrics, ...rest } = gate as Record<string, unknown>;
            return {
              ...rest,
              message: redactText(typeof message === 'string' ? message : ''),
              metrics: Array.isArray(metrics)
                ? metrics.map((metric) => {
                    if (metric === null || typeof metric !== 'object') return metric;
                    const row = metric as Record<string, unknown>;
                    return {
                      ...row,
                      message: typeof row.message === 'string' ? redactText(row.message) : row.message,
                    };
                  })
                : metrics,
            };
          })
        : result.gates,
    };
    aps.transaction(db, () => aps.addLink(db, cardId, by, 'other', ref, ledgerDetail));
    return ref;
  } finally {
    db.close();
  }
}
