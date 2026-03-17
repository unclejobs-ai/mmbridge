import { importSessionStore, jsonOutput, resolveProjectDir } from './helpers.js';

export interface MemorySearchCommandOptions {
  project?: string;
  type?: import('@mmbridge/session-store').MemoryEntryType;
  limit?: string;
  query: string;
  json?: boolean;
}

export interface MemoryTimelineCommandOptions {
  project?: string;
  session?: string;
  query?: string;
  limit?: string;
  json?: boolean;
}

export interface MemoryShowCommandOptions {
  project?: string;
  ids: string;
  json?: boolean;
}

function renderEntries(title: string, entries: import('@mmbridge/session-store').MemoryEntry[]): string {
  return [
    title,
    ...entries.flatMap((entry) => {
      const meta = [
        entry.type,
        entry.severity ?? null,
        entry.file ? `${entry.file}${entry.line != null ? `:${entry.line}` : ''}` : null,
        entry.createdAt,
      ]
        .filter((part): part is string => Boolean(part))
        .join(' · ');
      return [`- ${entry.title}`, `  ${meta}`, `  ${entry.content}`];
    }),
  ].join('\n');
}

export async function runMemorySearchCommand(options: MemorySearchCommandOptions): Promise<void> {
  const projectDir = resolveProjectDir(options.project);
  const { createMemoryProvider } = await importSessionStore();
  const memoryStore = await createMemoryProvider({ projectDir });
  const entries = await memoryStore.searchMemory({
    projectDir,
    query: options.query,
    type: options.type,
    limit: options.limit ? Number(options.limit) : undefined,
  });

  if (options.json) {
    jsonOutput(entries);
    return;
  }

  process.stdout.write(`${renderEntries(`Memory Search · ${options.query}`, entries)}\n`);
}

export async function runMemoryTimelineCommand(options: MemoryTimelineCommandOptions): Promise<void> {
  const projectDir = resolveProjectDir(options.project);
  const { createMemoryProvider } = await importSessionStore();
  const memoryStore = await createMemoryProvider({ projectDir });
  const entries = await memoryStore.timelineMemory({
    projectDir,
    sessionId: options.session,
    query: options.query,
    limit: options.limit ? Number(options.limit) : undefined,
  });

  if (options.json) {
    jsonOutput(entries);
    return;
  }

  process.stdout.write(`${renderEntries('Memory Timeline', entries)}\n`);
}

export async function runMemoryShowCommand(options: MemoryShowCommandOptions): Promise<void> {
  const projectDir = resolveProjectDir(options.project);
  const { createMemoryProvider } = await importSessionStore();
  const memoryStore = await createMemoryProvider({ projectDir });
  const entries = await memoryStore.showMemory(
    projectDir,
    options.ids
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );

  if (options.json) {
    jsonOutput(entries);
    return;
  }

  process.stdout.write(`${renderEntries('Memory Show', entries)}\n`);
}
