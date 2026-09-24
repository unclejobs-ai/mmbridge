import { Box, Text, useApp, useInput, useStdin, useStdout } from 'ink';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';
import type React from 'react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  type GateView,
  type HubStore,
  type LaneState,
  type LaneStatus,
  type TraceLine,
  isLive,
  isOpen,
} from '../hub-state.js';
import { colors } from '../theme.js';

const CLOCK_MS = 100;
/** Hub rows outside the panes: header, activity row, hint row, and the steer composer when open. */
const CHROME_ROWS = 4;
/** Gate box rows besides its reasons and details: two borders and the verdict. */
const GATE_FIXED_ROWS = 3;
/** Pane rows that are not answer text: two borders, title, facts. */
const PANE_FIXED_ROWS = 4;
const MIN_PANE_ROWS = 6;

const STATUS: Record<LaneStatus, { icon: string; label: string; color: string }> = {
  waiting: { icon: '·', label: 'waiting', color: colors.overlay0 },
  skipped: { icon: '–', label: 'skipped', color: colors.overlay0 },
  starting: { icon: '○', label: 'starting', color: colors.overlay1 },
  running: { icon: '●', label: 'running', color: colors.blue },
  aborting: { icon: '◌', label: 'aborting', color: colors.peach },
  done: { icon: '✓', label: 'done', color: colors.green },
  aborted: { icon: '■', label: 'aborted', color: colors.peach },
  error: { icon: '✗', label: 'error', color: colors.red },
};

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function tokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function facts(lane: LaneState, now: number): string {
  if (lane.status === 'waiting') return 'starts when the stage before it finishes';
  if (lane.status === 'skipped') return 'not needed for this run';
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

interface PaneProps {
  lane: LaneState;
  index: number;
  now: number;
  selected: boolean;
  rows: number;
}

function WorkerPane({ lane, index, now, selected, rows }: PaneProps): React.ReactElement {
  const status = STATUS[lane.status];
  // Rows left for the answer tail once every other row of this pane is placed (+1 for its top margin).
  const used =
    PANE_FIXED_ROWS +
    lane.passed.length +
    (lane.trace.length > 0 ? lane.trace.length + 1 : 0) +
    (lane.lastSteer ? 1 : 0) +
    (lane.errorMessage ? 1 : 0) +
    1;
  const answer = lane.text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .slice(-Math.max(0, rows - used));
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={selected ? colors.accent : colors.surface1}
      paddingX={1}
      height={rows}
      overflowY="hidden"
      flexShrink={0}
    >
      <Box justifyContent="space-between">
        <Text wrap="truncate-end">
          {/* Color is never the only signal (DESIGN.md): the selected lane also carries a marker. */}
          <Text color={selected ? colors.accent : colors.overlay1}>
            {selected ? '›' : ' '}
            {index + 1}{' '}
          </Text>
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
      {lane.lastSteer ? (
        <Text color={colors.mauve} wrap="truncate-end">
          ↳ steer: {lane.lastSteer}
        </Text>
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
        <Text color={lane.status === 'aborted' ? colors.peach : colors.red} wrap="truncate-end">
          {lane.errorMessage}
        </Text>
      ) : null}
    </Box>
  );
}

function GateBox({ gate }: { gate: GateView }): React.ReactElement {
  const pass = gate.verdict === 'pass';
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={pass ? colors.green : colors.red} paddingX={1}>
      <Text bold color={pass ? colors.green : colors.red}>
        {pass ? '✓ gate pass' : '✗ gate block'}
      </Text>
      {gate.reasons.map((reason) => (
        <Text key={reason} color={colors.red} wrap="truncate-end">
          {reason}
        </Text>
      ))}
      {gate.details.map((detail) => (
        <Text key={detail} color={colors.overlay1} wrap="truncate-end">
          {detail}
        </Text>
      ))}
    </Box>
  );
}

