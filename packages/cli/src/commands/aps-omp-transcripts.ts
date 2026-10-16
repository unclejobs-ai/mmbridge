import { type Dirent, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, sep } from 'node:path';

/**
 * omp task transcripts live in `<root>/<cwd-slug>/<parent-session>/<id>.jsonl`. A task spawned by a task nests
 * one directory deeper per level: `<parent-session>/<Id>/<Id>.<Child>.jsonl`.
 */
const MAX_SUBAGENT_DEPTH = 4;

/** Root of every omp session; also the prefix of the dispatch pointer-mode `session_ref` pattern. */
export function ompSessionsRoot(): string {
  return join(homedir(), '.omp', 'agent', 'sessions');
}

function entries(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Task transcripts in a parent session directory and its nested task directories. `_`/`.` names are omp-internal. */
function walk(dir: string, depth: number, found: string[]): void {
  for (const entry of entries(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth < MAX_SUBAGENT_DEPTH) walk(path, depth + 1, found);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl') && !/^[._]/.test(entry.name)) found.push(path);
  }
}

/** Every task transcript under a sessions root (parent transcripts at the slug level are excluded). */
export function subagentTranscripts(root = ompSessionsRoot()): string[] {
  const found: string[] = [];
  for (const slug of entries(root)) {
    if (!slug.isDirectory()) continue;
    for (const parent of entries(join(root, slug.name)))
      if (parent.isDirectory()) walk(join(root, slug.name, parent.name), 1, found);
  }
  return found.sort();
}

/** Transcripts named `<ompId>.jsonl` inside one parent session directory (`scope`), nested task dirs included. */
export function findTaskTranscripts(ompId: string, scope: string): string[] {
  const name = `${ompId}.jsonl`;
  const found: string[] = [];
  walk(scope, 1, found);
  return found.filter((path) => basename(path) === name).sort();
}

/**
 * Matches of a pointer-mode `session_ref` (`<root>/*\/*\/<id>.jsonl`): every `<id>.jsonl` task transcript under
 * that root, nested ones included. Callers treat more than one match as ambiguous.
 */
export function patternTranscripts(ref: string): string[] {
  const star = ref.indexOf(`${sep}*`);
  if (star < 0 || !ref.endsWith('.jsonl')) return [];
  const name = basename(ref);
  return subagentTranscripts(ref.slice(0, star)).filter((path) => basename(path) === name);
}

/** Real path of `dir` when it is an existing directory inside the omp sessions root (symlinks resolved), else null. */
export function sessionDirInsideRoot(dir: string): string | null {
  try {
    const real = realpathSync(dir);
    const root = realpathSync(ompSessionsRoot());
    return real.startsWith(`${root}${sep}`) && statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}
