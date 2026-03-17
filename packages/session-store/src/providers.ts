import path from 'node:path';
import { loadConfig } from '@mmbridge/core';
import type { MemoryProviderName, MmbridgeConfig } from '@mmbridge/core';
import { ProjectMemoryStore } from './project-memory.js';
import type {
  BuildRecallOptions,
  HandoffArtifact,
  HandoffDocument,
  MemoryEntry,
  MemoryProvider,
  MemorySearchOptions,
  MemoryTimelineOptions,
  RecallResult,
} from './types.js';

class ProjectStoreMemoryProvider implements MemoryProvider {
  readonly provider: MemoryProviderName = 'project';

  constructor(private readonly store: ProjectMemoryStore) {}

  buildRecall(projectDir: string, options: BuildRecallOptions): Promise<RecallResult> {
    return this.store.buildRecall(projectDir, options);
  }

  createOrUpdateHandoff(
    projectDir: string,
    sessionId: string,
    recalledMemoryIds: string[] = [],
  ): Promise<HandoffDocument> {
    return this.store.createOrUpdateHandoff(projectDir, sessionId, recalledMemoryIds);
  }

  getLatestHandoff(projectDir: string): Promise<HandoffArtifact | null> {
    return this.store.getLatestHandoff(projectDir);
  }

  getHandoffBySession(projectDir: string, sessionId: string): Promise<HandoffDocument | null> {
    return this.store.getHandoffBySession(projectDir, sessionId);
  }

  searchMemory(options: MemorySearchOptions): Promise<MemoryEntry[]> {
    return this.store.searchMemory(options);
  }

  timelineMemory(options: MemoryTimelineOptions): Promise<MemoryEntry[]> {
    return this.store.timelineMemory(options);
  }

  showMemory(projectDir: string, ids: string[]): Promise<MemoryEntry[]> {
    return this.store.showMemory(projectDir, ids);
  }
}

export async function createMemoryProvider(options: {
  projectDir: string;
  baseDir?: string;
  config?: MmbridgeConfig;
}): Promise<MemoryProvider> {
  const projectDir = path.resolve(options.projectDir);
  const config = options.config ?? (await loadConfig(projectDir));
  const provider = config.memory?.provider ?? 'project';

  if (provider === 'project') {
    return new ProjectStoreMemoryProvider(new ProjectMemoryStore(options.baseDir));
  }

  throw new Error(`Memory provider "${provider}" is not implemented yet. Use "project" for now.`);
}
