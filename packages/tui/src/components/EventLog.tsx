import React from 'react';
import { Box, Text } from 'ink';
import { colors } from '../theme.js';
import type { LiveState } from '@mmbridge/core';

interface EventLogProps {
  liveState: LiveState | null;
  maxEvents?: number;
}

export function EventLog({ liveState, maxEvents = 8 }: EventLogProps): React.ReactElement {
  if (liveState === null || liveState.events.length === 0) {
    return (
      <Box paddingX={1}>
        <Text color={colors.textDim}>no active review — run mmbridge review --stream to start</Text>
      </Box>
    );
  }

  const visible = liveState.events.slice(-maxEvents);

  return (
    <Box flexDirection="column" paddingX={1}>
      {visible.map((event, i) => (
        <Box key={i} flexDirection="row" gap={2}>
          <Text color={colors.overlay0}>{event.time}</Text>
          <Text color={colors.subtext0}>{event.message}</Text>
        </Box>
      ))}
    </Box>
  );
}
