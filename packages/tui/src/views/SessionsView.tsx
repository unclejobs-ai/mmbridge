import { SessionStore } from '@mmbridge/session-store';
import type { Session } from '@mmbridge/session-store';
import { Box, Text, useInput, useStdout } from 'ink';
import React, { useCallback, useMemo } from 'react';
import { FindingsPreview } from '../components/FindingsPreview.js';
import { HRuleFull } from '../components/HRuleFull.js';
import { KVRow } from '../components/KVRow.js';
import { PromptInput } from '../components/PromptInput.js';
import { ConsensusSnapshot, ReviewFlowMap, buildSessionReviewFlow } from '../components/ReviewFlowMap.js';
import { SeverityBar } from '../components/SeverityBar.js';
import { Sparkline } from '../components/Sparkline.js';
import {
  buildAncestryChain,
  computeSessionStats,
  parseContextIndex,
  parseResultIndex,
} from '../hooks/session-analytics.js';
import { sessionToFindings } from '../hooks/use-data.js';
import { useExportReport } from '../hooks/use-export.js';
import { useFollowup } from '../hooks/use-followup.js';
import { useTui } from '../store.js';
import { CHARS, colors, toolColor } from '../theme.js';
import { countBySeverity, formatRelativeTime } from '../utils/format.js';

const SEVERITY_FILTERS = ['all', 'CRITICAL', 'WARNING', 'INFO', 'REFACTOR'] as const;
const MODE_FILTERS = ['all', 'review', 'security', 'architecture', 'followup'] as const;

// ─── SessionRow ───────────────────────────────────────────────────────────────

interface SessionRowProps {
  session: Session;
  isSelected: boolean;
  isFollowup: boolean;
}

function sessionRowPrefix(isSelected: boolean, isFollowup: boolean): { text: string; color: string } {
  if (isSelected) return { text: `${CHARS.selected} `, color: colors.green };
  if (isFollowup) return { text: `${CHARS.followup} `, color: colors.accent };
  return { text: '  ', color: colors.overlay0 };
}

function SessionRow({ session, isSelected, isFollowup }: SessionRowProps): React.ReactElement {
  const findingCount = (session.findings ?? []).length;
  const prefix = sessionRowPrefix(isSelected, isFollowup);
  const when = formatRelativeTime(session.createdAt).padEnd(8);

  return (
    <Box flexDirection="row">
      <Text color={prefix.color}>{prefix.text}</Text>
      <Text color={isSelected ? colors.text : colors.overlay1}>{when}</Text>
      <Text> </Text>
      <Text color={toolColor(session.tool)}>{session.tool.padEnd(7)}</Text>
      <Text> </Text>
      <Text color={findingCount > 0 ? colors.yellow : colors.textDim}>{String(findingCount).padStart(2)}</Text>
    </Box>
  );
}

function shortenText(value: string, max = 52): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

// ─── DetailPanel ──────────────────────────────────────────────────────────────

interface DetailPanelProps {
  session: Session;
  allSessions: Session[];
}

