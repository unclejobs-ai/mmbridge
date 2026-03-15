import { Box, Text, useInput } from 'ink';
import type React from 'react';
import { useTui } from '../store.js';
import { colors } from '../theme.js';

interface KeyBinding {
  key: string;
  description: string;
}

const NAV_BINDINGS: KeyBinding[] = [
  { key: '1-3/d/s/c', description: 'Switch tabs' },
  { key: 'Left/Right', description: 'Previous/next tab' },
  { key: 'j / k', description: 'Move selection down/up' },
  { key: 'Up / Down', description: 'Move selection down/up' },
  { key: 'h / l', description: 'Switch column (Review)' },
  { key: 'Tab', description: 'Toggle sidebar/main' },
  { key: 'b', description: 'Bridge multi-model review' },
  { key: '?', description: 'Toggle this help' },
  { key: 'Esc', description: 'Close overlay' },
  { key: 'q', description: 'Quit' },
];

const ACTION_BINDINGS: KeyBinding[] = [
  { key: 'Enter', description: 'Confirm / start review' },
  { key: 'n', description: 'New review (from results)' },
  { key: 'r', description: 'Refresh data' },
  { key: 'e', description: 'Export results' },
  { key: 'f', description: 'Followup on session' },
  { key: 'd', description: 'Open diff view' },
  { key: 'Del', description: 'Delete session' },
  { key: '/', description: 'Search (Sessions)' },
];

function KeyRow({ binding }: { binding: KeyBinding }): React.ReactElement {
  return (
    <Box flexDirection="row" marginBottom={0}>
      <Text color={colors.accent} bold>
        {binding.key.padEnd(12)}
      </Text>
      <Text color={colors.subtext0}>{binding.description}</Text>
    </Box>
  );
}

function DimRule(): React.ReactElement {
  return (
    <Box marginY={1}>
      <Text color={colors.surface0}>{'─'.repeat(56)}</Text>
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
      paddingX={2}
      paddingY={1}
      width={62}
      borderStyle="single"
      borderColor={colors.surface0}
    >
      <Box justifyContent="center" marginBottom={1}>
        <Text color={colors.accent} bold>
          Keyboard Shortcuts
        </Text>
      </Box>
      <DimRule />
      <Box flexDirection="row" gap={4}>
        <Box flexDirection="column" flexGrow={1}>
          <Text color={colors.subtext0}>NAVIGATION</Text>
          <Box marginTop={1} flexDirection="column">
            {NAV_BINDINGS.map((b) => (
              <KeyRow key={b.key} binding={b} />
            ))}
          </Box>
        </Box>
        <Box flexDirection="column" flexGrow={1}>
          <Text color={colors.subtext0}>ACTIONS</Text>
          <Box marginTop={1} flexDirection="column">
            {ACTION_BINDINGS.map((b) => (
              <KeyRow key={b.key} binding={b} />
            ))}
          </Box>
        </Box>
      </Box>
      <DimRule />
      <Box justifyContent="center">
        <Text color={colors.overlay0}>Press ? or Esc to close</Text>
      </Box>
    </Box>
  );
}
