import type { GateResult } from '@mmbridge/core';
import type { Session } from '@mmbridge/session-store';
import { importCore, importSessionStore, jsonOutput, resolveProjectDir } from './helpers.js';

export interface GateCommandOptions {
  project?: string;
  baseRef?: string;
  mode?: string;
  format?: 'compact' | 'json';
  strict?: boolean;
}

function formatGateResult(result: GateResult): string {
  if (result.status === 'pass') {
    return 'PASS review coverage is fresh for the current diff.';
  }

  const lines = ['WARN review gate raised the following checks:'];
  for (const warning of result.warnings) {
    lines.push(`- ${warning.code}: ${warning.message}`);
    lines.push(`  next: ${warning.nextCommand}`);
  }
  return lines.join('\n');
}

function toGateSession(session: Session | null) {
  if (!session) return null;
  return {
    id: session.id,
    tool: session.tool,
    mode: session.mode,
    externalSessionId: session.externalSessionId ?? null,
    followupSupported: session.followupSupported ?? false,
    findings: session.findings ?? [],
    findingDecisions: session.findingDecisions ?? [],
  };
}

function readProjectArg(argv: string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--project' || arg === '-p') {
      return argv[index + 1];
    }
    if (arg.startsWith('--project=')) {
      return arg.slice('--project='.length);
    }
  }
  return undefined;
}

export async function runGateCommand(options: GateCommandOptions): Promise<void> {
  const projectDir = resolveProjectDir(options.project ?? readProjectArg(process.argv));
  const mode = options.mode ?? 'review';
  const format = options.format ?? 'compact';

  const { evaluateGate, getChangedFiles, getDefaultBaseRef, getDiff, runCommand, shortDigest } = await importCore();
  const { ProjectMemoryStore, RunStore, SessionStore } = await importSessionStore();

  const sessionStore = new SessionStore();
  const runStore = new RunStore(sessionStore.baseDir);
  const memoryStore = new ProjectMemoryStore(sessionStore.baseDir);

  let baseRef: string | null = options.baseRef ?? null;
  let diffDigest: string | null = null;
  let changedFilesCount = 0;

  const gitRoot = await runCommand('git', ['rev-parse', '--is-inside-work-tree'], { cwd: projectDir }).catch(
    () => null,
  );
  if (gitRoot?.ok && gitRoot.stdout.trim() === 'true') {
    baseRef = baseRef ?? (await getDefaultBaseRef(projectDir));
    const [diffText, changedFiles] = await Promise.all([
      getDiff(baseRef, projectDir),
      getChangedFiles(baseRef, projectDir),
    ]);
    diffDigest = shortDigest(diffText);
    changedFilesCount = changedFiles.length;
  }

  const [latestRun, latestSessions, latestHandoff] = await Promise.all([
    runStore.getLatest({ projectDir, mode }),
    sessionStore.list({ projectDir, mode, limit: 1 }),
    memoryStore.getLatestHandoff(projectDir).catch(() => null),
  ]);

  const handoffDocument =
    latestSessions[0]?.id != null
      ? await memoryStore.getHandoffBySession(projectDir, latestSessions[0].id).catch(() => null)
      : null;

  const result = evaluateGate({
    current: {
      projectDir,
      mode,
      baseRef,
      diffDigest,
      changedFilesCount,
      explicitMode: Boolean(options.mode),
    },
    latestRun,
    latestSession: toGateSession(latestSessions[0] ?? null),
    latestHandoff: handoffDocument
      ? {
          artifact: {
            sessionId: handoffDocument.artifact.sessionId,
            nextCommand: handoffDocument.artifact.nextCommand,
            openBlockers: handoffDocument.artifact.openBlockers,
          },
          recommendedNextCommand: handoffDocument.recommendedNextCommand,
        }
      : latestHandoff
        ? {
            artifact: {
              sessionId: latestHandoff.sessionId,
              nextCommand: latestHandoff.nextCommand,
              openBlockers: latestHandoff.openBlockers,
            },
            recommendedNextCommand: latestHandoff.nextCommand,
          }
        : null,
  });

  if (format === 'json') {
    jsonOutput(result);
    if (options.strict && result.status === 'warn') {
      process.exitCode = 1;
    }
    return;
  }

  process.stdout.write(`${formatGateResult(result)}\n`);
  if (options.strict && result.status === 'warn') {
    process.exitCode = 1;
  }
}
