import {
  exitWithError,
  importAdapters,
  importSessionStore,
  importTui,
  jsonOutput,
  resolveProjectDir,
} from './helpers.js';

export interface FollowupCommandOptions {
  tool: string;
  prompt: string;
  json?: boolean;
  explicitSessionId?: string;
  projectDir?: string;
  useLatestWhenMissing?: boolean;
}

export async function runFollowupCommand(options: FollowupCommandOptions): Promise<void> {
  const projectDir = resolveProjectDir(options.projectDir);

  const { SessionStore } = await importSessionStore();
  const { runFollowupAdapter } = await importAdapters();
  const { renderReviewConsole } = await importTui();

  const sessionStore = new SessionStore(projectDir);

  let sessionId = options.explicitSessionId;
  if (!sessionId) {
    if (options.useLatestWhenMissing) {
      const sessions = await sessionStore.list({ tool: options.tool });
      const latest = sessions[0] ?? null;
      if (!latest?.externalSessionId) {
        exitWithError(`No external session ID found for tool "${options.tool}". Run a review first.`);
      }
      sessionId = latest.externalSessionId;
    } else {
      exitWithError('Session ID is required. Pass --session or run with --latest flag.');
    }
  }

  const result = await runFollowupAdapter(options.tool, {
    workspace: projectDir,
    cwd: projectDir,
    sessionId,
    prompt: options.prompt,
  });

  const report = {
    externalSessionId: result.externalSessionId ?? undefined,
    summary: result.text,
    findings: [],
    followupSupported: result.followupSupported,
  };

  if (options.json) {
    jsonOutput(report);
    return;
  }

  await renderReviewConsole(report);
}
