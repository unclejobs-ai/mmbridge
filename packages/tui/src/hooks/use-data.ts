import { defaultRegistry } from '@mmbridge/adapters';
import {
  commandExists,
  evaluateGate,
  getDefaultBaseRef,
  getGitStatusSummary,
  getHead,
  recommendResumeAction,
  runCommand,
  shortDigest,
} from '@mmbridge/core';
import type { GateResult, ResumeResult } from '@mmbridge/core';
import { ProjectMemoryStore, RunStore, SessionStore } from '@mmbridge/session-store';
import { useCallback, useEffect, useRef } from 'react';
import type {
  AdapterStatus,
  FindingItem,
  LatestHandoffPreview,
  MemoryPreviewItem,
  OperationsState,
  ProjectInfo,
  TuiAction,
} from '../store.js';

export interface LoadedTuiData {
  adapters: AdapterStatus[];
  sessions: Awaited<ReturnType<SessionStore['list']>>;
  projectInfo: ProjectInfo | null;
  latestHandoff: LatestHandoffPreview | null;
  memoryPreview: MemoryPreviewItem[];
  operations: OperationsState;
}

export async function loadTuiData(projectDir = process.cwd()): Promise<LoadedTuiData> {
  const store = new SessionStore();
  const memoryStore = new ProjectMemoryStore(store.baseDir);
  const runStore = new RunStore(store.baseDir);
  const registeredNames = defaultRegistry.list();

  const [allSessions, binaryChecks, gitResult, latestHandoff, memoryPreview] = await Promise.all([
    store.list({ projectDir }).catch(() => []),
    Promise.all(
      registeredNames.map(async (toolName) => {
        const adapter = defaultRegistry.get(toolName);
        const binary = adapter?.binary ?? toolName;
        const installed = await commandExists(binary).catch(() => false);
        return { toolName, binary, installed };
      }),
    ),
    Promise.all([
      getHead(),
      getDefaultBaseRef(),
      getGitStatusSummary(),
      runCommand('git', ['log', '-1', '--format=%s'])
        .then((r) => (r.ok ? r.stdout.trim() : null))
        .catch(() => null),
    ]).catch(() => null),
    memoryStore.getLatestHandoff(projectDir).catch(() => null),
    memoryStore.searchMemory({ projectDir, query: '', limit: 4 }).catch(() => []),
  ]);

  const adapters: AdapterStatus[] = binaryChecks.map(({ toolName, binary, installed }) => ({
    name: toolName,
    binary,
    installed,
  }));

  const projectInfo: ProjectInfo | null = gitResult
    ? {
        path: projectDir,
        branch: gitResult[0].branch,
        head: gitResult[0].sha,
        dirtyCount: gitResult[2].staged + gitResult[2].unstaged + gitResult[2].untracked,
        baseRef: gitResult[1],
        lastCommitMessage: gitResult[3] ?? undefined,
      }
    : null;

  const latestHandoffPreview: LatestHandoffPreview | null = latestHandoff
    ? {
        sessionId: latestHandoff.sessionId,
        summary: latestHandoff.summary,
        nextCommand: latestHandoff.nextCommand,
        createdAt: latestHandoff.createdAt,
        path: latestHandoff.markdownPath,
      }
    : null;

  const memoryPreviewItems: MemoryPreviewItem[] = memoryPreview.map((entry) => ({
    id: entry.id,
    type: entry.type,
    title: entry.title,
    createdAt: entry.createdAt,
  }));

  const operations = await loadOperationsState({
    allSessions,
    gitResult,
    projectDir,
    runStore,
    memoryStore,
  });

  return {
    adapters,
    sessions: allSessions,
    projectInfo,
    latestHandoff: latestHandoffPreview,
    memoryPreview: memoryPreviewItems,
    operations,
  };
}

