import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface LiveState {
  active: boolean;
  tool: string;
  mode: string;
  phase: string;
  currentDetail?: string;
  elapsed: number;
  startedAt: string;
  streamLines: string[];
  events: Array<{ time: string; message: string }>;
  toolStates?: Array<{
    tool: string;
    status: 'pending' | 'running' | 'done' | 'error';
    detail?: string;
  }>;
  telemetry?: {
    spawnedAgents: number;
    toolCalls: number;
    commandExecutions: number;
    agentMessages: number;
    startedItems: number;
    completedItems: number;
  };
  progress?: number;
  findingsSoFar?: number;
}

export function getLiveStatePath(): string {
  return path.join(os.homedir(), '.mmbridge', '.live.json');
}

export async function writeLiveState(state: LiveState): Promise<void> {
  const filePath = getLiveStatePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(state, null, 2), 'utf8');
}

export async function readLiveState(): Promise<LiveState | null> {
  try {
    const filePath = getLiveStatePath();
    const content = await fs.readFile(filePath, 'utf8');
    return JSON.parse(content) as LiveState;
  } catch {
    return null;
  }
}

export async function clearLiveState(): Promise<void> {
  try {
    await fs.unlink(getLiveStatePath());
  } catch {
    // ignore errors — file may not exist
  }
}
