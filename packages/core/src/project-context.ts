import { getDefaultBaseRef, getDiffFileCount, getGitStatusSummary, getHead } from './git.js';
import type { BuildProjectContextOptions, ProjectContext } from './types.js';

export async function buildProjectContext(options: BuildProjectContextOptions = {}): Promise<ProjectContext> {
  const projectDir = options.projectDir ?? process.cwd();
  const sessions = options.sessions ?? [];

  const [head, gitStatus, defaultBase] = await Promise.all([
    getHead(projectDir),
    getGitStatusSummary(projectDir),
    getDefaultBaseRef(projectDir),
  ]);

  const baseRef = options.preferredBaseRef ?? defaultBase;
  const baseDiffCount = await getDiffFileCount(baseRef, projectDir);

  const uncommittedCount = gitStatus.staged + gitStatus.unstaged + gitStatus.untracked;

  const modeCount: Record<string, number> = {};
  const toolCount: Record<string, number> = {};
  let lastSessionAt: string | null = null;

  for (const session of sessions) {
    if (session.mode) {
      modeCount[session.mode] = (modeCount[session.mode] ?? 0) + 1;
    }
    if (session.tool) {
      toolCount[session.tool] = (toolCount[session.tool] ?? 0) + 1;
    }
    if (session.createdAt) {
      if (!lastSessionAt || session.createdAt > lastSessionAt) {
        lastSessionAt = session.createdAt;
      }
    }
  }

  return {
    projectDir,
    head,
    baseRef,
    gitStatus,
    uncommittedCount,
    baseDiffCount,
    totalSessions: sessions.length,
    modeCount,
    toolCount,
    lastSessionAt,
  };
}

export function formatProjectContext(ctx: ProjectContext): string {
  const lines: string[] = [
    `Project: ${ctx.projectDir}`,
    `Branch: ${ctx.head.branch} (${ctx.head.sha})`,
    `Base ref: ${ctx.baseRef}`,
    `Git status: ${ctx.gitStatus.staged} staged, ${ctx.gitStatus.unstaged} unstaged, ${ctx.gitStatus.untracked} untracked`,
    `Changed files vs base: ${ctx.baseDiffCount}`,
    `Sessions: ${ctx.totalSessions}`,
    ctx.lastSessionAt ? `Last session: ${ctx.lastSessionAt}` : 'No prior sessions',
  ];
  return lines.join('\n');
}
