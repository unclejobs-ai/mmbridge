import { Box, Text } from 'ink';
import type React from 'react';
import { severityColor, severityIcon } from '../theme.js';

interface SeverityCounts {
  critical: number;
  warning: number;
  info: number;
  refactor: number;
}

interface SeverityBarProps {
  counts: SeverityCounts;
}

const SEVERITY_ORDER: Array<{ key: keyof SeverityCounts; label: string }> = [
  { key: 'critical', label: 'CRITICAL' },
  { key: 'warning', label: 'WARNING' },
  { key: 'info', label: 'INFO' },
  { key: 'refactor', label: 'REFACTOR' },
];

export function SeverityBar({ counts }: SeverityBarProps): React.ReactElement {
  return (
    <Box flexDirection="row" gap={2}>
      {SEVERITY_ORDER.map(({ key, label }) => (
        <Text key={key} color={severityColor(label)}>
          {severityIcon(label)}
          {counts[key]}
        </Text>
      ))}
    </Box>
  );
}
