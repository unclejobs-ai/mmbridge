import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { EventLog } from '../components/EventLog.js';
import { FullWidthRow } from '../components/FullWidthRow.js';
import { HRuleFull } from '../components/HRuleFull.js';
import { LiveMonitor } from '../components/LiveMonitor.js';
import { Panel } from '../components/Panel.js';
import { ReviewFlowMap, buildSessionReviewFlow } from '../components/ReviewFlowMap.js';
import { SeverityBar } from '../components/SeverityBar.js';
import { Sparkline } from '../components/Sparkline.js';
import { computeSessionStats } from '../hooks/session-analytics.js';
import { useLiveState } from '../hooks/use-live-state.js';
import { useTui } from '../store.js';
import type { AdapterStatus } from '../store.js';
import { colors, toolColor } from '../theme.js';
import { avgPerDay, formatRelativeTime, reversedCounts, shortenPath, truncate } from '../utils/format.js';

const HERO_ART = [
  ' _ __ ___  _ __ ___',
  "| '_ ` _ \\\\| '_ ` _ \\\\",
  '| | | | | | | | | | |',
  '|_| |_| |_|_| |_| |_|',
  '',
  'mmbridge',
];

const DASHBOARD_MENU = [
  {
    title: 'Review Live',
    description: 'Open the live monitor and run `mmbridge review --stream` from shell',
    command: 'mmbridge review --stream --tool codex',
  },
  {
    title: 'Bridge Interpreted',
    description: 'Run multi-tool consensus with interpretation enabled',
    command: 'mmbridge review --tool all --bridge interpreted',
  },
  {
    title: 'Sessions',
    description: 'Inspect saved findings, followups, and triage state',
    tab: 'sessions' as const,
  },
  {
    title: 'Config',
    description: 'Tune adapters, bridge policy, and redaction rules',
    tab: 'config' as const,
  },
  {
    title: 'Doctor',
    description: 'Verify binary availability and runtime health',
    command: 'mmbridge doctor',
  },
  {
    title: 'Followup',
    description: 'Continue the latest resumable session from shell',
    command: 'mmbridge followup --tool codex --latest --prompt "re-check finding 1"',
  },
] as const;

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

function HeroSection({
  selectedIndex,
}: {
  selectedIndex: number;
}): React.ReactElement {
  const selected = DASHBOARD_MENU[selectedIndex] ?? DASHBOARD_MENU[0];

  return (
    <Panel title="HOME" flexGrow={1} borderColor={colors.surface1}>
      <Box flexDirection="column" marginTop={1} gap={1}>
        <Box flexDirection="column">
          {HERO_ART.map((line, index) => (
            <Text key={line} color={index === 0 ? colors.green : colors.accent}>
              {line}
            </Text>
          ))}
        </Box>

        <Box flexDirection="column">
          <Text color={colors.accentAlt}>https://github.com/EungjePark/mmbridge</Text>
          <Text color={colors.green}>A terminal-first multi-model review bridge for agentic coding.</Text>
        </Box>

        <Box flexDirection="column">
          {DASHBOARD_MENU.map((item, index) => {
            const isSelected = index === selectedIndex;
            return (
              <Box key={item.title} flexDirection="row" gap={1}>
                <Text color={isSelected ? colors.accent : colors.overlay0}>{isSelected ? '>' : ' '}</Text>
                <Text color={isSelected ? colors.text : colors.overlay1}>{`${index + 1}.`.padEnd(3)}</Text>
                <Text color={isSelected ? colors.peach : colors.subtext1} bold={isSelected}>
                  {item.title.padEnd(18)}
                </Text>
                <Text color={isSelected ? colors.text : colors.overlay1}>{item.description}</Text>
              </Box>
            );
          })}
        </Box>

        <Box flexDirection="column">
          <Text color={colors.overlay1}>SELECTED</Text>
          <Text color={colors.subtext0}>{selected.description}</Text>
          {'command' in selected ? (
            <Box>
              <Text color={colors.peach}>$ </Text>
              <Text color={colors.text}>{selected.command}</Text>
            </Box>
          ) : (
            <Text color={colors.accent}>Open {selected.tab}</Text>
          )}
        </Box>
      </Box>
    </Panel>
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
  const [state, dispatch] = useTui();
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

  useInput((input, key) => {
    if (state.activeTab !== 'dashboard' || state.inputMode !== 'none' || liveState) {
      return;
    }

    if (input === 'j' || key.downArrow) {
      dispatch({
        type: 'SIDEBAR_MOVE',
        delta: state.sidebar.selectedIndex >= DASHBOARD_MENU.length - 1 ? 0 : 1,
      });
    }
    if (input === 'k' || key.upArrow) {
      dispatch({
        type: 'SIDEBAR_MOVE',
        delta: state.sidebar.selectedIndex <= 0 ? 0 : -1,
      });
    }
    if (key.return) {
      const item = DASHBOARD_MENU[state.sidebar.selectedIndex] ?? DASHBOARD_MENU[0];
      if (!item) return;
      if ('tab' in item) {
        dispatch({ type: 'SWITCH_TAB', tab: item.tab });
        return;
      }
      dispatch({
        type: 'SHOW_TOAST',
        message: `Run: ${item.command}`,
        toastType: 'info',
      });
    }
  });

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
            <Box key="home-column" flexDirection="column" gap={1}>
              <HeroSection selectedIndex={Math.min(state.sidebar.selectedIndex, DASHBOARD_MENU.length - 1)} />
              <QuickStartSection />
            </Box>,
            <Box key="right-column" flexDirection="column" gap={1}>
              <ActivitySection
                dailyCounts={stats.dailyCounts}
                aggregateSeverity={stats.aggregateSeverity}
                totalSessions={sessions.length}
              />
              <LastReviewSection lastReview={lastReview} />
              {sessions[0] && (
                <ReviewFlowMap
                  {...buildSessionReviewFlow({
                    tool: sessions[0].tool,
                    mode: sessions[0].mode,
                    status: sessions[0].status,
                    findings: sessions[0].findings ?? [],
                    toolResults: sessions[0].toolResults,
                    resultIndex: sessions[0].resultIndex ?? null,
                    interpretation: sessions[0].interpretation ?? null,
                    changedFiles: sessions[0].contextIndex?.changedFiles ?? null,
                  })}
                />
              )}
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
