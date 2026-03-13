import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Session, SessionListOptions, ProjectState } from './types.js';

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

  async save(session: Partial<Session> & { tool: string; mode: string; projectDir: string; workspace: string }): Promise<Session> {
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

    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const fullPath = path.join(this.sessionsDir, entry);
      try {
        const parsed = JSON.parse(await fs.readFile(fullPath, 'utf8')) as Session;
        if (options.tool && parsed.tool !== options.tool) continue;
        if (normalizedProjectDir && path.resolve(parsed.projectDir ?? '') !== normalizedProjectDir) continue;
        sessions.push(parsed);
      } catch {
        // ignore malformed session files
      }
    }

    sessions.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return sessions;
  }

  async remove(id: string): Promise<boolean> {
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
  return path.resolve(projectDir).replace(/[\\/]/g, '-').replace(/^(?!-)/, '-');
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

export { type Session, type SessionListOptions, type ProjectState } from './types.js';
