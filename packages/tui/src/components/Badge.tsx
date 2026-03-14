import React from 'react';
import { Text } from 'ink';
import { severityColor, colors } from '../theme.js';

type BadgeSeverity = 'CRITICAL' | 'WARNING' | 'INFO' | 'REFACTOR' | string;

interface BadgeProps {
  severity: BadgeSeverity;
}

export function Badge({ severity }: BadgeProps): React.ReactElement {
  const label = severity.toUpperCase();
  const color = severityColor(label);
  // Inverse rendering: colored background via bold + color
  return (
    <Text color={colors.bg} backgroundColor={color} bold>
      {` ${label} `}
    </Text>
  );
}
