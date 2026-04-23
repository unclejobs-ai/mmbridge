import { Box, Text } from 'ink';
import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { colors, severityColor, severityIcon, toolColor } from '../theme.js';

export interface FindingEntry {
  severity: string;
  file: string;
  line: number | null;
  message: string;
}

export type OutputEntry =
  | { type: 'input'; text: string; timestamp: number }
  | { type: 'progress'; text: string; done?: boolean; timestamp: number }
  | { type: 'text'; text: string; timestamp: number }
  | { type: 'error'; text: string; timestamp: number }
  | { type: 'findings'; tool: string; findings: FindingEntry[]; duration?: number; timestamp: number }
  | { type: 'status'; data: Record<string, string>; timestamp: number };

const SPINNER_FRAMES = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
const MAX_PER_SEVERITY = 3;

function groupBySeverity(findings: FindingEntry[]): Map<string, FindingEntry[]> {
  const order = ['CRITICAL', 'WARNING', 'INFO', 'REFACTOR'];
  const map = new Map<string, FindingEntry[]>();
  for (const f of findings) {
    const key = f.severity.toUpperCase();
    const existing = map.get(key);
    if (existing) {
      existing.push(f);
    } else {
      map.set(key, [f]);
    }
  }
  // Return sorted by severity order
  const sorted = new Map<string, FindingEntry[]>();
  for (const sev of order) {
    const val = map.get(sev);
    if (val) sorted.set(sev, val);
  }
  for (const [k, v] of map) {
    if (!sorted.has(k)) sorted.set(k, v);
  }
  return sorted;
}

function shortFile(filePath: string): string {
  const parts = filePath.split('/');
  if (parts.length <= 2) return filePath;
  return `…/${parts.slice(-2).join('/')}`;
}

function FindingsBox({
  tool,
  findings,
  duration,
}: { tool: string; findings: FindingEntry[]; duration?: number }): React.ReactElement {
  const grouped = groupBySeverity(findings);
  const durationStr = duration !== undefined ? `${duration}s` : '';
  const countStr = `${findings.length} finding${findings.length === 1 ? '' : 's'}`;
  const headerParts = [tool, countStr, durationStr].filter(Boolean);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={colors.surface1} paddingX={1}>
      <Box flexDirection="row" gap={1}>
        <Text color={colors.subtext0} bold>
          Review Complete
        </Text>
        <Text color={colors.surface1}>──</Text>
        {headerParts.map((part, i) => (
          <Text key={`${tool}:${part}`} color={i === 0 ? toolColor(tool) : colors.textMuted}>
            {i === 0 ? part : `· ${part}`}
          </Text>
        ))}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {Array.from(grouped.entries()).map(([sev, items]) => {
          const visible = items.slice(0, MAX_PER_SEVERITY);
          const remaining = items.length - visible.length;
          return (
            <Box key={sev} flexDirection="column" marginBottom={1}>
              <Text color={severityColor(sev)} bold>
                {severityIcon(sev)} {sev} ({items.length})
              </Text>
              {visible.map((f, idx) => (
                <Box key={`${f.file}:${f.line}:${idx}`} flexDirection="column" paddingLeft={2}>
                  <Text color={colors.subtext0}>
                    #{idx + 1} {shortFile(f.file)}
                    {f.line !== null ? `:${f.line}` : ''}
                  </Text>
                  <Text color={colors.text} wrap="truncate">
                    {'   '}
                    {f.message}
                  </Text>
                </Box>
              ))}
              {remaining > 0 && (
                <Box paddingLeft={2}>
                  <Text color={colors.textDim}>... +{remaining} more</Text>
                </Box>
              )}
            </Box>
          );
        })}
        {grouped.size > 2 && (
          <Box flexDirection="row" gap={2}>
            {Array.from(grouped.entries())
              .slice(2)
              .map(([sev, items]) => (
                <Text key={sev} color={severityColor(sev)}>
                  {severityIcon(sev)} {sev.slice(0, 3)} ({items.length})
                </Text>
              ))}
          </Box>
        )}
      </Box>
    </Box>
  );
}

function StatusBox({ data }: { data: Record<string, string> }): React.ReactElement {
  const entries = Object.entries(data);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={colors.surface1} paddingX={1}>
      {entries.map(([key, value]) => (
        <Box key={key} flexDirection="row" gap={1}>
          <Text color={colors.textMuted}>{key}:</Text>
          <Text color={colors.text}>{value}</Text>
        </Box>
      ))}
    </Box>
  );
}

function ProgressEntry({ text, done }: { text: string; done?: boolean }): React.ReactElement {
  const [frame, setFrame] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (done) {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }
    intervalRef.current = setInterval(() => {
      setFrame((f) => (f + 1) % SPINNER_FRAMES.length);
    }, 80);
    return () => {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [done]);

  const icon = done ? '●' : (SPINNER_FRAMES[frame] ?? '⠋');
  const iconColor = done ? colors.green : colors.yellow;

  return (
    <Box flexDirection="row" gap={1}>
      <Text color={iconColor}>{icon}</Text>
      <Text color={colors.text}>{text}</Text>
    </Box>
  );
}

interface ReplOutputEntryProps {
  entry: OutputEntry;
}

export function ReplOutputEntry({ entry }: ReplOutputEntryProps): React.ReactElement {
  switch (entry.type) {
    case 'input':
      return (
        <Box flexDirection="row" gap={1}>
          <Text color={colors.textDim}>❯</Text>
          <Text color={colors.textDim}>{entry.text}</Text>
        </Box>
      );
    case 'progress':
      return <ProgressEntry text={entry.text} done={entry.done} />;
    case 'text':
      return <Text color={colors.text}>{entry.text}</Text>;
    case 'error':
      return (
        <Box flexDirection="row" gap={1}>
          <Text color={colors.red}>✗</Text>
          <Text color={colors.red}>{entry.text}</Text>
        </Box>
      );
    case 'findings':
      return <FindingsBox tool={entry.tool} findings={entry.findings} duration={entry.duration} />;
    case 'status':
      return <StatusBox data={entry.data} />;
  }
}

interface ReplOutputListProps {
  entries: OutputEntry[];
  maxVisible?: number;
}

export function ReplOutputList({ entries, maxVisible = 50 }: ReplOutputListProps): React.ReactElement {
  const visible = entries.slice(-maxVisible);
  return (
    <Box flexDirection="column">
      {visible.map((entry, i) => (
        <ReplOutputEntry key={`${entry.type}-${entry.timestamp}-${i}`} entry={entry} />
      ))}
    </Box>
  );
}