function DetailPanel({ session, allSessions }: DetailPanelProps): React.ReactElement {
  const findings = sessionToFindings(session);
  const sevCounts = countBySeverity(findings);
  const acceptedCount = findings.filter((finding) => finding.status === 'accepted').length;
  const dismissedCount = findings.filter((finding) => finding.status === 'dismissed').length;
  const openCount = findings.length - acceptedCount - dismissedCount;
  const contextIndex = parseContextIndex(session.contextIndex);
  const resultIndex = parseResultIndex(session.resultIndex);
  const ancestryChain = buildAncestryChain(allSessions, session.id);

  const shortId = session.id.slice(0, 8);

  // Category breakdown from contextIndex
  const categories = contextIndex?.categoryCounts
    ? Object.entries(contextIndex.categoryCounts)
        .filter(([, count]) => count > 0)
        .sort(([, a], [, b]) => b - a)
    : null;

  // Top files from resultIndex
  const topFiles = resultIndex?.topFiles?.slice(0, 3) ?? null;
  const toolResults = Array.isArray(session.toolResults) ? session.toolResults : [];
  const interpretation = session.interpretation ?? null;
  const actionPlan = interpretation?.actionPlan?.split('\n')[0]?.trim() ?? null;
  const flow = buildSessionReviewFlow({
    tool: session.tool,
    mode: session.mode,
    status: session.status,
    findings: session.findings ?? [],
    toolResults,
    resultIndex,
    interpretation,
    changedFiles: contextIndex?.changedFiles ?? null,
    ancestryChain,
  });

  return (
    <Box flexDirection="column" gap={1}>
      <ReviewFlowMap {...flow} />

      {/* Header: ID + tool / mode */}
      <Box flexDirection="row" gap={1}>
        <Text color={colors.textDim}>#{shortId}</Text>
        <Text color={toolColor(session.tool)} bold>
          {session.tool}
        </Text>
        <Text color={colors.textDim}>/</Text>
        <Text color={colors.subtext1}>{session.mode}</Text>
      </Box>

      {/* Time | files | findings */}
      <Box flexDirection="row" gap={0}>
        <Text color={colors.overlay1}>{formatRelativeTime(session.createdAt)}</Text>
        {resultIndex != null && (
          <>
            <Text color={colors.textDim}>{' │ '}</Text>
            <Text color={colors.subtext0}>{resultIndex.filesTouched} files</Text>
          </>
        )}
        <Text color={colors.textDim}>{' │ '}</Text>
        <Text color={findings.length > 0 ? colors.yellow : colors.textDim}>{findings.length} finds</Text>
      </Box>

      {/* Severity bar */}
      <SeverityBar counts={sevCounts} />

      {/* Category breakdown */}
      {categories != null && categories.length > 0 && (
        <Box flexDirection="column">
          <Text color={colors.textDim} bold>
            Files
          </Text>
          <Box flexDirection="row" flexWrap="wrap" gap={1}>
            {categories.slice(0, 4).map(([cat, count]) => (
              <Text key={cat} color={colors.subtext0}>
                {cat}({count})
              </Text>
            ))}
          </Box>
        </Box>
      )}

      {/* Top files */}
      {topFiles != null && topFiles.length > 0 && (
        <Box flexDirection="column">
          <Text color={colors.textDim} bold>
            Top
          </Text>
          <Box flexDirection="row" flexWrap="wrap" gap={1}>
            {topFiles.map((f) => (
              <Text key={f.file} color={colors.overlay2}>
                {f.file.split('/').pop()}({f.count})
              </Text>
            ))}
          </Box>
        </Box>
      )}

      {/* Ancestry chain */}
      {ancestryChain.length > 1 && (
        <Box flexDirection="row" flexWrap="wrap" gap={0}>
          <Text color={colors.textDim} bold>
            Chain{' '}
          </Text>
          {ancestryChain.map((id, idx) => {
            const isCurrent = id === session.id;
            const label = id.slice(0, 6);
            return (
              <React.Fragment key={id}>
                {idx > 0 && <Text color={colors.textDim}>{' → '}</Text>}
                <Text color={isCurrent ? colors.accent : colors.overlay1} bold={isCurrent}>
                  #{label}
                  {isCurrent ? ' (cur)' : ''}
                </Text>
              </React.Fragment>
            );
          })}
        </Box>
      )}

      {/* Base ref */}
      {session.baseRef != null && <KVRow label="Base" value={session.baseRef} labelWidth={6} />}

      {session.parentSessionId != null && (
        <KVRow label="Parent" value={`#${session.parentSessionId.slice(0, 8)}`} labelWidth={6} />
      )}

      {/* Status */}
      <KVRow
        label="Status"
        value={session.status ?? 'complete'}
        labelWidth={6}
        valueColor={session.status === 'error' ? colors.red : colors.green}
      />

      {session.runId != null && <KVRow label="Run" value={`#${session.runId.slice(0, 8)}`} labelWidth={6} />}

      {session.resumeAction != null && <KVRow label="Resume" value={session.resumeAction} labelWidth={6} />}

      {session.resumeSourceSessionId != null && (
        <KVRow label="Source" value={`#${session.resumeSourceSessionId.slice(0, 8)}`} labelWidth={6} />
      )}

      {findings.length > 0 && (
        <Box flexDirection="column">
          <Text color={colors.textDim} bold>
            Triage
          </Text>
          <KVRow label="open" value={String(openCount)} labelWidth={10} />
          <KVRow
            label="accepted"
            value={String(acceptedCount)}
            valueColor={acceptedCount > 0 ? colors.green : colors.textDim}
            labelWidth={10}
          />
          <KVRow
            label="dismissed"
            value={String(dismissedCount)}
            valueColor={dismissedCount > 0 ? colors.red : colors.textDim}
            labelWidth={10}
          />
        </Box>
      )}

      {toolResults.length > 0 && (
        <Box flexDirection="column">
          <Text color={colors.textDim} bold>
            Bridge
          </Text>
          {toolResults.map((result) => {
            const statusText = result.skipped ? 'skipped' : `${result.findingCount} finds`;
            const statusColor = result.skipped ? colors.yellow : colors.green;
            return (
              <KVRow
                key={result.tool}
                label={result.tool}
                value={result.error ? `${statusText} · ${shortenText(result.error, 22)}` : statusText}
                valueColor={result.error ? colors.red : statusColor}
                labelWidth={10}
              />
            );
          })}
        </Box>
      )}

      {interpretation != null && (
        <Box flexDirection="column">
          <Text color={colors.textDim} bold>
            Interpret
          </Text>
          <KVRow label="tool" value={interpretation.interpreterTool} labelWidth={10} />
          <KVRow label="valid" value={String(interpretation.validated.length)} labelWidth={10} />
          <KVRow label="false+" value={String(interpretation.falsePositives.length)} labelWidth={10} />
          <KVRow label="promoted" value={String(interpretation.promoted.length)} labelWidth={10} />
          {actionPlan && (
            <Text color={colors.subtext1} wrap="truncate-end">
              {actionPlan}
            </Text>
          )}
        </Box>
      )}

      <ConsensusSnapshot
        findings={session.findings ?? []}
        interpretation={interpretation}
        fallbackTool={session.tool}
      />
    </Box>
  );
}

