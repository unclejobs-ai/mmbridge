import { Text, useStdout } from 'ink';
import type React from 'react';
import { colors } from '../theme.js';

export function HRuleFull(): React.ReactElement {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  return <Text color={colors.surface0}>{'─'.repeat(cols)}</Text>;
}
