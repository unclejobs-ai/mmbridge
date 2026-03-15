import { Text } from 'ink';
import type React from 'react';
import { CHARS, colors } from '../theme.js';

interface SparklineProps {
  data: number[];
  color?: string;
  width?: number;
}

export function Sparkline({ data, color = colors.accent, width }: SparklineProps): React.ReactElement {
  const source = width !== undefined ? data.slice(-width) : data;

  if (source.length === 0) {
    return <Text> </Text>;
  }

  const min = Math.min(...source);
  const max = Math.max(...source);
  const range = max - min;
  const blocks = CHARS.sparkBlocks;

  const chars = source.map((v) => {
    const normalized = range === 0 ? 4 : Math.round(((v - min) / range) * 7);
    return blocks[Math.min(7, Math.max(0, normalized))];
  });

  return <Text color={color}>{chars.join('')}</Text>;
}
