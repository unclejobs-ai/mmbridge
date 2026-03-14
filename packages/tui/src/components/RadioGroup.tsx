import React from 'react';
import { Box, Text } from 'ink';

export interface RadioGroupProps {
  items: string[];
  selected: number;
  focused: boolean;
  onChange: (index: number) => void;
}

const colors = {
  green: '#22C55E',
  dim: '#64748B',
  text: '#F8FAFC',
} as const;

export function RadioGroup({ items, selected }: RadioGroupProps): React.ReactElement {
  return (
    <Box flexDirection="column">
      {items.map((item, i) => {
        const isSelected = i === selected;
        return (
          <Box key={item}>
            <Text color={isSelected ? colors.green : colors.dim}>
              {isSelected ? '◉' : '○'}
            </Text>
            <Text> </Text>
            <Text bold={isSelected} color={isSelected ? colors.text : colors.dim}>
              {item}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
