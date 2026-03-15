import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type React from 'react';
import { useState } from 'react';
import { colors } from '../theme.js';

interface PromptInputProps {
  label: string;
  onSubmit: (text: string) => void;
  onCancel: () => void;
  initialValue?: string;
  placeholder?: string;
}

export function PromptInput({
  label,
  onSubmit,
  onCancel,
  initialValue = '',
  placeholder = 'Type your prompt...',
}: PromptInputProps): React.ReactElement {
  const [value, setValue] = useState(initialValue);

  useInput((_input, key) => {
    if (key.escape) {
      onCancel();
    }
  });

  const handleSubmit = (text: string): void => {
    if (text.trim()) {
      onSubmit(text.trim());
    }
  };

  return (
    <Box flexDirection="row" gap={1} paddingX={1}>
      <Text color={colors.accent} bold>
        {label}:
      </Text>
      <TextInput value={value} onChange={setValue} onSubmit={handleSubmit} placeholder={placeholder} />
      <Text color={colors.textDim}>(ESC cancel)</Text>
    </Box>
  );
}