export function HubView({ store, title }: { store: HubStore; title: string }): React.ReactElement {
  const { lanes, busy, activity, gate, startedAt } = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const { exit } = useApp();
  const { stdout } = useStdout();
  // Without a TTY (piped, CI) there is no keyboard; renderHub unmounts once every lane has finished.
  // ink reports `stdin.isTTY` as is (undefined off a TTY), and useInput only stands down on an explicit false.
  const keyboard = useStdin().isRawModeSupported === true;
  const [now, setNow] = useState(() => Date.now());
  const [selected, setSelected] = useState(0);
  /** The steer message being typed for the selected lane; null while the composer is closed. */
  const [draft, setDraft] = useState<string | null>(null);
  const live = lanes.filter(isLive).length;
  const current = lanes[selected];

  // The wall clock is an external system: tick only while the run is still going.
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(timer);
  }, [busy]);

  useInput(
    (input, key) => {
      if (input === 'q') {
        lanes.forEach((_lane, i) => store.abort(i));
        exit();
      } else if (key.tab || key.downArrow || input === 'j') {
        setSelected((i) => (i + 1) % lanes.length);
      } else if (key.upArrow || input === 'k') {
        setSelected((i) => (i - 1 + lanes.length) % lanes.length);
      } else if (/^[1-9]$/.test(input) && Number(input) <= lanes.length) {
        setSelected(Number(input) - 1);
      } else if (input === 's' && current && isLive(current)) {
        setDraft('');
      } else if (input === 'x') {
        store.abort(selected);
      }
    },
    { isActive: keyboard && draft === null },
  );
  // TextInput handles typing and Enter; Esc closes the composer.
  useInput(
    (_input, key) => {
      if (key.escape) setDraft(null);
    },
    { isActive: keyboard && draft !== null },
  );

  const sendSteer = (message: string) => {
    if (message.trim() !== '') store.steer(selected, message.trim());
    setDraft(null);
  };

  const gateRows = gate ? GATE_FIXED_ROWS + gate.reasons.length + gate.details.length : 0;
  const paneRows = Math.max(MIN_PANE_ROWS, Math.floor(((stdout.rows || 40) - CHROME_ROWS - gateRows) / lanes.length));
  const multi = lanes.length > 1;
  const hint = !keyboard
    ? 'exits when every worker finishes'
    : [
        multi ? '↑↓/1-9 select' : null,
        current && isLive(current) ? 's steer' : null,
        current && isOpen(current) ? 'x abort' : null,
        busy ? 'q abort all & quit' : 'q quit',
      ]
        .filter(Boolean)
        .join(' · ');
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
        <WorkerPane
          key={`${i}-${lane.role}`}
          lane={lane}
          index={i}
          now={now}
          selected={multi && i === selected}
          rows={paneRows}
        />
      ))}
      {gate ? <GateBox gate={gate} /> : null}
      {/* One spinner per surface (DESIGN.md §6): the activity row owns it; panes carry state as text. */}
      <Box paddingX={1}>
        {busy ? (
          <Text color={colors.overlay2} wrap="truncate-end">
            <Text color={colors.accent} bold>
              <Spinner type="dots" />
            </Text>{' '}
            {live > 0 ? `${live} of ${lanes.length} running` : (activity ?? 'working')} · {seconds(now - startedAt)}
          </Text>
        ) : (
          <Text color={colors.overlay2}>◇ all finished</Text>
        )}
      </Box>
      {draft !== null && current ? (
        <Box paddingX={1}>
          <Text color={colors.mauve}>
            › steer {selected + 1} {current.role}:{' '}
          </Text>
          <TextInput value={draft} onChange={setDraft} onSubmit={sendSteer} />
        </Box>
      ) : null}
      <Box paddingX={1}>
        <Text color={colors.overlay0} wrap="truncate-end">
          {draft !== null ? '↵ send · esc cancel' : hint}
        </Text>
      </Box>
    </Box>
  );
}
