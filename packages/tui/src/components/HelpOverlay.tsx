import React from 'react';
import { Box, Text, useInput } from 'ink';
import { colors } from '../theme.js';
import { useTui } from '../store.js';

interface KeyBinding {
  key: string;
  description: string;
}

const NAV_BINDINGS: KeyBinding[] = [
  { key: '1-4', description: 'Switch tabs' },
  { key: 'Tab', description: 'Toggle focus zone' },
  { key: 'j / k', description: 'Move selection down/up' },
  { key: '?', description: 'Toggle this help' },
  { key: 'Esc', description: 'Close overlay / cancel' },
  { key: 'q', description: 'Quit' },
];

const ACTION_BINDINGS: KeyBinding[] = [
  { key: 'Enter', description: 'Confirm / run' },
  { key: 'r', description: 'Refresh current view' },
  { key: 'd', description: 'Open diff for selection' },
  { key: 'f', description: 'Filter sessions' },
  { key: 'c', description: 'Copy result to clipboard' },
  { key: 'x', description: 'Clear result / reset' },
];

function KeyRow({ binding }: { binding: KeyBinding }): React.ReactElement {
  return (
    <Box flexDirection="row" gap={1}>
      <Text color={colors.yellow} bold>{binding.key.padEnd(10)}</Text>
      <Text color={colors.textMuted}>{binding.description}</Text>
    </Box>
  );
}

export function HelpOverlay(): React.ReactElement {
  const [, dispatch] = useTui();

  useInput((input, key) => {
    if (input === '?' || key.escape) {
      dispatch({ type: 'TOGGLE_HELP' });
    }
  });

  return (
    <Box
      position="absolute"
      flexDirection="column"
      borderStyle="double"
      borderColor={colors.borderFocus}
      paddingX={2}
      paddingY={1}
      width={58}
    >
      <Box justifyContent="center" marginBottom={1}>
        <Text color={colors.green} bold>Keyboard Shortcuts</Text>
      </Box>
      <Box flexDirection="row" gap={4}>
        <Box flexDirection="column" flexGrow={1}>
          <Text color={colors.cyan} bold>NAVIGATION</Text>
          {NAV_BINDINGS.map((b) => <KeyRow key={b.key} binding={b} />)}
        </Box>
        <Box flexDirection="column" flexGrow={1}>
          <Text color={colors.cyan} bold>ACTIONS</Text>
          {ACTION_BINDINGS.map((b) => <KeyRow key={b.key} binding={b} />)}
        </Box>
      </Box>
      <Box justifyContent="center" marginTop={1}>
        <Text color={colors.dim}>Press ? or Esc to close</Text>
      </Box>
    </Box>
  );
}
