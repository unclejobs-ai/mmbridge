import { Box, Text } from 'ink';
import type React from 'react';
import { useEffect, useState } from 'react';
import type { TabId } from '../store.js';
import { colors, statusColor } from '../theme.js';

interface ToastInfo {
  message: string;
  type: 'success' | 'error' | 'info';
  at: number;
}

interface StatusBarProps {
  toast?: ToastInfo | null;
  activeTab: TabId;
}

const TAB_HINTS: Record<TabId, Array<[string, string]>> = {
  dashboard: [
    ['r', 'Refresh'],
    ['1-3', 'Tabs'],
    ['?', 'Help'],
    ['q', 'Quit'],
  ],
  sessions: [
    ['j/k', 'Navigate'],
    ['[/]', 'Finding'],
    ['a/z/u', 'Triage'],
    ['f', 'Followup'],
    ['g', 'Finding FU'],
    ['e', 'Export'],
    ['q', 'Quit'],
  ],
  config: [
    ['j/k', 'Select'],
    ['↵', 'Test'],
    ['?', 'Help'],
    ['q', 'Quit'],
  ],
};

const TOAST_DURATION_MS = 3000;

export function StatusBar({ toast, activeTab }: StatusBarProps): React.ReactElement {
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

  const hints = TAB_HINTS[activeTab];

  return (
    <Box paddingX={1} paddingY={0}>
      {showToast && toast ? (
        <Text color={statusColor(toast.type)} bold>
          {toast.message}
        </Text>
      ) : (
        <Box flexDirection="row" gap={0}>
          {hints.map(([key, label], i) => (
            <Box key={key} flexDirection="row">
              <Text color={colors.accent} bold>
                {key}
              </Text>
              <Text color={colors.overlay1}> {label}</Text>
              {i < hints.length - 1 && <Text color={colors.surface1}>{' · '}</Text>}
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}
