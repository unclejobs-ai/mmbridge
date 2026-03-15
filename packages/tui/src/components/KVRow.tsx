import { Box, Text } from 'ink';
import type React from 'react';
import { colors } from '../theme.js';

interface KVRowProps {
  label: string;
  value: string;
  valueColor?: string;
  labelWidth?: number;
  icon?: string;
}

export function KVRow({ label, value, valueColor, labelWidth = 12, icon }: KVRowProps): React.ReactElement {
  const labelText = icon ? `${icon} ${label}` : label;
  const padWidth = icon ? Math.max(labelWidth, labelText.length) : labelWidth;

  return (
    <Box flexDirection="row">
      <Text color={colors.subtext0}>{labelText.padEnd(padWidth)}</Text>
      <Text color={valueColor ?? colors.text}>{value}</Text>
    </Box>
  );
}
