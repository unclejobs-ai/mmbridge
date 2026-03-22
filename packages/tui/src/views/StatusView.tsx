import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type React from 'react';
import { useMemo } from 'react';
import { KVRow } from '../components/KVRow.js';
import { Panel } from '../components/Panel.js';
import { SeverityBar } from '../components/SeverityBar.js';
import { Sparkline } from '../components/Sparkline.js';
import {
  computeSessionStats,
  deriveAdapterActivity,
  deriveLastReview,
  getAdapterSessionInfo,
} from '../hooks/session-analytics.js';
import { useTui } from '../store.js';
import type { AdapterStatus } from '../store.js';
import { CHARS, colors, toolColor } from '../theme.js';
import { avgPerDay, formatRelativeTime, reversedCounts, shortenPath, truncate } from '../utils/format.js';

// ─── Compact adapter row ─────────────────────────────────────────────────────

interface AdapterRowProps {
  adapter: AdapterStatus & { sessionCount: number; lastSessionDate: string | null };
  toolDailyCounts: number[];
}

function AdapterRow({ adapter, toolDailyCounts }: AdapterRowProps): React.ReactElement {
  const icon = adapter.installed ? CHARS.installed : CHARS.missing;
  const iconColor = adapter.installed ? colors.green : colors.red;
  const hasActivity = toolDailyCounts.some((c) => c > 0);

  return (
    <Box flexDirection="row" gap={0}>
      <Text color={iconColor}>{icon} </Text>
      <Text color={toolColor(adapter.name)} bold>
        {adapter.name.padEnd(7)}
      </Text>
      <Text color={colors.textDim}>{String(adapter.sessionCount).padStart(3)}</Text>
      <Text color={colors.textDim}> </Text>
      {adapter.installed && hasActivity ? (
        <Sparkline data={toolDailyCounts} color={toolColor(adapter.name)} width={5} />
      ) : (
        <Text color={colors.textDim}>{'─────'}</Text>
      )}
      <Text color={colors.textDim}> </Text>
      <Text color={colors.overlay0}>
        {adapter.lastSessionDate ? formatRelativeTime(adapter.lastSessionDate) : '     -'}
      </Text>
    </Box>
  );
}

// ─── Panels ───────────────────────────────────────────────────────────────────

interface AdaptersPanelProps {
  adapters: Array<AdapterStatus & { sessionCount: number; lastSessionDate: string | null }>;
  toolDistribution: Record<string, number>;
  sessionDailyCounts: number[];
  totalSessions: number;
}

function AdaptersPanel({
  adapters,
  toolDistribution,
  sessionDailyCounts,
  totalSessions,
}: AdaptersPanelProps): React.ReactElement {
  const totalToolSessions = Object.values(toolDistribution).reduce((a, b) => a + b, 0);
  const installedCount = adapters.filter((a) => a.installed).length;

  return (
    <Panel title={`ADAPTERS (${installedCount}/${adapters.length})`} flexGrow={1}>
      <Box flexDirection="column" marginTop={1} gap={0}>
        {adapters.map((adapter) => {
          const toolShare = toolDistribution[adapter.name] ?? 0;
          const ratio = totalToolSessions > 0 ? toolShare / totalToolSessions : 0;
          const toolDailyCounts = sessionDailyCounts.map((c) => Math.round(c * ratio));

          return <AdapterRow key={adapter.name} adapter={adapter} toolDailyCounts={reversedCounts(toolDailyCounts)} />;
        })}
        {adapters.length === 0 && <Text color={colors.textDim}>No adapters configured</Text>}
      </Box>
    </Panel>
  );
}

interface ProjectPanelProps {
  projectInfo: import('../store.js').ProjectInfo | null;
}

