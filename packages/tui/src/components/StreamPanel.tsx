import React from 'react';
import { Box, Text } from 'ink';
import { colors } from '../theme.js';
import { Panel } from './Panel.js';

interface StreamPanelProps {
  lines: string[];
  maxLines?: number;
  title?: string;
}

export function StreamPanel({
  lines,
  maxLines = 12,
  title = 'LIVE OUTPUT',
}: StreamPanelProps): React.ReactElement {
  const visible = lines.slice(-maxLines);

  return (
    <Panel title={title} flexGrow={1} borderColor={colors.surface1}>
      <Box flexDirection="column" marginTop={1}>
        {visible.length === 0 ? (
          <Text color={colors.textDim}>Waiting for output...</Text>
        ) : (
          visible.map((line, i) => (
            <Text key={i} color={i === visible.length - 1 ? colors.text : colors.overlay1} wrap="truncate">
              {line}
            </Text>
          ))
        )}
      </Box>
    </Panel>
  );
}
