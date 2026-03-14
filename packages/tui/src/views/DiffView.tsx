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

interface FindingAnnotation {
  severity: string;
  message: string;
}

interface DiffLine {
  type: 'add' | 'remove' | 'context' | 'hunk' | 'file-header';
  content: string;
  lineNumber?: number;
  finding?: FindingAnnotation | null;
}

interface DiffFile {
  path: string;
  findingCount: number;
  lines: DiffLine[];
}

// ─── Mock data ────────────────────────────────────────────────────────────────

const MOCK_FILES: DiffFile[] = [
  {
    path: 'src/api.ts',
    findingCount: 2,
    lines: [
      { type: 'hunk',    content: '@@ -38,8 +38,12 @@' },
      { type: 'context', content: ' export async function handler(req) {' },
      { type: 'remove',  content: '-  const body = req.body;' },
      {
        type: 'add',
        content: '+  const body = await req.json();',
        finding: { severity: 'CRITICAL', message: 'No try/catch around req.json()' },
      },
      {
        type: 'add',
        content: '+  const validated = schema.parse(body);',
        finding: { severity: 'WARNING', message: 'schema not imported' },
      },
      { type: 'context', content: '   return NextResponse.json(validated);' },
      { type: 'context', content: ' }' },
    ],
  },
  {
    path: 'src/utils.ts',
    findingCount: 1,
    lines: [
      { type: 'hunk',    content: '@@ -12,5 +12,6 @@' },
      { type: 'context', content: ' export function sanitize(input: string) {' },
      {
        type: 'add',
        content: '+  return input.trim();',
        finding: { severity: 'WARNING', message: 'trim alone is insufficient sanitization' },
      },
      { type: 'context', content: ' }' },
    ],
  },
  {
    path: 'src/config.ts',
    findingCount: 1,
    lines: [
      { type: 'hunk',    content: '@@ -5,3 +5,4 @@' },
      {
        type: 'add',
        content: "+  secret: 'hardcoded-value',",
        finding: { severity: 'CRITICAL', message: 'Hardcoded secret — use env variable' },
      },
      { type: 'context', content: ' };' },
    ],
  },
  {
    path: 'src/types.ts',
    findingCount: 1,
    lines: [
      { type: 'hunk',    content: '@@ -1,5 +1,6 @@' },
      {
        type: 'add',
        content: '+export type UserId = string;',
        finding: { severity: 'INFO', message: 'Consider branded type for UserId' },
      },
      { type: 'context', content: ' export type SessionId = string;' },
    ],
  },
];

// ─── Sub-components ───────────────────────────────────────────────────────────

interface FileTreeItemProps {
  file: DiffFile;
  isSelected: boolean;
}

function FileTreeItem({ file, isSelected }: FileTreeItemProps): React.ReactElement {
  const shortPath = file.path.replace(/^src\//, '');
  return (
    <Box flexDirection="row">
      <Text color={isSelected ? colors.green : colors.dim}>
        {isSelected ? '●' : '○'}{' '}
      </Text>
      <Text color={isSelected ? colors.text : colors.textMuted}>
        {shortPath.padEnd(14)}
      </Text>
      <Text color={file.findingCount > 0 ? colors.yellow : colors.dim}>
        {file.findingCount}
      </Text>
    </Box>
  );
}

interface DiffLineRowProps {
  line: DiffLine;
}

function DiffLineRow({ line }: DiffLineRowProps): React.ReactElement {
  let lineColor: string = colors.textMuted;
  if (line.type === 'add')         lineColor = colors.green;
  if (line.type === 'remove')      lineColor = colors.red;
  if (line.type === 'hunk')        lineColor = colors.cyan;
  if (line.type === 'file-header') lineColor = colors.text;

  const isBold = line.type === 'hunk' || line.type === 'file-header';

  return (
    <Box flexDirection="column">
      <Text color={lineColor} bold={isBold}>{line.content}</Text>
      {line.finding !== null && line.finding !== undefined && (
        <Box marginLeft={2}>
          <Text color={severityColor(line.finding.severity)}>
            {'╰─ '}
            <Text bold>{line.finding.severity}</Text>
            {'  '}
            {line.finding.message}
          </Text>
        </Box>
      )}
    </Box>
  );
}

interface DiffPanelProps {
  file: DiffFile;
}

function DiffPanel({ file }: DiffPanelProps): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text color={colors.text} bold>{file.path}</Text>
      <Box marginTop={1} flexDirection="column">
        {file.lines.map((line, i) => (
          <DiffLineRow key={i} line={line} />
        ))}
      </Box>
    </Box>
  );
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function DiffView(): React.ReactElement {
  const [selectedPath, setSelectedPath] = useState<string>(
    MOCK_FILES[0]?.path ?? '',
  );

  if (MOCK_FILES.length === 0) {
    return (
      <Box padding={2}>
        <Text color={colors.textMuted}>
          No diff data. Run a review first.
        </Text>
      </Box>
    );
  }

  const selectedFile =
    MOCK_FILES.find((f) => f.path === selectedPath) ?? MOCK_FILES[0]!;

  // Handler kept for future key-binding wiring in App.tsx
  const _handleSelect = (path: string): void => { setSelectedPath(path); };

  return (
    <Box flexDirection="row" width="100%" height="100%">
      {/* ── File tree sidebar ── */}
      <Box
        flexDirection="column"
        width={22}
        borderStyle="single"
        borderColor={colors.borderIdle}
        paddingX={1}
        paddingY={1}
      >
        <Text color={colors.textMuted} bold>FILES</Text>
        <Box marginBottom={1} />
        {MOCK_FILES.map((f) => (
          <FileTreeItem
            key={f.path}
            file={f}
            isSelected={f.path === selectedFile.path}
          />
        ))}
        <Box marginTop={1}>
          <Text color={colors.dim}>n next  N prev</Text>
        </Box>
      </Box>

      {/* ── Diff main panel ── */}
      <Box
        flexDirection="column"
        flexGrow={1}
        borderStyle="single"
        borderColor={colors.borderFocus}
        paddingX={2}
        paddingY={1}
      >
        <DiffPanel file={selectedFile} />
      </Box>
    </Box>
  );
}