const PAGE_SIZE = 14;

function matchesSessionFilters(
  session: Session,
  filters: { query: string; toolFilter: string; severityFilter: string; modeFilter: string },
): boolean {
  if (filters.toolFilter !== 'all' && session.tool !== filters.toolFilter) return false;
  if (filters.modeFilter !== 'all' && session.mode !== filters.modeFilter) return false;
  if (
    filters.severityFilter !== 'all' &&
    !(session.findings ?? []).some((finding) => finding.severity?.toUpperCase() === filters.severityFilter)
  ) {
    return false;
  }

  const query = filters.query.trim().toLowerCase();
  if (!query) return true;

  const summaryMatch = session.summary?.toLowerCase().includes(query) ?? false;
  const findingMatch = (session.findings ?? []).some(
    (finding) => finding.message?.toLowerCase().includes(query) || finding.file?.toLowerCase().includes(query),
  );
  return summaryMatch || findingMatch;
}

// ─── SessionsView ─────────────────────────────────────────────────────────────

export function SessionsView(): React.ReactElement {
  const [state, dispatch] = useTui();
  const { sessions, sessionsLoading, sessionsUi } = state;
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const toolFilters = useMemo(() => ['all', ...new Set(sessions.map((session) => session.tool))], [sessions]);

  const filteredSessions = useMemo(
    () => sessions.filter((session) => matchesSessionFilters(session, sessionsUi)),
    [sessions, sessionsUi],
  );

  const selectedIndex = sessionsUi.selectedIndex;
  const clampedIndex = Math.min(selectedIndex, Math.max(0, filteredSessions.length - 1));
  const selected: Session | null = filteredSessions[clampedIndex] ?? null;
  const selectedFindings = selected ? sessionToFindings(selected) : [];
  const selectedFindingIndex = Math.min(sessionsUi.findingIndex, Math.max(0, selectedFindings.length - 1));
  const selectedFinding = selectedFindings[selectedFindingIndex] ?? null;

  // Activity sparkline: computed from sessions
  const stats = useMemo(() => computeSessionStats(sessions), [sessions]);
  const sparkData = useMemo(() => [...stats.dailyCounts].reverse(), [stats]);

  const doExport = useExportReport(dispatch);
  const { submit: submitFollowup, cancel: cancelFollowup } = useFollowup(dispatch);

  const handleSessionExport = useCallback(
    (session: Session) => {
      doExport(
        {
          localSessionId: session.id,
          summary: session.summary ?? '',
          findings: sessionToFindings(session),
        },
        session.id.slice(0, 8),
      );
    },
    [doExport],
  );

  const handleFindingDecision = useCallback(
    async (session: Session, status: 'accepted' | 'dismissed' | null, findingKey: string) => {
      const store = new SessionStore();
      const existingDecisions = session.findingDecisions ?? [];
      const nextDecisions =
        status == null
          ? existingDecisions.filter((decision) => decision.key !== findingKey)
          : [
              ...existingDecisions.filter((decision) => decision.key !== findingKey),
              { key: findingKey, status, updatedAt: new Date().toISOString() },
            ];

      await store.save({
        ...session,
        findingDecisions: nextDecisions,
      });

      const nextSessions = await store.list({ projectDir: process.cwd() });
      dispatch({ type: 'SET_SESSIONS', sessions: nextSessions });
      dispatch({
        type: 'SHOW_TOAST',
        message: status == null ? 'Finding triage cleared' : `Finding marked ${status}`,
        toastType: 'success',
      });
    },
    [dispatch],
  );

  useInput((input, key) => {
    if (state.inputMode !== 'none') return;
    if (
      filteredSessions.length === 0 &&
      input !== '/' &&
      input !== 't' &&
      input !== 'v' &&
      input !== 'm' &&
      input !== 'x'
    ) {
      return;
    }

    if (input === 'j' || key.downArrow) {
      dispatch({ type: 'SESSIONS_SELECT', index: Math.min(filteredSessions.length - 1, clampedIndex + 1) });
    }
    if (input === 'k' || key.upArrow) {
      dispatch({ type: 'SESSIONS_SELECT', index: Math.max(0, clampedIndex - 1) });
    }
    if (input === '/') {
      dispatch({ type: 'START_SESSION_FILTER' });
    }
    if (input === 't') {
      dispatch({ type: 'SESSIONS_CYCLE_TOOL', tools: toolFilters });
    }
    if (input === 'v') {
      dispatch({ type: 'SESSIONS_CYCLE_SEVERITY', severities: [...SEVERITY_FILTERS] });
    }
    if (input === 'm') {
      dispatch({ type: 'SESSIONS_CYCLE_MODE', modes: [...MODE_FILTERS] });
    }
    if (input === 'x') {
      dispatch({ type: 'SESSIONS_CLEAR_FILTERS' });
    }
    if (input === '[') {
      dispatch({ type: 'SESSIONS_SELECT_FINDING', index: Math.max(0, selectedFindingIndex - 1) });
    }
    if (input === ']') {
      dispatch({
        type: 'SESSIONS_SELECT_FINDING',
        index: Math.min(Math.max(0, selectedFindings.length - 1), selectedFindingIndex + 1),
      });
    }
    if (input === 'f') {
      if (!selected) return;
      if (!selected.externalSessionId) {
        dispatch({ type: 'SHOW_TOAST', message: 'No session ID for followup', toastType: 'error' });
        return;
      }
      dispatch({
        type: 'START_FOLLOWUP',
        tool: selected.tool,
        sessionId: selected.externalSessionId,
        parentSessionId: selected.id,
      });
    }
    if (input === 'g') {
      if (!selected || !selected.externalSessionId || !selectedFinding) return;
      const location =
        selectedFinding.line != null ? `${selectedFinding.file}:${selectedFinding.line}` : selectedFinding.file;
      dispatch({
        type: 'START_FOLLOWUP',
        tool: selected.tool,
        sessionId: selected.externalSessionId,
        parentSessionId: selected.id,
        promptDraft: [
          'Re-check this finding and decide whether it is valid, a false positive, or needs narrower wording.',
          '',
          `[${selectedFinding.severity}] ${location} - ${selectedFinding.message}`,
        ].join('\n'),
      });
    }
    if (input === 'e') {
      if (!selected) return;
      handleSessionExport(selected);
    }
    if (input === 'a') {
      if (!selected || !selectedFinding) return;
      void handleFindingDecision(selected, 'accepted', selectedFinding.key);
    }
    if (input === 'z') {
      if (!selected || !selectedFinding) return;
      void handleFindingDecision(selected, 'dismissed', selectedFinding.key);
    }
    if (input === 'u') {
      if (!selected || !selectedFinding) return;
      void handleFindingDecision(selected, null, selectedFinding.key);
    }
  });

  if (sessionsLoading) {
    return (
      <Box paddingX={2} paddingY={1}>
        <Text color={colors.textMuted}>Loading sessions...</Text>
      </Box>
    );
  }

  if (sessions.length === 0) {
    return (
      <Box paddingX={2} paddingY={1}>
        <Text color={colors.textDim}>No sessions yet. Run a review first.</Text>
      </Box>
    );
  }

  const hasActiveFilters =
    sessionsUi.query.length > 0 ||
    sessionsUi.toolFilter !== 'all' ||
    sessionsUi.severityFilter !== 'all' ||
    sessionsUi.modeFilter !== 'all';

  if (filteredSessions.length === 0) {
    return (
      <Box flexDirection="column" width="100%" paddingX={2} paddingY={1} gap={1}>
        <Text color={colors.overlay1} bold>
          SESSIONS
        </Text>
        <Box flexDirection="row" gap={2} flexWrap="wrap">
          <Text color={sessionsUi.query ? colors.accent : colors.textDim}>q:{sessionsUi.query || 'all'}</Text>
          <Text color={sessionsUi.toolFilter !== 'all' ? toolColor(sessionsUi.toolFilter) : colors.textDim}>
            tool:{sessionsUi.toolFilter}
          </Text>
          <Text color={sessionsUi.severityFilter !== 'all' ? colors.yellow : colors.textDim}>
            sev:{sessionsUi.severityFilter}
          </Text>
          <Text color={sessionsUi.modeFilter !== 'all' ? colors.subtext1 : colors.textDim}>
            mode:{sessionsUi.modeFilter}
          </Text>
        </Box>
        <Text color={colors.textDim}>
          No sessions match the current filters. Use `/` to search, `t/v/m` to cycle filters, `x` to clear.
        </Text>
        {state.inputMode === 'session-filter' && (
          <PromptInput
            label="Session search"
            initialValue={sessionsUi.query}
            placeholder="message, file, summary..."
            onSubmit={(query) => {
              dispatch({ type: 'SESSIONS_SET_QUERY', query });
              dispatch({ type: 'COMPLETE_INPUT' });
            }}
            onCancel={() => dispatch({ type: 'CANCEL_INPUT' })}
          />
        )}
      </Box>
    );
  }

  const pageStart = Math.floor(clampedIndex / PAGE_SIZE) * PAGE_SIZE;
  const visibleSessions = filteredSessions.slice(pageStart, pageStart + PAGE_SIZE);

  // Column widths for 3-column layout
  const listWidth = Math.min(38, Math.floor(cols * 0.28));
  const gap = 1;
  const remaining = cols - listWidth - gap * 2;
  const detailWidth = Math.floor(remaining * 0.5);
  const findingsWidth = remaining - detailWidth;

  return (
    <Box flexDirection="column" width="100%">
      <Box flexDirection="row" paddingX={1} gap={2} flexWrap="wrap">
        <Text color={sessionsUi.query ? colors.accent : colors.textDim}>q:{sessionsUi.query || 'all'}</Text>
        <Text color={sessionsUi.toolFilter !== 'all' ? toolColor(sessionsUi.toolFilter) : colors.textDim}>
          tool:{sessionsUi.toolFilter}
        </Text>
        <Text color={sessionsUi.severityFilter !== 'all' ? colors.yellow : colors.textDim}>
          sev:{sessionsUi.severityFilter}
        </Text>
        <Text color={sessionsUi.modeFilter !== 'all' ? colors.subtext1 : colors.textDim}>
          mode:{sessionsUi.modeFilter}
        </Text>
        <Text color={hasActiveFilters ? colors.green : colors.textDim}>
          {filteredSessions.length}/{sessions.length}
        </Text>
      </Box>

      {/* Main row: list + detail + findings (3-column) */}
      <Box flexDirection="row" width="100%">
        {/* Left: Sessions list */}
        <Box flexDirection="column" width={listWidth} paddingX={1}>
          <Text color={colors.overlay1} bold>
            SESSIONS
          </Text>
          <Box flexDirection="row" gap={1} marginTop={0} marginBottom={1}>
            <Sparkline data={sparkData} color={colors.accent} width={7} />
            <Text color={colors.textDim}>{filteredSessions.length} shown</Text>
          </Box>

          <Box flexDirection="column">
            {visibleSessions.map((s, i) => {
              const isFollowup = s.externalSessionId != null || s.parentSessionId != null;
              return (
                <SessionRow
                  key={s.id}
                  session={s}
                  isSelected={pageStart + i === clampedIndex}
                  isFollowup={isFollowup}
                />
              );
            })}
          </Box>

          <Box marginTop={1}>
            <Text color={colors.textDim}>
              {pageStart + 1}-{pageStart + visibleSessions.length}/{filteredSessions.length}
            </Text>
          </Box>
        </Box>

        <Box width={gap} />

        {/* Center: Detail panel */}
        <Box flexDirection="column" width={detailWidth} paddingX={1}>
          <Text color={colors.overlay1} bold>
            DETAIL
          </Text>
          {selected != null ? (
            <Box marginTop={1}>
              <DetailPanel session={selected} allSessions={sessions} />
            </Box>
          ) : (
            <Text color={colors.textDim}>No session selected.</Text>
          )}
        </Box>

        <Box width={gap} />

        {/* Right: Findings preview */}
        <Box width={findingsWidth}>
          <FindingsPreview findings={selectedFindings} selectedIndex={selectedFindingIndex} />
        </Box>
      </Box>

      <HRuleFull />

      {/* Followup input */}
      {state.inputMode === 'followup' && state.inputTarget && (
        <PromptInput
          label={`Followup (${state.inputTarget.tool})`}
          initialValue={state.inputTarget.promptDraft}
          onSubmit={(prompt) =>
            submitFollowup(
              state.inputTarget?.tool ?? '',
              state.inputTarget?.sessionId ?? '',
              prompt,
              state.inputTarget?.parentSessionId,
            )
          }
          onCancel={cancelFollowup}
        />
      )}

      {state.inputMode === 'session-filter' && (
        <PromptInput
          label="Session search"
          initialValue={sessionsUi.query}
          placeholder="message, file, summary..."
          onSubmit={(query) => {
            dispatch({ type: 'SESSIONS_SET_QUERY', query });
            dispatch({ type: 'COMPLETE_INPUT' });
          }}
          onCancel={() => dispatch({ type: 'CANCEL_INPUT' })}
        />
      )}
    </Box>
  );
}
