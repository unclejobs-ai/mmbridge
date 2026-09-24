import { Box, Text, useApp, useInput, useStdin } from 'ink';
import Spinner from 'ink-spinner';
import type React from 'react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { HubStore, LaneState, LaneStatus, TraceLine } from '../hub-state.js';
import { colors } from '../theme.js';

/** Answer lines shown at the bottom of a pane while it streams. */
const ANSWER_TAIL_LINES = 4;
const CLOCK_MS = 100;

const STATUS: Record<LaneStatus, { icon: string; label: string; color: string }> = {
  starting: { icon: '○', label: 'starting', color: colors.overlay1 },
  running: { icon: '●', label: 'running', color: colors.blue },
  done: { icon: '✓', label: 'done', color: colors.green },
  error: { icon: '✗', label: 'error', color: colors.red },
};

function isLive(lane: LaneState): boolean {
  return lane.status === 'starting' || lane.status === 'running';
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function tokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function facts(lane: LaneState, now: number): string {
  const parts = [seconds((lane.endedAt ?? now) - lane.startedAt)];
  if (lane.readyMs !== undefined) parts.push(`ready ${seconds(lane.readyMs)}`);
  if (lane.toolCalls > 0) parts.push(`${lane.toolCalls} tool${lane.toolCalls === 1 ? '' : 's'}`);
  if (lane.tokens.input + lane.tokens.output > 0) {
    parts.push(`${tokens(lane.tokens.input)} in / ${tokens(lane.tokens.output)} out`);
  }
  parts.push(`$${lane.costUsd.toFixed(3)}`);
  return parts.join(' · ');
}

function TraceRow({ line }: { line: TraceLine }): React.ReactElement {
  const color = line.state === 'error' ? colors.red : line.state === 'running' ? colors.text : colors.overlay1;
  return (
    <Text color={color} wrap="truncate-end">
      {line.state === 'error' ? '✗' : '→'} {line.name}
      {line.intent ? <Text color={colors.overlay1}> {line.intent}</Text> : null}
    </Text>
  );
}

function WorkerPane({ lane, now }: { lane: LaneState; now: number }): React.ReactElement {
  const status = STATUS[lane.status];
  const answer = lane.text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .slice(-ANSWER_TAIL_LINES);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={colors.surface1} paddingX={1} flexGrow={1}>
      <Box justifyContent="space-between">
        <Text wrap="truncate-end">
          <Text bold color={colors.accent}>
            {lane.role}
          </Text>
          <Text color={colors.subtext0}> {lane.model ?? 'resolving model…'}</Text>
        </Text>
        <Box flexShrink={0} marginLeft={1}>
          <Text color={status.color}>
            {status.icon} {status.label}
          </Text>
        </Box>
      </Box>
      <Text color={colors.overlay1} wrap="truncate-end">
        {facts(lane, now)}
      </Text>
      {lane.passed.map((attempt) => (
        <Text key={`${attempt.provider}/${attempt.modelId}`} color={colors.overlay0} wrap="truncate-end">
          ↷ {attempt.provider}/{attempt.modelId} {attempt.outcome}
          {attempt.errorMessage ? ` — ${attempt.errorMessage}` : ''}
        </Text>
      ))}
      {lane.trace.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {lane.trace.map((line, i) => (
            <TraceRow key={`${i}-${line.name}`} line={line} />
          ))}
        </Box>
      ) : null}
      {answer.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {answer.map((line, i) => (
            <Text key={`${i}-${line}`} color={colors.text} wrap="truncate-end">
              {line}
            </Text>
          ))}
        </Box>
      ) : null}
      {lane.errorMessage ? (
        <Text color={colors.red} wrap="truncate-end">
          {lane.errorMessage}
        </Text>
      ) : null}
    </Box>
  );
}

export function HubView({ store, title }: { store: HubStore; title: string }): React.ReactElement {
  const lanes = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const { exit } = useApp();
  // Without a TTY (piped, CI) there is no keyboard; renderHub unmounts once every lane has finished.
  // ink reports `stdin.isTTY` as is (undefined off a TTY), and useInput only stands down on an explicit false.
  const keyboard = useStdin().isRawModeSupported === true;
  const [now, setNow] = useState(() => Date.now());
  const live = lanes.filter(isLive).length;

  // The wall clock is an external system: tick only while some worker is still running.
  useEffect(() => {
    if (live === 0) return;
    const timer = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(timer);
  }, [live]);

  useInput(
    (input) => {
      if (input === 'q') exit();
    },
    { isActive: keyboard },
  );

  const startedAt = Math.min(...lanes.map((lane) => lane.startedAt));
  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between" paddingX={1}>
        <Box flexShrink={0} marginRight={2}>
          <Text bold color={colors.text}>
            mmbridge hub
          </Text>
        </Box>
        <Text color={colors.overlay1} wrap="truncate-end">
          {title}
        </Text>
      </Box>
      {lanes.map((lane, i) => (
        <WorkerPane key={`${i}-${lane.role}`} lane={lane} now={now} />
      ))}
      {/* One spinner per surface (DESIGN.md §6): the activity row owns it; panes carry state as text. */}
      <Box paddingX={1}>
        {live > 0 ? (
          <Text color={colors.overlay2}>
            <Text color={colors.accent} bold>
              <Spinner type="dots" />
            </Text>{' '}
            {live} running · {seconds(now - startedAt)}
          </Text>
        ) : (
          <Text color={colors.overlay2}>◇ all finished</Text>
        )}
      </Box>
      <Box paddingX={1}>
        <Text color={colors.overlay0}>{keyboard ? 'q quit' : 'exits when every worker finishes'}</Text>
      </Box>
    </Box>
  );
}
