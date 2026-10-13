#!/usr/bin/env node
// SceneSteller roadmap ops: owner intake (INBOX.md), triage, and handoff readiness checks.
// Storage is plain markdown under $SS_WORK (default ~/ss-work) so it survives reboots and is human-readable.
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const ROOT = process.env.SS_WORK || join(homedir(), 'ss-work');
const AUDIT_MODULE = pathToFileURL(join(ROOT, 'tools', 'ssops-audit.mjs')).href;
const INBOX = join(ROOT, 'INBOX.md');
const OUTBOX = join(ROOT, 'INBOX.aps-outbox.jsonl');
const APS_CONFIG = join(ROOT, 'tools', 'ssops-aps.json');
const COMMAND_OUTBOX = join(ROOT, 'INBOX.aps-commands.jsonl');
const TODO = join(ROOT, 'TODO.md');
const ROADMAP = join(ROOT, 'ROADMAP.md');
const DEFAULT_HANDOFF = join(ROOT, 'squads', 'MAIN-HANDOFF.md');

const CLASSES = {
  now: 'fix/adjust inside an active lane → TODO.md line + message the squad lead',
  roadmap: 'new scope, ready to build → ROADMAP.md milestone + TODO.md line',
  plan: 'needs planning before dispatch → plans/<slug>.md + ROADMAP.md Planning queue',
  change: 'modifies an existing item/decision → edit the target in place, cite the IN id',
  decision: 'owner decision → MAIN-HANDOFF.md "Owner decisions"',
  dup: 'already covered → point at the existing line',
  info: 'context only, no action',
};
const HANDOFF_HEADINGS = ['## Now', '## Next', '## Blocked', '## Owner decisions pending', '## Running', '## Resume prompt'];
// Lock dirs are meant to vanish on reboot, so mentioning them is fine. ss-heavy-gate belongs to another project and appears only in "never touch" notes.
const ALLOWED_TMP = ['/tmp/ss-dev-slot', '/tmp/scenesteller-jest-gate', '/tmp/aside-slot', '/tmp/ss-heavy-gate'];
const HEADER = `# INBOX: owner intake (append-only)

Every owner message that adds, changes or questions scope gets one entry, verbatim.
Triage every entry before any handoff: \`node ~/.agents/skills/ss-roadmap-ops/scripts/ssops.mjs inbox triage <id> --class <c> --to <dest>\`.
Classes: ${Object.keys(CLASSES).join(' · ')}.
`;

const die = (msg, code = 1) => { console.error(msg); process.exit(code); };

function parseArgs(argv) {
  const pos = []; const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      opt[k] = v;
    } else pos.push(a);
  }
  return { pos, opt };
}

function kst(d = new Date()) {
  const t = new Date(d.getTime() + 9 * 3600e3).toISOString();
  return { day: t.slice(0, 10).replaceAll('-', ''), stamp: `${t.slice(0, 10)} ${t.slice(11, 16)} KST` };
}

