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
import { ProjectMemoryStore, RunStore, SessionStore } from '@mmbridge/session-store';
import { useCallback, useEffect } from 'react';
import type { AdapterStatus, FindingItem, LastReview, ProjectInfo, TuiAction } from '../store.js';
import { countBySeverity } from '../utils/format.js';

export function useLoadData(dispatch: React.Dispatch<TuiAction>): { refresh: () => void } {
  const load = useCallback(async () => {
    dispatch({ type: 'SET_ADAPTERS_LOADING', loading: true });
    dispatch({ type: 'SET_SESSIONS_LOADING', loading: true });

    const store = new SessionStore();
    const memoryStore = new ProjectMemoryStore(store.baseDir);
    const runStore = new RunStore(store.baseDir);
    const projectDir = process.cwd();
    const registeredNames = defaultRegistry.list();

    // Fire all independent I/O in parallel: sessions, binary checks, git info
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

    // Group sessions by tool in a single pass
    const sessionsByTool = new Map<string, typeof allSessions>();
    for (const s of allSessions) {
      const bucket = sessionsByTool.get(s.tool) ?? [];
      bucket.push(s);
      sessionsByTool.set(s.tool, bucket);
    }

    const adapterStatuses: AdapterStatus[] = binaryChecks.map(({ toolName, binary, installed }) => {
      const toolSessions = sessionsByTool.get(toolName) ?? [];
      return {
        name: toolName,
        binary,
        installed,
        sessionCount: toolSessions.length,
        lastSessionDate: toolSessions[0]?.createdAt ?? null,
      };
    });

    dispatch({ type: 'SET_ADAPTERS', adapters: adapterStatuses });
    // SET_SESSIONS auto-computes sessionStats in the reducer
    dispatch({ type: 'SET_SESSIONS', sessions: allSessions });

    // Set project info from parallel git result
    if (gitResult) {
      const [head, baseRef, gitStatus, lastCommitMsg] = gitResult;
      const dirtyCount = gitStatus.staged + gitStatus.unstaged + gitStatus.untracked;
      const projectInfo: ProjectInfo = {
        path: projectDir,
        branch: head.branch,
        head: head.sha,
        dirtyCount,
        baseRef,
        lastCommitMessage: lastCommitMsg ?? undefined,
      };
      dispatch({ type: 'SET_PROJECT_INFO', info: projectInfo });
    } else {
      dispatch({ type: 'SET_PROJECT_INFO', info: null });
    }

    // Load last review
    const last = allSessions.at(0);
    if (last !== undefined) {
      const findings = last.findings ?? [];
      const lastReview: LastReview = {
        tool: last.tool,
        mode: last.mode,
        date: last.createdAt,
        findingCounts: countBySeverity(findings),
        summary: last.summary ?? 'No summary available',
      };
      dispatch({ type: 'SET_LAST_REVIEW', review: lastReview });
    } else {
      dispatch({ type: 'SET_LAST_REVIEW', review: null });
    }

    dispatch({
      type: 'SET_LATEST_HANDOFF',
      handoff: latestHandoff
        ? {
            sessionId: latestHandoff.sessionId,
            summary: latestHandoff.summary,
            nextCommand: latestHandoff.nextCommand,
            createdAt: latestHandoff.createdAt,
            path: latestHandoff.markdownPath,
          }
        : null,
    });
    dispatch({
      type: 'SET_MEMORY_PREVIEW',
      items: memoryPreview.map((entry) => ({
        id: entry.id,
        type: entry.type,
        title: entry.title,
        createdAt: entry.createdAt,
      })),
    });

    const latestSession = allSessions[0] ?? null;
    if (latestSession) {
      const sourceSession =
        latestSession.mode === 'followup' && latestSession.parentSessionId
          ? (allSessions.find((session) => session.id === latestSession.parentSessionId) ?? latestSession)
          : latestSession;
      const effectiveMode =
        sourceSession.mode === 'security' || sourceSession.mode === 'architecture' ? sourceSession.mode : 'review';
      const latestRun =
        latestSession.runId != null
          ? await runStore.get(latestSession.runId).catch(() => null)
          : await runStore.getLatest({ projectDir, mode: effectiveMode }).catch(() => null);
      const handoffDoc = await memoryStore.getHandoffBySession(projectDir, latestSession.id).catch(() => null);
      const baseRef = latestRun?.baseRef ?? sourceSession.baseRef ?? gitResult?.[1] ?? null;
      let diffDigest = latestRun?.diffDigest ?? latestSession.diffDigest ?? null;
      let changedFilesCount = latestRun?.changedFiles ?? latestSession.contextIndex?.changedFiles ?? 0;

      if (baseRef) {
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
        const gateResult = evaluateGate({
          current: {
            projectDir,
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
        const resumeResult = recommendResumeAction({
          latestRun,
          latestSession: {
            id: latestSession.id,
            tool: latestSession.tool,
            mode: latestSession.mode,
            projectDir,
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

        dispatch({
          type: 'SET_GATE_PREVIEW',
          gate: {
            status: gateResult.status,
            warnings: gateResult.warnings.map((warning) => warning.code),
            nextCommand: gateResult.warnings[0]?.nextCommand ?? null,
          },
        });
        dispatch({
          type: 'SET_RESUME_PREVIEW',
          resume: {
            action: resumeResult.recommended?.action ?? null,
            reason: resumeResult.recommended?.reason ?? null,
            summary: resumeResult.summary,
          },
        });
      } else {
        dispatch({ type: 'SET_GATE_PREVIEW', gate: null });
        dispatch({ type: 'SET_RESUME_PREVIEW', resume: null });
      }
    } else {
      dispatch({ type: 'SET_GATE_PREVIEW', gate: null });
      dispatch({ type: 'SET_RESUME_PREVIEW', resume: null });
    }
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