async function loadOperationsState(input: {
  allSessions: Awaited<ReturnType<SessionStore['list']>>;
  gitResult:
    | [Awaited<ReturnType<typeof getHead>>, string, Awaited<ReturnType<typeof getGitStatusSummary>>, string | null]
    | null;
  projectDir: string;
  runStore: RunStore;
  memoryStore: ProjectMemoryStore;
}): Promise<OperationsState> {
  const latestSession = input.allSessions[0] ?? null;
  if (!latestSession) {
    return { gateResult: null, resumeResult: null };
  }

  const sourceSession =
    latestSession.mode === 'followup' && latestSession.parentSessionId
      ? (input.allSessions.find((session) => session.id === latestSession.parentSessionId) ?? latestSession)
      : latestSession;
  const effectiveMode =
    sourceSession.mode === 'security' || sourceSession.mode === 'architecture' ? sourceSession.mode : 'review';
  const latestRun =
    latestSession.runId != null
      ? await input.runStore.get(latestSession.runId).catch(() => null)
      : await input.runStore.getLatest({ projectDir: input.projectDir, mode: effectiveMode }).catch(() => null);
  const handoffDoc = await input.memoryStore.getHandoffBySession(input.projectDir, latestSession.id).catch(() => null);
  const baseRef = latestRun?.baseRef ?? sourceSession.baseRef ?? input.gitResult?.[1] ?? null;
  let diffDigest = latestRun?.diffDigest ?? latestSession.diffDigest ?? null;
  let changedFilesCount = latestRun?.changedFiles ?? latestSession.contextIndex?.changedFiles ?? 0;

  if (!baseRef) {
    return { gateResult: null, resumeResult: null };
  }

  let diffText = '';
  let changedFiles: string[] = [];
  try {
    [diffText, changedFiles] = await Promise.all([
      runCommand('git', ['diff', baseRef, 'HEAD']).then((result) => (result.ok ? result.stdout : '')),
      runCommand('git', ['diff', '--name-only', baseRef, 'HEAD']).then((result) =>
        result.ok
          ? result.stdout
              .split('\n')
              .map((line) => line.trim())
              .filter(Boolean)
          : [],
      ),
    ]);
  } catch {
    diffText = '';
    changedFiles = [];
  }

  diffDigest = shortDigest(diffText);
  changedFilesCount = changedFiles.length;
  const gateResult: GateResult = evaluateGate({
    current: {
      projectDir: input.projectDir,
      mode: effectiveMode,
      baseRef,
      diffDigest,
      changedFilesCount,
      explicitMode: false,
    },
    latestRun,
    latestSession: {
      id: latestSession.id,
      tool: latestSession.tool,
      mode: latestSession.mode,
      externalSessionId: latestSession.externalSessionId ?? null,
      followupSupported: latestSession.followupSupported ?? false,
      findings: latestSession.findings ?? [],
      findingDecisions: latestSession.findingDecisions ?? [],
    },
    latestHandoff: handoffDoc
      ? {
          artifact: {
            sessionId: handoffDoc.artifact.sessionId,
            nextCommand: handoffDoc.artifact.nextCommand,
            openBlockers: handoffDoc.artifact.openBlockers,
          },
          recommendedNextCommand: handoffDoc.recommendedNextCommand,
        }
      : null,
  });
  const resumeResult: ResumeResult = recommendResumeAction({
    latestRun,
    latestSession: {
      id: latestSession.id,
      tool: latestSession.tool,
      mode: latestSession.mode,
      projectDir: input.projectDir,
      externalSessionId: latestSession.externalSessionId ?? null,
      followupSupported: latestSession.followupSupported ?? false,
      findings: latestSession.findings ?? [],
      summary: latestSession.summary,
    },
    latestHandoff: handoffDoc
      ? {
          artifact: {
            sessionId: handoffDoc.artifact.sessionId,
            nextCommand: handoffDoc.artifact.nextCommand,
            openBlockers: handoffDoc.artifact.openBlockers,
          },
          recommendedNextCommand: handoffDoc.recommendedNextCommand,
        }
      : null,
    gateResult,
  });

  return {
    gateResult,
    resumeResult,
  };
}

export function applyTuiData(dispatch: React.Dispatch<TuiAction>, data: LoadedTuiData): void {
  dispatch({ type: 'SET_ADAPTERS', adapters: data.adapters });
  dispatch({ type: 'SET_SESSIONS', sessions: data.sessions });
  dispatch({ type: 'SET_PROJECT_INFO', info: data.projectInfo });
  dispatch({ type: 'SET_LATEST_HANDOFF', handoff: data.latestHandoff });
  dispatch({ type: 'SET_MEMORY_PREVIEW', items: data.memoryPreview });
  dispatch({ type: 'SET_OPERATIONS', operations: data.operations });
}

export function useLoadData(dispatch: React.Dispatch<TuiAction>): { refresh: () => void } {
  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      requestIdRef.current += 1;
    };
  }, []);

  const load = useCallback(async () => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    dispatch({ type: 'SET_ADAPTERS_LOADING', loading: true });
    dispatch({ type: 'SET_SESSIONS_LOADING', loading: true });
    const data = await loadTuiData();
    if (!mountedRef.current || requestId !== requestIdRef.current) {
      return;
    }
    applyTuiData(dispatch, data);
  }, [dispatch]);

  useEffect(() => {
    load();
  }, [load]);

  return { refresh: load };
}

export function sessionToFindings(session: {
  findings?: Array<{ severity: string; file: string; line: number | null; message: string }>;
  findingDecisions?: Array<{ key: string; status: 'accepted' | 'dismissed' }>;
}): FindingItem[] {
  const decisions = new Map((session.findingDecisions ?? []).map((decision) => [decision.key, decision.status]));
  return (session.findings ?? []).map((f) => ({
    severity: f.severity,
    file: f.file,
    line: f.line,
    message: f.message,
    key: findingKey(f),
    status: decisions.get(findingKey(f)),
  }));
}

export function findingKey(finding: {
  severity: string;
  file: string;
  line: number | null;
  message: string;
}): string {
  return `${finding.severity.toUpperCase()}:${finding.file}:${finding.line ?? ''}:${finding.message}`;
}
