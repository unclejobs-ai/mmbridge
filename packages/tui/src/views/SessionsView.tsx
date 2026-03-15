import type { Session } from '@mmbridge/session-store';
import { Box, Text, useInput, useStdout } from 'ink';
import React, { useCallback, useMemo } from 'react';
import { FindingsPreview } from '../components/FindingsPreview.js';
import { HRuleFull } from '../components/HRuleFull.js';
import { KVRow } from '../components/KVRow.js';
import { PromptInput } from '../components/PromptInput.js';
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
import { countBySeverity, formatCompactDate, formatRelativeTime } from '../utils/format.js';

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

  return (
    <Box flexDirection="row">
      <Text color={prefix.color}>{prefix.text}</Text>
      <Text color={isSelected ? colors.text : colors.overlay1}>{formatCompactDate(session.createdAt)}</Text>
      <Text> </Text>
      <Text color={toolColor(session.tool)}>{session.tool.padEnd(7)}</Text>
      <Text color={isSelected ? colors.subtext0 : colors.overlay0}>{session.mode.padEnd(10)}</Text>
      <Text color={findingCount > 0 ? colors.yellow : colors.textDim}>{String(findingCount)}</Text>
    </Box>
  );
}

// ─── DetailPanel ──────────────────────────────────────────────────────────────

interface DetailPanelProps {
  session: Session;
  allSessions: Session[];
}

function DetailPanel({ session, allSessions }: DetailPanelProps): React.ReactElement {
  const findings = sessionToFindings(session);
  const sevCounts = countBySeverity(findings);
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

  return (
    <Box flexDirection="column" gap={1}>
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

      {/* Status */}
      <KVRow
        label="Status"
        value={session.status ?? 'complete'}
        labelWidth={6}
        valueColor={session.status === 'error' ? colors.red : colors.green}
      />
    </Box>
  );
}

const PAGE_SIZE = 14;

// ─── SessionsView ─────────────────────────────────────────────────────────────

export function SessionsView(): React.ReactElement {
  const [state, dispatch] = useTui();
  const { sessions, sessionsLoading, sessionsUi } = state;
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;

  const selectedIndex = sessionsUi.selectedIndex;
  const clampedIndex = Math.min(selectedIndex, Math.max(0, sessions.length - 1));
  const selected: Session | null = sessions[clampedIndex] ?? null;

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

  useInput((input, key) => {
    if (sessions.length === 0) return;

    if (input === 'j' || key.downArrow) {
      dispatch({ type: 'SESSIONS_SELECT', index: Math.min(sessions.length - 1, clampedIndex + 1) });
    }
    if (input === 'k' || key.upArrow) {
      dispatch({ type: 'SESSIONS_SELECT', index: Math.max(0, clampedIndex - 1) });
    }
    if (input === 'f') {
      if (!selected) return;
      if (!selected.externalSessionId) {
        dispatch({ type: 'SHOW_TOAST', message: 'No session ID for followup', toastType: 'error' });
        return;
      }
      dispatch({ type: 'START_FOLLOWUP', tool: selected.tool, sessionId: selected.externalSessionId });
    }
    if (input === 'e') {
      if (!selected) return;
      handleSessionExport(selected);
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

  const visibleSessions = sessions.slice(0, PAGE_SIZE);
  const selectedFindings = selected ? sessionToFindings(selected) : [];

  // Column widths for 3-column layout
  const listWidth = Math.min(38, Math.floor(cols * 0.28));
  const gap = 1;
  const remaining = cols - listWidth - gap * 2;
  const detailWidth = Math.floor(remaining * 0.5);
  const findingsWidth = remaining - detailWidth;

  return (
    <Box flexDirection="column" width="100%">
      {/* Main row: list + detail + findings (3-column) */}
      <Box flexDirection="row" width="100%">
        {/* Left: Sessions list */}
        <Box flexDirection="column" width={listWidth} paddingX={1}>
          <Text color={colors.overlay1} bold>
            SESSIONS
          </Text>
          <Box flexDirection="row" gap={1} marginTop={0} marginBottom={1}>
            <Sparkline data={sparkData} color={colors.accent} width={7} />
            <Text color={colors.textDim}>{sessions.length} total</Text>
          </Box>

          <Box flexDirection="column">
            {visibleSessions.map((s, i) => {
              const isFollowup = s.externalSessionId != null || s.parentSessionId != null;
              return <SessionRow key={s.id} session={s} isSelected={i === clampedIndex} isFollowup={isFollowup} />;
            })}
          </Box>

          <Box marginTop={1}>
            <Text color={colors.textDim}>
              {visibleSessions.length}/{sessions.length}
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
          <FindingsPreview findings={selectedFindings} maxFiles={6} maxFindings={2} />
        </Box>
      </Box>

      <HRuleFull />

      {/* Followup input */}
      {state.inputMode === 'followup' && state.inputTarget && (
        <PromptInput
          label={`Followup (${state.inputTarget.tool})`}
          onSubmit={(prompt) =>
            submitFollowup(state.inputTarget?.tool ?? '', state.inputTarget?.sessionId ?? '', prompt)
          }
          onCancel={cancelFollowup}
        />
      )}
    </Box>
  );
}