function readEntries() {
  if (!existsSync(INBOX)) return { head: HEADER, entries: [] };
  const src = readFileSync(INBOX, 'utf8');
  const parts = src.split(/^(?=### IN-)/m);
  const head = parts[0];
  const entries = parts.slice(1).map((raw) => {
    const m = raw.match(/^### (IN-\d{8}-[A-Za-z0-9_-]+) · ([^·\n]+) · (\w+)/);
    if (!m) die(`INBOX.md: malformed entry header:\n${raw.split('\n')[0]}`);
    const field = (k) => (raw.match(new RegExp(`^- ${k}: (.*)$`, 'm')) || [])[1]?.trim() ?? '';
    const quote = raw.split('\n').filter((l) => l.startsWith('> ')).map((l) => l.slice(2)).join('\n');
    return { id: m[1], at: m[2].trim(), status: m[3], quote, cls: field('class'), to: field('to'), note: field('note') };
  });
  return { head, entries };
}

function render({ head, entries }) {
  const body = entries.map((e) => [
    `### ${e.id} · ${e.at} · ${e.status}`,
    ...e.quote.split('\n').map((l) => `> ${l}`),
    `- class: ${e.cls || '—'}`,
    `- to: ${e.to || '—'}`,
    `- note: ${e.note || '—'}`,
    '',
  ].join('\n'));
  return `${head.trimEnd()}\n\n${body.join('\n')}`;
}

// INBOX is shared by every session (Main, forks, side sessions). Each mutation is one transaction:
// take an exclusive mkdir lock, read, allocate the id, write a temp file, rename over INBOX, release.
const LOCK = `${INBOX}.lock`;
const LOCK_STALE_MS = 30e3;
const LOCK_WAIT_MS = 15e3;
let lockHeld = false;
process.on('exit', () => { if (lockHeld) try { rmSync(LOCK, { recursive: true, force: true }); } catch {} });

function sleepMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

function acquireLock() {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (let delay = 5; ; delay = Math.min(delay * 2, 200)) {
    try {
      mkdirSync(LOCK);
      writeFileSync(join(LOCK, 'owner'), `${process.pid} ${Date.now()}`);
      lockHeld = true;
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    let stale = false;
    try {
      const [pid, at] = readFileSync(join(LOCK, 'owner'), 'utf8').split(' ').map(Number);
      stale = !pidAlive(pid) || Date.now() - at > LOCK_STALE_MS;
    } catch {
      // Owner file not written yet: the holder is between mkdir and write. Stale only if the dir itself is old.
      try { stale = Date.now() - statSync(LOCK).mtimeMs > LOCK_STALE_MS; } catch { continue; }
    }
    if (stale) { try { rmSync(LOCK, { recursive: true, force: true }); } catch {} continue; }
    if (Date.now() > deadline) die(`INBOX is locked by another session (${LOCK}); retry shortly`);
    sleepMs(delay + Math.floor(Math.random() * delay));
  }
}

function releaseLock() { rmSync(LOCK, { recursive: true, force: true }); lockHeld = false; }

function apsRequest(request) {
  const config = existsSync(APS_CONFIG) ? JSON.parse(readFileSync(APS_CONFIG, 'utf8')) : {};
  const runner = process.env.SSOPS_APS_RUNNER || config.runner || join(ROOT, 'tools', 'aps-directives', 'dist', 'ssops-bridge.js');
  const host = process.env.SSOPS_APS_HOST || config.host;
  const db = process.env.MMBRIDGE_APS_DB || process.env.APS_DB || config.db || join(ROOT, 'aps', 'aps.db');
  const command = host ? 'ssh' : process.execPath;
  // The host and absolute runner path are operator configuration, never owner text.
  if (host && (!/^[A-Za-z0-9_.@-]+$/.test(host) || !/^\/[A-Za-z0-9_./-]+$/.test(runner))) throw new Error('invalid APS remote configuration');
  const args = host ? ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', host, `/opt/homebrew/bin/node ${runner}`] : [runner];
  const result = spawnSync(command, args, { input: JSON.stringify({ ...request, db }), encoding: 'utf8', timeout: 15000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr.trim() || `APS exited ${result.status}`);
  return JSON.parse(result.stdout);
}

function syncInbox(data, strict = false, backfill = false) {
  try {
    const events = existsSync(OUTBOX) ? readFileSync(OUTBOX, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
    return apsRequest({ action: 'inbox', events, entries: backfill ? data.entries : [], source: INBOX });
  } catch (error) {
    console.error(`WARNING APS: ${error.message}; INBOX.md and ${OUTBOX} retain owner intake; recover with ssops inbox backfill`);
    if (strict) process.exitCode = 1;
    return null;
  }
}

function inboxBackfill() {
  mutateInbox((data) => {
    const result = syncInbox(data, true, true);
    if (result) console.log(`owner_directives ${result.total} / INBOX ${data.entries.length}; inserted ${result.inserted}; triaged ${result.triaged}`);
  }, [], false);
}

function ompSync(opt) {
  const input = readFileSync(typeof opt.file === 'string' ? opt.file : 0, 'utf8');
  const rows = apsRequest({ action: 'omp-sync', input });
  for (const row of rows) {
    console.log(`${row.name} ${row.card} ${row.state}`);
    if (row.warning) console.error(`WARNING APS: ${row.name}: ${row.warning}`);
  }
}

function inboxReplay(requests) {
  const appended = [];
  const receipts = mutateInbox((data) => {
    const journal = existsSync(OUTBOX) ? readFileSync(OUTBOX, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
    const known = new Map(journal.map((event) => [event.ref, event]));
    const aliases = new Map(journal.filter((event) => event.client_id).map((event) => [event.client_id, event.entry.id]));
    const receipts = [];
    for (const request of requests) {
      if (!request.ref || !Array.isArray(request.args) || request.args[0] !== 'inbox') throw new Error('invalid intake replay request');
      let event = known.get(request.ref);
      if (!event) {
        const { pos, opt } = parseArgs(request.args.slice(2));
        if (aliases.has(pos[0])) pos[0] = aliases.get(pos[0]);
        if (request.args[1] === 'triage' && !data.entries.some((entry) => entry.id === pos[0])) {
          receipts.push({ ref: request.ref, error: `inbox triage: ${pos[0]} not found; request retained on client` });
          continue;
        }
        let entry;
        if (request.args[1] === 'add') entry = applyInboxAdd(data, opt);
        else if (request.args[1] === 'triage') entry = applyInboxTriage(data, pos, opt);
        else throw new Error('only add/triage may be replayed');
        event = { ref: request.ref, entry: { ...entry }, client_id: request.client_id };
        appended.push(event);
        known.set(event.ref, event);
        if (event.client_id) aliases.set(event.client_id, event.entry.id);
      }
      receipts.push({ ref: request.ref, client_id: event.client_id, entry: { ...(data.entries.find((entry) => entry.id === event.entry.id) || event.entry) } });
    }
    return receipts;
  }, appended);
  console.log(JSON.stringify(receipts));
}

function forwardInbox() {
  const config = existsSync(APS_CONFIG) ? JSON.parse(readFileSync(APS_CONFIG, 'utf8')) : {};
  if (!config.forwardInbox) return false;
  let current;
  if (sub === 'add' || sub === 'triage') {
    const { pos, opt } = parseArgs(rest);
    const ref = `air:${randomUUID()}`;
    current = { ref, args: process.argv.slice(2), client_id: sub === 'add' ? `IN-${kst().day}-AIR-${ref.slice(4)}` : undefined };
    const stamp = opt.at || kst().stamp;
    if (sub === 'add' && !opt.at) current.args.push('--at', stamp);
    if (sub === 'add' && (typeof opt.text !== 'string' || !opt.text.trim())) die('inbox add: --text is required');
    if (sub === 'triage' && (!pos[0] || !CLASSES[opt.class] || (!opt.to && opt.class !== 'info'))) die('inbox triage: valid id, --class and --to required');
    mutateInbox((data) => {
      const fd = openSync(COMMAND_OUTBOX, 'a');
      try { appendFileSync(fd, JSON.stringify(current) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
      if (sub === 'add') data.entries.push({ id: current.client_id, at: stamp, status: 'untriaged', quote: opt.text, cls: '', to: '', note: '' });
      else {
        const entry = data.entries.find((entry) => entry.id === pos[0]);
        if (entry) Object.assign(entry, { status: 'triaged', cls: opt.class, to: opt.to || 'none', note: typeof opt.note === 'string' ? opt.note : entry.note });
      }
    }, [], false);
  }
  try {
    const requests = existsSync(COMMAND_OUTBOX) ? readFileSync(COMMAND_OUTBOX, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
    let receipts = [];
    if (requests.length) {
      const replay = apsRequest({ action: 'inbox-command', args: ['inbox','replay'], requests, inboxRoot: config.inboxRoot });
      if (replay.status !== 0) throw new Error(replay.stderr || 'canonical inbox replay failed');
      if (replay.stderr) process.stderr.write(replay.stderr);
      receipts = JSON.parse(replay.stdout);
      mutateInbox((data) => {
        for (const receipt of receipts) {
          if (!receipt.entry) continue;
          if (receipt.client_id) data.entries = data.entries.filter((entry) => entry.id !== receipt.client_id || entry.id === receipt.entry.id);
          const existing = data.entries.find((entry) => entry.id === receipt.entry.id);
          if (existing) Object.assign(existing, receipt.entry);
          else data.entries.push(receipt.entry);
        }
      }, [], false);
    }
    if (current) {
      const receipt = receipts.find((receipt) => receipt.ref === current.ref);
      if (!receipt) throw new Error('canonical inbox did not acknowledge client dedupe key');
      if (receipt.error) throw new Error(receipt.error);
      console.log(sub === 'add' ? receipt.entry.id : `${receipt.entry.id} → ${receipt.entry.cls}: ${receipt.entry.to}`);
    } else {
      const result = apsRequest({ action: 'inbox-command', args: process.argv.slice(2), inboxRoot: config.inboxRoot });
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
      process.exitCode = result.status;
    }
  } catch (error) {
    console.error(`WARNING APS: ${error.message}; durable ${COMMAND_OUTBOX} retains intake. Retry any ssops inbox command to replay the same dedupe keys.`);
    if (current) console.log(current.client_id || current.args[2]);
    else process.exitCode = 1;
  }
  return true;
}

function mutateInbox(fn, suppliedEvents = null, mirror = true) {
  acquireLock();
  try {
    const data = readEntries();
    // Reconcile a journalled mutation whose process died before the markdown rename.
    if (existsSync(OUTBOX)) {
      for (const event of readFileSync(OUTBOX, 'utf8').split('\n').filter(Boolean).map(JSON.parse)) {
        const entry = data.entries.find((entry) => entry.id === event.entry.id);
        if (entry && entry.quote !== event.entry.quote) throw new Error(`INBOX quote conflict ${entry.id}`);
        if (entry) Object.assign(entry, event.entry);
        else data.entries.push({ ...event.entry });
      }
    }
    const before = new Map(data.entries.map((entry) => [entry.id, JSON.stringify(entry)]));
    const out = fn(data);
    const tmp = `${INBOX}.${process.pid}.tmp`;
    writeFileSync(tmp, render(data));
    const events = suppliedEvents ?? data.entries.filter((entry) => before.get(entry.id) !== JSON.stringify(entry)).map((entry) => ({ ref: `${INBOX}#event:${randomUUID()}`, entry }));
    // Durable append precedes rename: even interruption between the two cannot lose the quote/triage.
    const fd = openSync(OUTBOX, 'a');
    try { appendFileSync(fd, events.map((event) => JSON.stringify(event) + '\n').join('')); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(tmp, INBOX);
    if (mirror) syncInbox(data);
    return out;
  } finally {
    releaseLock();
  }
}

function applyInboxAdd(data, opt) {
  const text = typeof opt.text === 'string' ? opt.text : '';
  if (!text.trim()) die('inbox add: --text "<verbatim owner message>" is required');
  const { day, stamp } = opt.at ? { day: String(opt.at).slice(0, 10).replaceAll('-', ''), stamp: String(opt.at) } : kst();
  const prefix = `IN-${day}-`;
  const max = data.entries.filter((e) => e.id.startsWith(prefix) && /^\d+$/.test(e.id.slice(prefix.length))).reduce((m, e) => Math.max(m, Number(e.id.slice(prefix.length))), 0);
  const entry = { id: `${prefix}${String(max + 1).padStart(2, '0')}`, at: stamp, status: 'untriaged', quote: text, cls: '', to: '', note: '' };
  data.entries.push(entry);
  return entry;
}

function inboxAdd(opt) {
  const id = mutateInbox((data) => applyInboxAdd(data, opt).id);
  console.log(id);
}

function applyInboxTriage(data, pos, opt) {
  const id = pos[0];
  if (!id) die('inbox triage: <id> required');
  const cls = opt.class;
  if (!CLASSES[cls]) die(`inbox triage: --class must be one of ${Object.keys(CLASSES).join(', ')}`);
  const to = typeof opt.to === 'string' ? opt.to.trim() : '';
  if (!to && cls !== 'info') die('inbox triage: --to "<destination>" required (file§section, TODO line, PR, plans/<slug>.md)');
  const e = data.entries.find((x) => x.id === id);
  if (!e) die(`inbox triage: ${id} not found`);
  Object.assign(e, { status: 'triaged', cls, to: to || 'none', note: typeof opt.note === 'string' ? opt.note : e.note });
  return e;
}

function inboxTriage(pos, opt) {
  const dest = mutateInbox((data) => applyInboxTriage(data, pos, opt).to);
  const id = pos[0];
  const cls = opt.class;
  console.log(`${id} → ${cls}: ${dest}`);
}

function inboxList(opt) {
  const { entries } = readEntries();
  const rows = opt.untriaged ? entries.filter((e) => e.status === 'untriaged') : entries;
  for (const e of rows) console.log(`${e.id}  ${e.status.padEnd(9)}  ${(e.cls || '-').padEnd(8)}  ${e.quote.replace(/\s+/g, ' ').slice(0, 90)}`);
  console.log(`${rows.length} shown / ${entries.length} total, ${entries.filter((e) => e.status === 'untriaged').length} untriaged`);
}

async function check(opt) {
  const handoff = typeof opt.handoff === 'string' ? (isAbsolute(opt.handoff) ? opt.handoff : join(ROOT, opt.handoff)) : DEFAULT_HANDOFF;
  const fails = [];
  let auditIntent = /(?:^|[/\\])(?:AuditRound2|audit-round-2)(?:[/\\]|$)/i.test(handoff) || opt['audit-job'] !== undefined;
  const { entries } = readEntries();
  for (const e of entries) {
    if (e.status === 'untriaged') fails.push(`INBOX ${e.id} is untriaged`);
    else if (e.cls === 'plan') {
      const p = e.to.match(/plans\/[\w.-]+\.md/)?.[0];
      if (!p || !existsSync(join(ROOT, p))) fails.push(`INBOX ${e.id} is class plan but its plan file is missing (to: ${e.to})`);
    }
  }
  if (!existsSync(ROADMAP)) fails.push('ROADMAP.md is missing');
  if (!existsSync(handoff)) fails.push(`handoff missing: ${handoff}`);
  else {
    const h = readFileSync(handoff, 'utf8');
    auditIntent ||= /^Audit-Job:/m.test(h);
    for (const hd of HANDOFF_HEADINGS) if (!h.split('\n').some((l) => l.trim().startsWith(hd))) fails.push(`handoff lacks heading "${hd}"`);
    const tmp = [...h.matchAll(/\/tmp\/[\w./-]*/g)].map((m) => m[0]).filter((p) => !ALLOWED_TMP.some((a) => p.startsWith(a)));
    if (tmp.length) fails.push(`handoff references ${tmp.length} non-lock /tmp path(s), wiped on reboot: ${[...new Set(tmp)].slice(0, 5).join(', ')}`);
    const hm = statSync(handoff).mtimeMs;
    for (const f of [TODO, ROADMAP, INBOX]) {
      if (existsSync(f) && statSync(f).mtimeMs > hm + 60e3) fails.push(`handoff is older than ${f.split('/').pop()}; refresh it last`);
    }
  }
  if (auditIntent) {
    try {
      const { auditHandoffFailures } = await import(AUDIT_MODULE);
      fails.push(...auditHandoffFailures(ROOT, handoff, opt));
    } catch (error) {
      fails.push(`audit predecessor gate unavailable: ${error.message}`);
    }
  }
  if (fails.length) {
    console.log(`HANDOFF NOT READY (${fails.length}):`);
    for (const f of fails) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log(`HANDOFF READY: ${handoff}`);
}

function status() {
  const { entries } = readEntries();
  const by = {};
  for (const e of entries) by[e.status === 'untriaged' ? 'untriaged' : e.cls] = (by[e.status === 'untriaged' ? 'untriaged' : e.cls] || 0) + 1;
  console.log(`INBOX ${entries.length}: ${Object.entries(by).map(([k, v]) => `${k}=${v}`).join(' ') || 'empty'}`);
  if (existsSync(TODO)) {
    const t = readFileSync(TODO, 'utf8');
    const c = (re) => (t.match(re) || []).length;
    console.log(`TODO done=${c(/^- \[x\]/gm)} doing=${c(/^- \[~\]/gm)} open=${c(/^- \[ \]/gm)}`);
  }
  if (existsSync(ROADMAP)) {
    for (const l of readFileSync(ROADMAP, 'utf8').split('\n')) if (/^## M\d/.test(l)) console.log(l.slice(3));
  }
}

const DRILL = `You are a cold reader with zero prior context. Read ONLY these files:
${ROOT}/squads/MAIN-HANDOFF.md, ${ROOT}/ROADMAP.md, ${ROOT}/TODO.md, ${ROOT}/INBOX.md.
Answer from the files alone, citing file:line for each answer:
1. Which milestone is active, and what is its exit criterion?
2. The next 3 concrete actions, in order, each with owner (agent/lane) and PR/branch.
3. Everything blocked, and what unblocks each item.
4. Owner decisions still pending, and the default being used meanwhile.
5. What is running right now (agents, background jobs, services), and what dies on a reboot.
6. The most recent owner request, and where it was routed.
Then list every question you could NOT answer from the files. Each one is a handoff defect.`;

// Blocks until INTERCOM.md grows, then prints only the appended text and exits 0.
// Run it as an async background job (bash async, no timeout): the job's completion wakes the
// session with the new message. Re-arm it after reading.
function intercomWatch() {
  const file = join(ROOT, 'INTERCOM.md');
  const size = () => (existsSync(file) ? statSync(file).size : 0);
  const start = size();
  const timer = setInterval(() => {
    const now = size();
    if (now < start) { console.log('INTERCOM.md was truncated or replaced; re-read it in full.'); process.exit(0); }
    if (now === start) return;
    sleepMs(500); // let the writer finish its append
    const buf = readFileSync(file);
    process.stdout.write(buf.subarray(start).toString('utf8'));
    clearInterval(timer);
    process.exit(0);
  }, 2000);
}

const [cmd, sub, ...rest] = process.argv.slice(2);
if (cmd === 'inbox' && forwardInbox()) {
  // Canonical MBP handled the command, or its client-keyed durable queue retained it.
} else if (cmd === 'inbox') {
  const { pos, opt } = parseArgs(rest);
  if (sub === 'add') inboxAdd(opt);
  else if (sub === 'triage') inboxTriage(pos, opt);
  else if (sub === 'list') inboxList(opt);
  else if (sub === 'backfill') inboxBackfill();
  else if (sub === 'replay') inboxReplay(JSON.parse(readFileSync(0, 'utf8')));
  else die('usage: ssops inbox add|triage|list|backfill');
} else if (cmd === 'audit') {
  try {
    const { pos, opt } = parseArgs(rest);
    const { auditCommand } = await import(AUDIT_MODULE);
    console.log(auditCommand(ROOT, sub, pos, opt));
  } catch (error) {
    die(`AUDIT CHANGES_REQUESTED: ${error.message}`);
  }
} else if (cmd === 'check') await check(parseArgs([sub, ...rest].filter(Boolean)).opt);
else if (cmd === 'status') status();
else if (cmd === 'drill') console.log(DRILL);
else if (cmd === 'classes') for (const [k, v] of Object.entries(CLASSES)) console.log(`${k.padEnd(9)} ${v}`);
else if (cmd === 'intercom' && sub === 'watch') intercomWatch();
else if (cmd === 'omp-sync') {
  try { ompSync(parseArgs([sub, ...rest].filter(Boolean)).opt); }
  catch (error) { die(`APS omp-sync: ${error.message}`); }
}
else die('usage: ssops inbox add|triage|list|backfill · omp-sync [--file <path>] · check [--handoff <path>] [--audit-job <job>] · audit dispatch|accept|check <job> · status · drill · classes · intercom watch');
