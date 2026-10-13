import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openApsDb, resolveApsDbPath } from './index.js';
import { backfillEvents, syncOmpWorkers, syncOwnerEntries } from './directives.js';

// stdin JSON keeps owner quotes out of shell interpolation and process argv.
const request = JSON.parse(readFileSync(0, 'utf8'));
if (request.action === 'inbox-command') {
  // Do not open SQLite here: canonical markdown must still record when APS is down.
  const cli = fileURLToPath(new URL('../scripts/ssops.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [cli, ...request.args], {
    env: { ...process.env, SS_WORK: request.inboxRoot || join(homedir(), 'ss-work'), MMBRIDGE_APS_DB: request.db || resolveApsDbPath() },
    input: request.requests ? JSON.stringify(request.requests) : undefined,
    encoding: 'utf8', timeout: 15000, maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  console.log(JSON.stringify({ status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr }));
} else {
  const db = openApsDb(resolveApsDbPath({ flag: request.db }));
  try {
    if (request.action === 'inbox') {
      const events = [...request.events, ...backfillEvents(request.entries || [], request.source)];
      console.log(JSON.stringify(syncOwnerEntries(db, events, request.source)));
    } else if (request.action === 'backfill') {
      console.log(JSON.stringify(syncOwnerEntries(db, backfillEvents(request.entries, request.source), request.source)));
    } else if (request.action === 'omp-sync') {
      console.log(JSON.stringify(syncOmpWorkers(db, request.input)));
    } else throw new Error(`unknown ssops APS action ${request.action}`);
  } finally {
    db.close();
  }
}
