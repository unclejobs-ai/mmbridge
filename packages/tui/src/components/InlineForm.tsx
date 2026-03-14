import React from 'react';
import { Box, Text } from 'ink';

export interface FormField {
  label: string;
  value: string;
  editable?: boolean;
}

export interface InlineFormProps {
  fields: FormField[];
}

const colors = {
  text: '#F8FAFC',
  textMuted: '#94A3B8',
  dim: '#64748B',
} as const;

export function InlineForm({ fields }: InlineFormProps): React.ReactElement {
  const labelWidth = Math.max(...fields.map((f) => f.label.length), 0);

  return (
    <Box flexDirection="column">
      {fields.map((field) => {
        const paddedLabel = field.label.padStart(labelWidth);
        return (
          <Box key={field.label}>
            <Text color={colors.textMuted}>{paddedLabel}:</Text>
            <Text>{'  '}</Text>
            <Text color={colors.text}>{field.value}</Text>
            {field.editable === true && (
              <>
                <Text>{'  '}</Text>
                <Text color={colors.dim}>(press Enter to edit)</Text>
              </>
            )}
          </Box>
        );
      })}
    </Box>
  );
}
