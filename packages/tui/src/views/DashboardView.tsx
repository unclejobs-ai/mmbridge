import React, { useMemo, useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { colors, CHARS, toolColor } from '../theme.js';
import { FullWidthRow } from '../components/FullWidthRow.js';
import { HRuleFull } from '../components/HRuleFull.js';
import { Sparkline } from '../components/Sparkline.js';
import { SeverityBar } from '../components/SeverityBar.js';
import { KVRow } from '../components/KVRow.js';
import { EventLog } from '../components/EventLog.js';
import { LiveMonitor } from '../components/LiveMonitor.js';
import { useTui } from '../store.js';
import { useLiveState } from '../hooks/use-live-state.js';
import { computeSessionStats } from '../hooks/session-analytics.js';
import { formatRelativeTime } from '../utils/format.js';
import type { AdapterStatus } from '../store.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function shortenPath(p: string): string {
  const home = process.env['HOME'] ?? '';
  if (home && p.startsWith(home)) return '~' + p.slice(home.length);
  return p;
}

function reversedCounts(counts: number[]): number[] {
  return [...counts].reverse();
}

function avgPerDay(counts: number[]): string {
  if (counts.length === 0) return '0.0';
  const total = counts.reduce((a, b) => a + b, 0);
  return (total / counts.length).toFixed(1);
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// ─── Adapter row ──────────────────────────────────────────────────────────────

interface AdapterRowProps {
  adapter: AdapterStatus;
  toolDailyCounts: number[];
}

function AdapterRow({ adapter, toolDailyCounts }: AdapterRowProps): React.ReactElement {
  const icon = adapter.installed ? CHARS.installed : CHARS.missing;
  const iconColor = adapter.installed ? colors.green : colors.red;
  const hasActivity = toolDailyCounts.some((c) => c > 0);

  return (
    <Box flexDirection="row" gap={0}>
      <Text color={iconColor}>{icon} </Text>
      <Text color={toolColor(adapter.name)} bold>{adapter.name.padEnd(7)}</Text>
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

// ─── Idle sections ────────────────────────────────────────────────────────────

interface AdaptersSectionProps {
  adapters: AdapterStatus[];
  toolDistribution: Record<string, number>;
  sessionDailyCounts: number[];
}

function AdaptersSection({ adapters, toolDistribution, sessionDailyCounts }: AdaptersSectionProps): React.ReactElement {
  const totalToolSessions = Object.values(toolDistribution).reduce((a, b) => a + b, 0);

  return (
    <Box flexDirection="column" paddingX={1} gap={0}>
      <Text color={colors.overlay1} bold>ADAPTERS</Text>
      {adapters.map((adapter) => {
        const toolShare = toolDistribution[adapter.name] ?? 0;
        const ratio = totalToolSessions > 0 ? toolShare / totalToolSessions : 0;
        const toolDailyCounts = sessionDailyCounts.map((c) => Math.round(c * ratio));
        return (
          <AdapterRow
            key={adapter.name}
            adapter={adapter}
            toolDailyCounts={reversedCounts(toolDailyCounts)}
          />
        );
      })}
      {adapters.length === 0 && (
        <Text color={colors.textDim}>No adapters configured</Text>
      )}
    </Box>
  );
}

interface ProjectSectionProps {
  projectInfo: import('../store.js').ProjectInfo | null;
}

function ProjectSection({ projectInfo }: ProjectSectionProps): React.ReactElement {
  return (
    <Box flexDirection="column" paddingX={1} gap={0}>
      <Text color={colors.overlay1} bold>PROJECT</Text>
      {projectInfo ? (
        <>
          <KVRow label="path" value={shortenPath(projectInfo.path)} labelWidth={8} />
          <KVRow label="branch" value={`${projectInfo.branch} (${projectInfo.head.slice(0, 7)})`} labelWidth={8} />
          <KVRow
            label="dirty"
            value={`${projectInfo.dirtyCount} files`}
            labelWidth={8}
            valueColor={projectInfo.dirtyCount > 0 ? colors.yellow : colors.green}
          />
          <KVRow label="base" value={projectInfo.baseRef} labelWidth={8} />
          {projectInfo.lastCommitMessage && (
            <KVRow label="commit" value={truncate(projectInfo.lastCommitMessage, 40)} labelWidth={8} valueColor={colors.overlay1} />
          )}
        </>
      ) : (
        <Text color={colors.textDim}>Not a git repository</Text>
      )}
    </Box>
  );
}

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
      <Text color={colors.overlay1} bold>ACTIVITY 7d</Text>
      <Box flexDirection="row" gap={2}>
        <Sparkline data={reversed} color={colors.accent} width={7} />
        <Text color={colors.textMuted}>avg {avg}/d · {weekTotal} total</Text>
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

interface LastReviewSectionProps {
  lastReview: import('../store.js').LastReview | null;
}

function LastReviewSection({ lastReview }: LastReviewSectionProps): React.ReactElement {
  return (
    <Box flexDirection="column" paddingX={1} gap={0}>
      <Text color={colors.overlay1} bold>LAST REVIEW</Text>
      {lastReview ? (
        <>
          <Box flexDirection="row" gap={1}>
            <Text color={toolColor(lastReview.tool)} bold>{lastReview.tool}</Text>
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
        <Text color={colors.green}><Spinner type="dots" /></Text>
        <Text color={colors.textMuted}> Loading adapter status...</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width="100%" flexGrow={1}>
      {/* Row 1: Adapters + Project */}
      <FullWidthRow leftRatio={0.5}>
        {[
          <AdaptersSection
            key="adapters"
            adapters={adapters}
            toolDistribution={stats.toolDistribution}
            sessionDailyCounts={stats.dailyCounts}
          />,
          <ProjectSection key="project" projectInfo={projectInfo} />,
        ]}
      </FullWidthRow>

      <HRuleFull />

      {/* Row 2: Activity + Last Review (idle) or Live Monitor (active) */}
      {liveState ? (
        <LiveMonitor liveState={liveState} frameIdx={frameIdx} />
      ) : (
        <FullWidthRow leftRatio={0.5}>
          {[
            <ActivitySection
              key="activity"
              dailyCounts={stats.dailyCounts}
              aggregateSeverity={stats.aggregateSeverity}
              totalSessions={sessions.length}
            />,
            <LastReviewSection key="last-review" lastReview={lastReview} />,
          ]}
        </FullWidthRow>
      )}

      <HRuleFull />

      {/* Events */}
      <Box flexDirection="column" paddingX={1}>
        <Text color={colors.overlay1} bold>EVENTS</Text>
        <EventLog liveState={liveState} />
      </Box>
    </Box>
  );
}
