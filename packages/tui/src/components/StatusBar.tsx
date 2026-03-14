import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { colors } from '../theme.js';

interface ToastInfo {
  message: string;
  type: 'success' | 'error' | 'info';
  at: number;
}

interface StatusBarProps {
  branch?: string;
  sha?: string;
  dirtyCount?: number;
  toast?: ToastInfo | null;
}

const TOAST_DURATION_MS = 3000;

const HINT_TEXT = '\u21B9Focus  1-4Tab  j/k Nav  ?Help';

function toastColor(type: ToastInfo['type']): string {
  switch (type) {
    case 'success': return colors.green;
    case 'error': return colors.red;
    case 'info': return colors.cyan;
  }
}

export function StatusBar({
  branch = 'main',
  sha = '0000000',
  dirtyCount = 0,
  toast,
}: StatusBarProps): React.ReactElement {
  const [showToast, setShowToast] = useState(false);

  useEffect(() => {
    if (!toast) {
      setShowToast(false);
      return;
    }
    setShowToast(true);
    const elapsed = Date.now() - toast.at;
    const remaining = TOAST_DURATION_MS - elapsed;
    if (remaining <= 0) {
      setShowToast(false);
      return;
    }
    const timer = setTimeout(() => setShowToast(false), remaining);
    return () => clearTimeout(timer);
  }, [toast]);

  const shortSha = sha.slice(0, 7);
  const dirtyLabel = dirtyCount > 0 ? `${dirtyCount} dirty` : '0 dirty';

  return (
    <Box
      borderStyle="single"
      borderColor={colors.borderIdle}
      paddingX={1}
      flexDirection="row"
      justifyContent="space-between"
    >
      <Text color={colors.textMuted}>
        {branch} \u00B7 {shortSha} \u00B7 {dirtyLabel}
      </Text>
      {showToast && toast ? (
        <Text color={toastColor(toast.type)} bold>
          {toast.message}
        </Text>
      ) : (
        <Text color={colors.dim}>{HINT_TEXT}</Text>
      )}
    </Box>
  );
}
