import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ReviewRun } from '@mmbridge/core';

function defaultBaseDir(): string {
  return path.join(os.homedir(), '.mmbridge');
}

async function atomicWrite(filePath: string, data: string): Promise<void> {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tmpPath, data, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tmpPath, filePath);
  } catch (error) {
    await fs.unlink(tmpPath).catch(() => {});
    throw error;
  }
}

function isSafeRunId(id: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(id);
}

export interface RunListOptions {
  projectDir?: string;
  mode?: string;
  tool?: string;
}

export class RunStore {
  readonly baseDir: string;
  private readonly runsDir: string;

  constructor(baseDir: string = defaultBaseDir()) {
    this.baseDir = baseDir;
    this.runsDir = path.join(baseDir, 'runs');
  }

  async init(): Promise<void> {
    await fs.mkdir(this.runsDir, { recursive: true });
  }

  async save(run: Omit<ReviewRun, 'id'> & { id?: string }): Promise<ReviewRun> {
    await this.init();
    const id = run.id ?? randomUUID();
    if (!isSafeRunId(id)) {
      throw new Error(`Invalid run ID: "${id}"`);
    }
    const payload: ReviewRun = { ...run, id };
    await atomicWrite(this.filePath(id), JSON.stringify(payload, null, 2));
    return payload;
  }

  async get(id: string): Promise<ReviewRun | null> {
    if (!isSafeRunId(id)) {
      return null;
    }
    try {
      const raw = await fs.readFile(this.filePath(id), 'utf8');
      return JSON.parse(raw) as ReviewRun;
    } catch {
      return null;
    }
  }

  async list(options: RunListOptions = {}): Promise<ReviewRun[]> {
    await this.init();
    const entries = await fs.readdir(this.runsDir);
    const runs: ReviewRun[] = [];
    const normalizedProjectDir = options.projectDir ? path.resolve(options.projectDir) : null;

    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(path.join(this.runsDir, entry), 'utf8');
        const run = JSON.parse(raw) as ReviewRun;
        if (normalizedProjectDir && path.resolve(run.projectDir) !== normalizedProjectDir) continue;
        if (options.mode && run.mode !== options.mode) continue;
        if (options.tool && run.tool !== options.tool) continue;
        runs.push(run);
      } catch {
        // Ignore malformed run files.
      }
    }

    runs.sort((a, b) => {
      const aTime = a.completedAt ?? a.startedAt;
      const bTime = b.completedAt ?? b.startedAt;
      return aTime < bTime ? 1 : -1;
    });

    return runs;
  }

  async getLatest(options: RunListOptions = {}): Promise<ReviewRun | null> {
    const runs = await this.list(options);
    return runs[0] ?? null;
  }

  private filePath(id: string): string {
    return path.join(this.runsDir, `${id}.json`);
  }
}
