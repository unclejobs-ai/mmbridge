import { Box, Text } from 'ink';
import type React from 'react';
import { toolColor } from '../theme.js';

interface ToolDotsProps {
  tools: string[];
  agreed: string[];
}

export function ToolDots({ tools, agreed }: ToolDotsProps): React.ReactElement {
  return (
    <Box flexDirection="row">
      {tools.map((tool) => {
        const isAgreed = agreed.includes(tool);
        return (
          <Text key={tool} color={toolColor(tool)} dimColor={!isAgreed}>
            {isAgreed ? '●' : '○'}
          </Text>
        );
      })}
    </Box>
  );
}
