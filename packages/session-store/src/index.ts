import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ProjectState, Session, SessionListOptions } from './types.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertValidId(id: string): void {
  if (!UUID_PATTERN.test(id)) {
    throw new Error(`Invalid session ID format: ${id}`);
  }
}

function defaultBaseDir(): string {
  return path.join(os.homedir(), '.mmbridge');
}

async function atomicWrite(filePath: string, data: string): Promise<void> {
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  try {
    await fs.writeFile(tmpPath, data, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
}

export class SessionStore {
  readonly baseDir: string;
  private readonly sessionsDir: string;

  constructor(baseDir: string = defaultBaseDir()) {
    this.baseDir = baseDir;
    this.sessionsDir = path.join(baseDir, 'sessions');
  }

  async init(): Promise<void> {
    await fs.mkdir(this.sessionsDir, { recursive: true });
  }

  async save(
    session: Partial<Session> & { tool: string; mode: string; projectDir: string; workspace: string },
  ): Promise<Session> {
    await this.init();
    const id = session.id ?? randomUUID();
    const payload: Session = {
      createdAt: session.createdAt ?? new Date().toISOString(),
      ...session,
      id,
    };
    const filePath = this.filePath(id);
    await atomicWrite(filePath, JSON.stringify(payload, null, 2));
    return payload;
  }

  async get(id: string): Promise<Session | null> {
    assertValidId(id);
    try {
      const raw = await fs.readFile(this.filePath(id), 'utf8');
      return JSON.parse(raw) as Session;
    } catch {
      return null;
    }
  }

  async list(options: SessionListOptions = {}): Promise<Session[]> {
    await this.init();
    const entries = await fs.readdir(this.sessionsDir);
    const sessions: Session[] = [];
    const normalizedProjectDir = options.projectDir ? path.resolve(options.projectDir) : null;
    const normalizedQuery = options.query?.trim().toLowerCase() ?? '';
    const normalizedFile = options.file?.trim().toLowerCase() ?? '';
    const normalizedSeverity = options.severity?.trim().toUpperCase() ?? '';

    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const fullPath = path.join(this.sessionsDir, entry);
      try {
        const parsed = JSON.parse(await fs.readFile(fullPath, 'utf8')) as Session;
        if (options.tool && parsed.tool !== options.tool) continue;
        if (options.mode && parsed.mode !== options.mode) continue;
        if (normalizedProjectDir && path.resolve(parsed.projectDir ?? '') !== normalizedProjectDir) continue;
        if (
          normalizedSeverity &&
          !(parsed.findings ?? []).some((finding) => finding.severity?.toUpperCase() === normalizedSeverity)
        ) {
          continue;
        }
        if (
          normalizedFile &&
          !(parsed.findings ?? []).some((finding) => finding.file?.toLowerCase().includes(normalizedFile))
        ) {
          continue;
        }
        if (normalizedQuery) {
          const summaryMatch = parsed.summary?.toLowerCase().includes(normalizedQuery) ?? false;
          const findingMatch = (parsed.findings ?? []).some(
            (finding) =>
              finding.message?.toLowerCase().includes(normalizedQuery) ||
              finding.file?.toLowerCase().includes(normalizedQuery),
          );
          if (!summaryMatch && !findingMatch) continue;
        }
        sessions.push(parsed);
      } catch {
        // ignore malformed session files
      }
    }

    sessions.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return typeof options.limit === 'number' ? sessions.slice(0, options.limit) : sessions;
  }

  async remove(id: string): Promise<boolean> {
    assertValidId(id);
    try {
      await fs.unlink(this.filePath(id));
      return true;
    } catch {
      return false;
    }
  }

  private filePath(id: string): string {
    return path.join(this.sessionsDir, `${id}.json`);
  }
}

function projectKey(projectDir: string): string {
  return path
    .resolve(projectDir)
    .replace(/[\\/]/g, '-')
    .replace(/^(?!-)/, '-');
}

export class ProjectStateStore {
  readonly baseDir: string;
  private readonly projectsDir: string;

  constructor(baseDir: string = defaultBaseDir()) {
    this.baseDir = baseDir;
    this.projectsDir = path.join(baseDir, 'projects');
  }

  async init(): Promise<void> {
    await fs.mkdir(this.projectsDir, { recursive: true });
  }

  async get(projectDir: string): Promise<ProjectState | null> {
    await this.init();
    const id = projectKey(projectDir);
    try {
      const raw = await fs.readFile(this.filePath(id), 'utf8');
      return JSON.parse(raw) as ProjectState;
    } catch {
      return null;
    }
  }

  async save(projectDir: string, state: Partial<ProjectState> = {}): Promise<ProjectState> {
    await this.init();
    const id = projectKey(projectDir);
    const payload: ProjectState = {
      ...state,
      projectDir: path.resolve(projectDir),
      updatedAt: new Date().toISOString(),
      id,
    };
    await atomicWrite(this.filePath(id), JSON.stringify(payload, null, 2));
    return payload;
  }

  async update(projectDir: string, patch: Partial<ProjectState> = {}): Promise<ProjectState> {
    const current = await this.get(projectDir);
    return this.save(projectDir, { ...(current ?? {}), ...patch });
  }

  private filePath(id: string): string {
    return path.join(this.projectsDir, `${id}.json`);
  }
}

export type { Session, SessionListOptions, ProjectState } from './types.js';
