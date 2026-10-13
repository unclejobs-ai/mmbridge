import { readFileSync } from 'node:fs';
import { openApsDb, resolveApsDbPath } from './index.js';
import { backfillEvents, syncOmpWorkers, syncOwnerEntries } from './directives.js';

// stdin JSON keeps owner quotes out of shell interpolation and process argv.
const request = JSON.parse(readFileSync(0, 'utf8'));
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
