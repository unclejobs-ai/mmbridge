import React, { useState } from 'react';
import { Box, Text } from 'ink';

// ─── Color constants ──────────────────────────────────────────────────────────

const colors = {
  green: '#22C55E',
  yellow: '#EAB308',
  red: '#EF4444',
  cyan: '#06B6D4',
  dim: '#64748B',
  text: '#F8FAFC',
  textMuted: '#94A3B8',
  surface: '#1E293B',
  borderFocus: '#22C55E',
  borderIdle: '#334155',
} as const;

function severityColor(severity: string): string {
  switch (severity.toUpperCase()) {
    case 'CRITICAL': return colors.red;
    case 'WARNING':  return colors.yellow;
    case 'INFO':     return colors.cyan;
    case 'REFACTOR': return colors.dim;
    default:         return colors.text;
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface Finding {
  severity: string;
  file: string;
  line: number | null;
  message: string;
}

interface SessionItem {
  id: string;
  tool: string;
  mode: string;
  date: string;
  findingCount: number;
  summary: string;
  findings: Finding[];
}

// ─── Mock data ────────────────────────────────────────────────────────────────

const MOCK_SESSIONS: SessionItem[] = [
  {
    id: 'abc-123',
    tool: 'kimi',
    mode: 'security',
    date: '2026-03-14 15:30',
    findingCount: 5,
    summary: '5 findings across 4 files. Unsafe input handling in API layer. Schema import missing in handler.',
    findings: [
      { severity: 'CRITICAL', file: 'src/api.ts',     line: 42,  message: 'Unsafe parse — no try/catch' },
      { severity: 'WARNING',  file: 'src/utils.ts',   line: 18,  message: 'Unvalidated user input passed downstream' },
      { severity: 'WARNING',  file: 'src/config.ts',  line: 7,   message: 'Hardcoded secret in config' },
      { severity: 'INFO',     file: 'src/types.ts',   line: 3,   message: 'Consider using branded types' },
      { severity: 'REFACTOR', file: 'src/old.ts',     line: 99,  message: 'Dead code path' },
    ],
  },
  {
    id: 'def-456',
    tool: 'qwen',
    mode: 'review',
    date: '2026-03-13 10:12',
    findingCount: 2,
    summary: '2 findings. Minor naming issues and unused export.',
    findings: [
      { severity: 'INFO',     file: 'src/db.ts',      line: 55,  message: 'Function name does not follow convention' },
      { severity: 'REFACTOR', file: 'src/helpers.ts', line: null, message: 'Unused export' },
    ],
  },
  {
    id: 'ghi-789',
    tool: 'codex',
    mode: 'review',
    date: '2026-03-12 08:44',
    findingCount: 3,
    summary: '3 findings. Error handling gaps in async flows.',
    findings: [
      { severity: 'WARNING',  file: 'src/fetch.ts',   line: 23,  message: 'Unhandled promise rejection' },
      { severity: 'WARNING',  file: 'src/fetch.ts',   line: 31,  message: 'Missing timeout on fetch call' },
      { severity: 'INFO',     file: 'src/cache.ts',   line: 10,  message: 'Cache TTL is hardcoded' },
    ],
  },
];

const ALL_TOOLS = ['all', 'kimi', 'qwen', 'codex', 'gemini'];
const ALL_MODES = ['all', 'review', 'security', 'followup'];

// ─── Sub-components ───────────────────────────────────────────────────────────

interface RadioGroupProps {
  label: string;
  options: string[];
  selected: string;
  onSelect: (value: string) => void;
}

function RadioGroup({ label, options, selected }: RadioGroupProps): React.ReactElement {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={colors.textMuted} bold>{label}</Text>
      {options.map((opt) => (
        <Box key={opt} flexDirection="row">
          <Text color={opt === selected ? colors.green : colors.dim}>
            {opt === selected ? '◉' : '○'}{' '}
          </Text>
          <Text color={opt === selected ? colors.text : colors.textMuted}>{opt}</Text>
        </Box>
      ))}
    </Box>
  );
}

interface SessionRowProps {
  session: SessionItem;
  isSelected: boolean;
}

function SessionRow({ session, isSelected }: SessionRowProps): React.ReactElement {
  const shortDate = session.date.slice(5, 10); // MM-DD
  return (
    <Box flexDirection="row">
      <Text color={isSelected ? colors.green : colors.dim}>
        {isSelected ? '●' : '○'}{' '}
      </Text>
      <Text color={isSelected ? colors.text : colors.textMuted}>
        {shortDate} {session.tool.padEnd(5)} {session.mode.slice(0, 3)}
      </Text>
    </Box>
  );
}

interface FindingRowProps {
  finding: Finding;
}

function FindingRow({ finding }: FindingRowProps): React.ReactElement {
  const loc = finding.line !== null
    ? `${finding.file}:${finding.line}`
    : finding.file;
  return (
    <Box flexDirection="row" marginLeft={2}>
      <Text color={severityColor(finding.severity)} bold>
        {finding.severity.padEnd(8)}{'  '}
      </Text>
      <Text color={colors.textMuted}>{loc}</Text>
    </Box>
  );
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function SessionsView(): React.ReactElement {
  const [toolFilter, setToolFilter] = useState('all');
  const [modeFilter, setModeFilter] = useState('all');
  const [selectedId, setSelectedId] = useState<string>(MOCK_SESSIONS[0]?.id ?? '');

  const filtered = MOCK_SESSIONS.filter((s) => {
    const toolMatch = toolFilter === 'all' || s.tool === toolFilter;
    const modeMatch = modeFilter === 'all' || s.mode === modeFilter;
    return toolMatch && modeMatch;
  });

  const selected = filtered.find((s) => s.id === selectedId) ?? filtered[0] ?? null;

  // Handlers kept for future key-binding wiring in App.tsx
  const handleToolSelect = (value: string): void => { setToolFilter(value); };
  const handleModeSelect = (value: string): void => { setModeFilter(value); };

  // Cycle selection when filter changes
  React.useEffect(() => {
    if (filtered.length > 0 && !filtered.find((s) => s.id === selectedId)) {
      setSelectedId(filtered[0]!.id);
    }
  }, [toolFilter, modeFilter, filtered, selectedId]);

  return (
    <Box flexDirection="row" width="100%" height="100%">
      {/* ── Sidebar ── */}
      <Box
        flexDirection="column"
        width={22}
        borderStyle="single"
        borderColor={colors.borderIdle}
        paddingX={1}
      >
        <RadioGroup
          label="TOOL"
          options={ALL_TOOLS}
          selected={toolFilter}
          onSelect={handleToolSelect}
        />
        <RadioGroup
          label="MODE"
          options={ALL_MODES}
          selected={modeFilter}
          onSelect={handleModeSelect}
        />
        <Box borderStyle="single" borderColor={colors.borderIdle} marginBottom={1} />
        <Text color={colors.textMuted} bold>HISTORY</Text>
        {filtered.length === 0 && (
          <Text color={colors.dim}>  No sessions</Text>
        )}
        {filtered.map((s) => (
          <SessionRow
            key={s.id}
            session={s}
            isSelected={s.id === (selected?.id ?? '')}
          />
        ))}
      </Box>

      {/* ── Main panel ── */}
      <Box
        flexDirection="column"
        flexGrow={1}
        borderStyle="single"
        borderColor={colors.borderFocus}
        paddingX={2}
        paddingY={1}
      >
        {selected === null ? (
          <Text color={colors.dim}>No session selected.</Text>
        ) : (
          <>
            <Text color={colors.cyan} bold>SESSION DETAIL</Text>
            <Box marginTop={1} flexDirection="column">
              <Text>
                <Text color={colors.textMuted}>ID:    </Text>
                <Text color={colors.text}>{selected.id}</Text>
              </Text>
              <Text>
                <Text color={colors.textMuted}>Tool:  </Text>
                <Text color={colors.text}>{selected.tool}</Text>
                <Text color={colors.textMuted}>  Mode: </Text>
                <Text color={colors.text}>{selected.mode}</Text>
              </Text>
              <Text>
                <Text color={colors.textMuted}>Date:  </Text>
                <Text color={colors.text}>{selected.date}</Text>
              </Text>
              <Text>
                <Text color={colors.textMuted}>Files: </Text>
                <Text color={colors.text}>{selected.findingCount} changed</Text>
              </Text>
            </Box>

            <Box marginTop={1} flexDirection="column">
              <Text color={colors.text} bold>
                FINDINGS ({selected.findings.length})
              </Text>
              {selected.findings.map((f, i) => (
                <FindingRow key={i} finding={f} />
              ))}
            </Box>

            <Box marginTop={1} flexDirection="column">
              <Text color={colors.text} bold>SUMMARY</Text>
              <Box marginLeft={2}>
                <Text color={colors.textMuted}>{selected.summary}</Text>
              </Box>
            </Box>

            <Box marginTop={1}>
              <Text color={colors.dim}>e Export  f Followup  d Diff</Text>
            </Box>
          </>
        )}
      </Box>
    </Box>
  );
}
