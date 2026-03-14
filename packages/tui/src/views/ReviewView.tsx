import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import { RadioGroup } from '../components/RadioGroup.js';

const TOOLS = ['kimi', 'qwen', 'codex', 'gemini'] as const;
const MODES = ['review', 'security', 'architecture'] as const;

type Tool = typeof TOOLS[number];
type Mode = typeof MODES[number];
type ReviewState = 'setup' | 'running' | 'complete';

interface Finding {
  severity?: string;
  file?: string;
  line?: number;
  message?: string;
}

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

const SEVERITY_COLORS: Record<string, string> = {
  CRITICAL: colors.red,
  WARNING: colors.yellow,
  INFO: colors.cyan,
  REFACTOR: colors.dim,
};

function severityColor(sev: string | undefined): string {
  return SEVERITY_COLORS[(sev ?? '').toUpperCase()] ?? colors.text;
}

function SidebarPanel({
  selectedTools,
  onToggleTool,
  selectedMode,
  onSelectMode,
}: {
  selectedTools: Set<Tool>;
  onToggleTool: (tool: Tool) => void;
  selectedMode: number;
  onSelectMode: (idx: number) => void;
}): React.ReactElement {
  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={colors.borderIdle}
      paddingX={1}
      width={26}
    >
      <Text bold color={colors.textMuted}>MODELS</Text>
      <Box flexDirection="column" marginBottom={1}>
        {TOOLS.map((tool) => {
          const checked = selectedTools.has(tool);
          return (
            <Box key={tool}>
              <Text color={checked ? colors.green : colors.dim}>
                {checked ? '●' : '○'}
              </Text>
              <Text> </Text>
              <Text color={colors.text}>{tool}</Text>
              <Text> </Text>
              <Text color={colors.green}>{checked ? '✓' : ''}</Text>
            </Box>
          );
        })}
      </Box>
      <Text bold color={colors.textMuted}>MODE</Text>
      <RadioGroup
        items={[...MODES]}
        selected={selectedMode}
        focused={false}
        onChange={onSelectMode}
      />
    </Box>
  );
}

function SetupPanel({
  selectedTools,
  selectedMode,
}: {
  selectedTools: Set<Tool>;
  selectedMode: Mode;
}): React.ReactElement {
  const toolList = [...selectedTools].join(', ') || '(none)';
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold color={colors.cyan}>Review Setup</Text>
      <Box flexDirection="column">
        <Box>
          <Text color={colors.textMuted}>{'Tools:        '}</Text>
          <Text color={colors.text}>{toolList}</Text>
        </Box>
        <Box>
          <Text color={colors.textMuted}>{'Mode:         '}</Text>
          <Text color={colors.text}>{selectedMode}</Text>
        </Box>
        <Box>
          <Text color={colors.textMuted}>{'Base ref:     '}</Text>
          <Text color={colors.text}>HEAD~1</Text>
        </Box>
        <Box>
          <Text color={colors.textMuted}>{'Files:        '}</Text>
          <Text color={colors.text}>scanning...</Text>
        </Box>
      </Box>
      <Box marginTop={1}>
        <Text bold color={colors.green}>[ START REVIEW ]</Text>
        <Text color={colors.dim}>  (press Enter)</Text>
      </Box>
    </Box>
  );
}

function RunningPanel({ tool }: { tool: string }): React.ReactElement {
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold color={colors.cyan}>Running Review</Text>
      <Box>
        <Text color={colors.green}>
          <Spinner type="dots" />
        </Text>
        <Text color={colors.text}>{'  Running '}</Text>
        <Text bold color={colors.text}>{tool}</Text>
        <Text color={colors.text}>...</Text>
      </Box>
      <Text color={colors.dim}>This may take a minute.</Text>
    </Box>
  );
}

function FindingRow({ finding }: { finding: Finding }): React.ReactElement {
  const sev = (finding.severity ?? 'INFO').toUpperCase();
  const col = severityColor(sev);
  const loc = finding.file
    ? `${finding.file}${finding.line != null ? `:${finding.line}` : ''}`
    : '';
  return (
    <Box>
      <Text bold color={col}>[{sev.padEnd(8)}]</Text>
      <Text> </Text>
      {loc !== '' && <Text color={colors.dim}>{loc}  </Text>}
      <Text color={colors.text}>{finding.message ?? ''}</Text>
    </Box>
  );
}

function ResultsPanel({ findings }: { findings: Finding[] }): React.ReactElement {
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold color={colors.green}>Review Complete</Text>
      <Text color={colors.textMuted}>
        {findings.length} finding{findings.length !== 1 ? 's' : ''}
      </Text>
      <Box flexDirection="column">
        {findings.map((f, i) => (
          <FindingRow key={i} finding={f} />
        ))}
        {findings.length === 0 && (
          <Text color={colors.dim}>No findings — all clear.</Text>
        )}
      </Box>
      <Box marginTop={1}>
        <Text color={colors.dim}>e: export  f: follow-up  d: details  q: quit</Text>
      </Box>
    </Box>
  );
}

const MOCK_FINDINGS: Finding[] = [
  { severity: 'WARNING', file: 'src/index.ts', line: 42, message: 'Unhandled promise rejection' },
  { severity: 'INFO', file: 'src/theme.ts', line: 5, message: 'Consider extracting color tokens' },
];

export function ReviewView(): React.ReactElement {
  const [selectedTools, setSelectedTools] = useState<Set<Tool>>(
    new Set<Tool>(['kimi', 'qwen']),
  );
  const [selectedMode, setSelectedMode] = useState(0);
  const [reviewState, setReviewState] = useState<ReviewState>('setup');
  const [runningTool, setRunningTool] = useState('');
  const [findings, setFindings] = useState<Finding[]>([]);

  const startReview = (): void => {
    const tools = [...selectedTools];
    if (tools.length === 0) return;
    setRunningTool(tools[0] ?? 'kimi');
    setReviewState('running');
    // Simulate async completion
    setTimeout(() => {
      setFindings(MOCK_FINDINGS);
      setReviewState('complete');
    }, 2500);
  };

  const toggleTool = (tool: Tool): void => {
    setSelectedTools((prev) => {
      const next = new Set(prev);
      if (next.has(tool)) {
        next.delete(tool);
      } else {
        next.add(tool);
      }
      return next;
    });
  };

  useInput((input, key) => {
    if (reviewState === 'setup' && key.return) {
      startReview();
    }
    if (reviewState === 'setup') {
      const idx = TOOLS.findIndex((t) => t[0] === input);
      if (idx >= 0) toggleTool(TOOLS[idx] as Tool);
      const modeIdx = MODES.findIndex((m) => m[0] === input);
      if (modeIdx >= 0) setSelectedMode(modeIdx);
    }
  });

  const currentMode = MODES[selectedMode] ?? 'review';

  return (
    <Box flexDirection="row" gap={1} padding={1}>
      <SidebarPanel
        selectedTools={selectedTools}
        onToggleTool={toggleTool}
        selectedMode={selectedMode}
        onSelectMode={setSelectedMode}
      />
      <Box
        flexDirection="column"
        borderStyle="single"
        borderColor={colors.borderIdle}
        paddingX={2}
        paddingY={1}
        flexGrow={1}
      >
        {reviewState === 'setup' && (
          <SetupPanel
            selectedTools={selectedTools}
            selectedMode={currentMode}
          />
        )}
        {reviewState === 'running' && (
          <RunningPanel tool={runningTool} />
        )}
        {reviewState === 'complete' && (
          <ResultsPanel findings={findings} />
        )}
      </Box>
    </Box>
  );
}
