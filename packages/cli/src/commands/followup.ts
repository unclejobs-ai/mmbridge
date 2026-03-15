import {
  exitWithError,
  importAdapters,
  importCore,
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
  const { buildResultIndex, parseFindings } = await importCore();
  const { runFollowupAdapter } = await importAdapters(projectDir);
  const { renderReviewConsole } = await importTui();

  const sessionStore = new SessionStore();

  let sessionId = options.explicitSessionId;
  let parentSessionId: string | undefined;
  if (!sessionId) {
    if (options.useLatestWhenMissing) {
      const sessions = await sessionStore.list({ tool: options.tool, projectDir });
      const latest = sessions[0] ?? null;
      if (!latest?.externalSessionId) {
        exitWithError(`No external session ID found for tool "${options.tool}". Run a review first.`);
      }
      sessionId = latest.externalSessionId;
      parentSessionId = latest.id;
    } else {
      exitWithError('Session ID is required. Pass --session or run with --latest flag.');
    }
  }

  if (!parentSessionId && sessionId) {
    const sessions = await sessionStore.list({ tool: options.tool, projectDir });
    parentSessionId = sessions.find((session) => session.externalSessionId === sessionId)?.id;
  }

  const result = await runFollowupAdapter(options.tool, {
    workspace: projectDir,
    cwd: projectDir,
    sessionId,
    prompt: options.prompt,
  });

  const findings = parseFindings(result.text);
  const resultIndex = buildResultIndex({
    summary: result.text,
    findings,
    followupSupported: result.followupSupported,
    rawOutput: result.text,
    parseState: 'raw',
  });
  const savedSession = await sessionStore.save({
    tool: options.tool,
    mode: 'followup',
    projectDir,
    workspace: projectDir,
    externalSessionId: result.externalSessionId ?? sessionId,
    parentSessionId,
    summary: result.text,
    findings,
    resultIndex,
    followupSupported: result.followupSupported,
    status: result.ok ? 'complete' : 'error',
  });

  const report = {
    localSessionId: savedSession.id,
    externalSessionId: result.externalSessionId ?? sessionId,
    summary: result.text,
    findings,
    resultIndex,
    followupSupported: result.followupSupported,
  };

  if (options.json) {
    jsonOutput(report);
    return;
  }

  await renderReviewConsole(report);
}
