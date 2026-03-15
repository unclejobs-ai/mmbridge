import { Box, useStdout } from 'ink';
import type React from 'react';

interface FullWidthRowProps {
  leftRatio?: number;
  children: [React.ReactNode, React.ReactNode];
  gap?: number;
}

export function FullWidthRow({ leftRatio = 0.5, children, gap = 2 }: FullWidthRowProps): React.ReactElement {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const leftWidth = Math.floor(cols * leftRatio);
  const rightWidth = cols - leftWidth - gap;

  return (
    <Box flexDirection="row">
      <Box width={leftWidth}>{children[0]}</Box>
      <Box width={gap} />
      <Box width={rightWidth}>{children[1]}</Box>
    </Box>
  );
}
