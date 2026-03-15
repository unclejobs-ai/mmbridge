import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { EventLog } from '../components/EventLog.js';
import { FullWidthRow } from '../components/FullWidthRow.js';
import { HRuleFull } from '../components/HRuleFull.js';
import { LiveMonitor } from '../components/LiveMonitor.js';
import { SeverityBar } from '../components/SeverityBar.js';
import { Sparkline } from '../components/Sparkline.js';
import { computeSessionStats } from '../hooks/session-analytics.js';
import { useLiveState } from '../hooks/use-live-state.js';
import { useTui } from '../store.js';
import type { AdapterStatus } from '../store.js';
import { colors, toolColor } from '../theme.js';
import { avgPerDay, formatRelativeTime, reversedCounts, shortenPath, truncate } from '../utils/format.js';

// ─── Connection row ───────────────────────────────────────────────────────────

interface ConnectionRowProps {
  adapter: AdapterStatus;
}

function ConnectionRow({ adapter }: ConnectionRowProps): React.ReactElement {
  const isReady = adapter.installed;
  const icon = isReady ? '●' : '○';
  const iconColor = isReady ? colors.green : colors.textDim;

  const sessionInfo =
    adapter.sessionCount > 0 && adapter.lastSessionDate
      ? `${adapter.sessionCount} · ${formatRelativeTime(adapter.lastSessionDate)}`
      : null;

  return (
    <Box flexDirection="row" gap={0}>
      <Text color={iconColor}>{icon} </Text>
      <Text color={isReady ? toolColor(adapter.name) : colors.textDim} bold={isReady}>
        {adapter.name.padEnd(7)}
      </Text>
      {isReady ? (
        <>
          <Text color={colors.green}>{'ready'}</Text>
          <Text color={colors.textDim}>{'  '}</Text>
          <Text color={sessionInfo ? colors.overlay0 : colors.textDim}>{sessionInfo ?? 'no sessions'}</Text>
        </>
      ) : (
        <Text color={colors.textDim}>{'──'}</Text>
      )}
    </Box>
  );
}

// ─── Connections section ──────────────────────────────────────────────────────

interface ConnectionsSectionProps {
  adapters: AdapterStatus[];
}

function ConnectionsSection({ adapters }: ConnectionsSectionProps): React.ReactElement {
  return (
    <Box flexDirection="column" paddingX={1} gap={0}>
      <Text color={colors.overlay1} bold>
        CONNECTIONS
      </Text>
      {adapters.map((adapter) => (
        <ConnectionRow key={adapter.name} adapter={adapter} />
      ))}
      {adapters.length === 0 && <Text color={colors.textDim}>No adapters configured</Text>}
    </Box>
  );
}

// ─── Project section ──────────────────────────────────────────────────────────

interface ProjectSectionProps {
  projectInfo: import('../store.js').ProjectInfo | null;
}

function ProjectSection({ projectInfo }: ProjectSectionProps): React.ReactElement {
  return (
    <Box flexDirection="column" paddingX={1} gap={0}>
      <Text color={colors.overlay1} bold>
        PROJECT
      </Text>
      {projectInfo ? (
        <>
          <Text color={colors.subtext0}>{shortenPath(projectInfo.path)}</Text>
          <Box flexDirection="row" gap={1}>
            <Text color={colors.textMuted}>{projectInfo.branch}</Text>
            <Text color={colors.textDim}>({projectInfo.head.slice(0, 7)})</Text>
            <Text color={colors.textDim}>·</Text>
            <Text color={projectInfo.dirtyCount > 0 ? colors.yellow : colors.green}>
              {projectInfo.dirtyCount > 0 ? `${projectInfo.dirtyCount} dirty` : 'clean'}
            </Text>
          </Box>
          {projectInfo.lastCommitMessage && (
            <Text color={colors.overlay0}>{truncate(projectInfo.lastCommitMessage, 44)}</Text>
          )}
        </>
      ) : (
        <Text color={colors.textDim}>Not a git repository</Text>
      )}
    </Box>
  );
}

// ─── Last Review section ──────────────────────────────────────────────────────

interface LastReviewSectionProps {
  lastReview: import('../store.js').LastReview | null;
}

