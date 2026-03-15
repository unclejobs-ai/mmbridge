import { defaultRegistry } from '@mmbridge/adapters';
import { commandExists, getDefaultBaseRef, getGitStatusSummary, getHead, runCommand } from '@mmbridge/core';
import { SessionStore } from '@mmbridge/session-store';
import { useCallback, useEffect } from 'react';
import type { AdapterStatus, FindingItem, LastReview, ProjectInfo, TuiAction } from '../store.js';
import { countBySeverity } from '../utils/format.js';

export function useLoadData(dispatch: React.Dispatch<TuiAction>): { refresh: () => void } {
  const load = useCallback(async () => {
    dispatch({ type: 'SET_ADAPTERS_LOADING', loading: true });
    dispatch({ type: 'SET_SESSIONS_LOADING', loading: true });

    const store = new SessionStore();
    const registeredNames = defaultRegistry.list();

    // Fire all independent I/O in parallel: sessions, binary checks, git info
    const [allSessions, binaryChecks, gitResult] = await Promise.all([
      store.list().catch(() => []),
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
        path: process.cwd(),
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
  }, [dispatch]);

  useEffect(() => {
    load();
  }, [load]);

  return { refresh: load };
}

export function sessionToFindings(session: {
  findings?: Array<{ severity: string; file: string; line: number | null; message: string }>;
}): FindingItem[] {
  return (session.findings ?? []).map((f) => ({
    severity: f.severity,
    file: f.file,
    line: f.line,
    message: f.message,
  }));
}
