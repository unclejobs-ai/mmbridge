import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { EmbraceRun } from '@mmbridge/core';

const EMBRACE_DIR = path.join(os.homedir(), '.mmbridge', 'embrace');

function isSafeId(id: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(id);
}

async function atomicWrite(filePath: string, data: string): Promise<void> {
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  try {
    await fs.writeFile(tmpPath, data, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tmpPath, filePath);
  } catch (error) {
    await fs.unlink(tmpPath).catch(() => {});
    throw error;
  }
}

export interface EmbraceRunListOptions {
  projectDir?: string;
  limit?: number;
}

export class EmbraceRunStore {
  private readonly baseDir: string;

  constructor(baseDir: string = EMBRACE_DIR) {
    this.baseDir = baseDir;
  }

  async save(run: EmbraceRun): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true });
    await atomicWrite(this.filePath(run.id), JSON.stringify(run, null, 2));
  }

  async load(id: string): Promise<EmbraceRun | null> {
    if (!isSafeId(id)) {
      return null;
    }
    try {
      const raw = await fs.readFile(this.filePath(id), 'utf8');
      return JSON.parse(raw) as EmbraceRun;
    } catch {
      return null;
    }
  }

  async list(options: EmbraceRunListOptions = {}): Promise<EmbraceRun[]> {
    await fs.mkdir(this.baseDir, { recursive: true });

    let entries: string[];
    try {
      entries = await fs.readdir(this.baseDir);
    } catch {
      return [];
    }

    const runs: EmbraceRun[] = [];
    const normalizedProjectDir = options.projectDir ? path.resolve(options.projectDir) : null;

    const jsonFiles = entries.filter((entry) => entry.endsWith('.json'));
    const fileContents = await Promise.allSettled(
      jsonFiles.map((file) => fs.readFile(path.join(this.baseDir, file), 'utf8')),
    );
    for (const [i, result] of fileContents.entries()) {
      if (result.status === 'fulfilled') {
        try {
          const run = JSON.parse(result.value) as EmbraceRun;
          if (normalizedProjectDir && path.resolve(run.projectDir) !== normalizedProjectDir) continue;
          runs.push(run);
        } catch {
          // Ignore malformed run files
        }
      }
    }

    runs.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));

    if (options.limit !== undefined && options.limit > 0) {
      return runs.slice(0, options.limit);
    }

    return runs;
  }

  async delete(id: string): Promise<boolean> {
    if (!isSafeId(id)) {
      return false;
    }
    try {
      await fs.unlink(this.filePath(id));
      return true;
    } catch {
      return false;
    }
  }

  private filePath(id: string): string {
    return path.join(this.baseDir, `${id}.json`);
  }
}