function LastReviewSection({ lastReview }: LastReviewSectionProps): React.ReactElement {
  return (
    <Box flexDirection="column" paddingX={1} gap={0}>
      <Text color={colors.overlay1} bold>
        LAST REVIEW
      </Text>
      {lastReview ? (
        <>
          <Box flexDirection="row" gap={1}>
            <Text color={toolColor(lastReview.tool)} bold>
              {lastReview.tool}
            </Text>
            <Text color={colors.textDim}>/</Text>
            <Text color={colors.textMuted}>{lastReview.mode}</Text>
            <Text color={colors.textDim}>/</Text>
            <Text color={colors.textDim}>{formatRelativeTime(lastReview.date)}</Text>
          </Box>
          <SeverityBar counts={lastReview.findingCounts} />
        </>
      ) : (
        <Text color={colors.textDim}>No reviews yet</Text>
      )}
    </Box>
  );
}

// ─── Quick Start section ──────────────────────────────────────────────────────

const QUICK_START_COMMANDS = [
  'mmbridge review --tool kimi',
  'mmbridge review --stream',
  'mmbridge review --tool all',
] as const;

function QuickStartSection(): React.ReactElement {
  return (
    <Box flexDirection="column" paddingX={1} gap={0}>
      <Text color={colors.overlay1} bold>
        QUICK START
      </Text>
      {QUICK_START_COMMANDS.map((cmd) => (
        <Box key={cmd}>
          <Text color={colors.peach}>$ </Text>
          <Text color={colors.subtext0}>{cmd}</Text>
        </Box>
      ))}
    </Box>
  );
}

// ─── Activity section ─────────────────────────────────────────────────────────

interface ActivitySectionProps {
  dailyCounts: number[];
  aggregateSeverity: { critical: number; warning: number; info: number; refactor: number };
  totalSessions: number;
}

function ActivitySection({ dailyCounts, aggregateSeverity, totalSessions }: ActivitySectionProps): React.ReactElement {
  const reversed = reversedCounts(dailyCounts);
  const avg = avgPerDay(dailyCounts);
  const weekTotal = dailyCounts.reduce((a, b) => a + b, 0);

  return (
    <Box flexDirection="column" paddingX={1} gap={0}>
      <Text color={colors.overlay1} bold>
        ACTIVITY 7d
      </Text>
      <Box flexDirection="row" gap={2}>
        <Sparkline data={reversed} color={colors.accent} width={7} />
        <Text color={colors.textMuted}>
          avg {avg}/d · {weekTotal} total
        </Text>
      </Box>
      {weekTotal > 0 ? (
        <SeverityBar counts={aggregateSeverity} />
      ) : (
        <Text color={colors.textDim}>No sessions in last 7 days</Text>
      )}
      <Text color={colors.textDim}>total {totalSessions}</Text>
    </Box>
  );
}

// ─── DashboardView ────────────────────────────────────────────────────────────

export function DashboardView(): React.ReactElement {
  const [state] = useTui();
  const { adapters, adaptersLoading, projectInfo, lastReview, sessions } = state;
  const liveState = useLiveState();

  const stats = useMemo(() => computeSessionStats(sessions), [sessions]);

  // Spinner frame for live phase icon animation
  const [frameIdx, setFrameIdx] = useState(0);
  useEffect(() => {
    if (!liveState) return;
    const id = setInterval(() => setFrameIdx((f) => f + 1), 120);
    return () => clearInterval(id);
  }, [liveState]);

  if (adaptersLoading) {
    return (
      <Box paddingX={2} paddingY={1}>
        <Text color={colors.green}>
          <Spinner type="dots" />
        </Text>
        <Text color={colors.textMuted}> Loading adapter status...</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width="100%" flexGrow={1}>
      {/* Row 1: Connections + Project */}
      <FullWidthRow leftRatio={0.5}>
        {[
          <ConnectionsSection key="connections" adapters={adapters} />,
          <ProjectSection key="project" projectInfo={projectInfo} />,
        ]}
      </FullWidthRow>

      <HRuleFull />

      {/* Row 2: Quick Start + Activity (idle) or Live Monitor (active) */}
      {liveState ? (
        <LiveMonitor liveState={liveState} frameIdx={frameIdx} />
      ) : (
        <FullWidthRow leftRatio={0.5}>
          {[
            <QuickStartSection key="quick-start" />,
            <Box key="right-column" flexDirection="column" gap={1}>
              <ActivitySection
                dailyCounts={stats.dailyCounts}
                aggregateSeverity={stats.aggregateSeverity}
                totalSessions={sessions.length}
              />
              <LastReviewSection lastReview={lastReview} />
            </Box>,
          ]}
        </FullWidthRow>
      )}

      <HRuleFull />

      {/* Events */}
      <Box flexDirection="column" paddingX={1}>
        <Text color={colors.overlay1} bold>
          EVENTS
        </Text>
        <EventLog liveState={liveState} />
      </Box>
    </Box>
  );
}