function ProjectPanel({ projectInfo }: ProjectPanelProps): React.ReactElement {
  return (
    <Panel title="PROJECT" flexGrow={1}>
      <Box flexDirection="column" marginTop={1}>
        {projectInfo ? (
          <>
            <KVRow label="Path" value={shortenPath(projectInfo.path)} />
            <KVRow label="Branch" value={`${projectInfo.branch} (${projectInfo.head.slice(0, 7)})`} />
            <KVRow
              label="Dirty"
              value={`${projectInfo.dirtyCount} files`}
              valueColor={projectInfo.dirtyCount > 0 ? colors.yellow : colors.green}
            />
            <KVRow label="Base" value={projectInfo.baseRef} />
            {projectInfo.lastCommitMessage && (
              <KVRow label="Last" value={truncate(projectInfo.lastCommitMessage, 40)} valueColor={colors.overlay1} />
            )}
          </>
        ) : (
          <Text color={colors.textDim}>Not a git repository</Text>
        )}
      </Box>
    </Panel>
  );
}

interface ActivityPanelProps {
  dailyCounts: number[];
  aggregateSeverity: { critical: number; warning: number; info: number; refactor: number };
  totalSessions: number;
}

function ActivityPanel({ dailyCounts, aggregateSeverity, totalSessions }: ActivityPanelProps): React.ReactElement {
  const reversed = reversedCounts(dailyCounts);
  const avg = avgPerDay(dailyCounts);
  const weekTotal = dailyCounts.reduce((a, b) => a + b, 0);

  return (
    <Panel title="ACTIVITY (7 days)" flexGrow={1}>
      <Box flexDirection="column" marginTop={1} gap={1}>
        <Box flexDirection="row" gap={2}>
          <Sparkline data={reversed} color={colors.accent} width={7} />
          <Text color={colors.textMuted}>avg {avg}/day</Text>
          <Text color={colors.textDim}>
            ({weekTotal}w / {totalSessions} total)
          </Text>
        </Box>
        {weekTotal > 0 ? (
          <SeverityBar counts={aggregateSeverity} />
        ) : (
          <Text color={colors.textDim}>No sessions in last 7 days</Text>
        )}
      </Box>
    </Panel>
  );
}

interface LastReviewPanelProps {
  lastReview: import('../store.js').LastReview | null;
}

function LastReviewPanel({ lastReview }: LastReviewPanelProps): React.ReactElement {
  return (
    <Panel title="LAST REVIEW" flexGrow={1}>
      <Box flexDirection="column" marginTop={1}>
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
            <Box marginTop={1}>
              <SeverityBar counts={lastReview.findingCounts} />
            </Box>
            <Box marginTop={1}>
              <Text color={colors.textDim}>{truncate(lastReview.summary, 60)}</Text>
            </Box>
          </>
        ) : (
          <Text color={colors.textDim}>No reviews yet</Text>
        )}
      </Box>
    </Panel>
  );
}

// ─── Main View ────────────────────────────────────────────────────────────────

export function StatusView(): React.ReactElement {
  const [state] = useTui();
  const { adapters, adaptersLoading, projectInfo, sessions } = state;

  const stats = useMemo(() => computeSessionStats(sessions), [sessions]);
  const adapterActivity = useMemo(() => deriveAdapterActivity(sessions), [sessions]);
  const adaptersWithActivity = useMemo(
    () => getAdapterSessionInfo(adapters, adapterActivity),
    [adapters, adapterActivity],
  );
  const lastReview = useMemo(() => deriveLastReview(sessions), [sessions]);

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
    <Box flexDirection="column" width="100%" flexGrow={1} paddingX={1} gap={1}>
      {/* Row 1: Adapters + Project */}
      <Box flexDirection="row" gap={1}>
        <AdaptersPanel
          adapters={adaptersWithActivity}
          toolDistribution={stats.toolDistribution}
          sessionDailyCounts={stats.dailyCounts}
          totalSessions={sessions.length}
        />
        <ProjectPanel projectInfo={projectInfo} />
      </Box>

      {/* Row 2: Activity + Last Review */}
      <Box flexDirection="row" gap={1}>
        <ActivityPanel
          dailyCounts={stats.dailyCounts}
          aggregateSeverity={stats.aggregateSeverity}
          totalSessions={sessions.length}
        />
        <LastReviewPanel lastReview={lastReview} />
      </Box>
    </Box>
  );
}
