import { Box, Text } from 'ink';
import type React from 'react';
import { useEffect } from 'react';
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
  onToastExpired: () => void;
}

const TAB_HINTS: Record<TabId, Array<[string, string]>> = {
  repl: [
    ['↵', 'Run'],
    ['↑↓', 'History'],
    ['Tab', 'Complete'],
    ['ESC', 'Dashboard'],
    ['q', 'Quit'],
  ],
  dashboard: [
    ['j/k', 'Menu'],
    ['↵', 'Open'],
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

export function isToastVisible(toast?: ToastInfo | null, now = Date.now()): boolean {
  return toast != null && now - toast.at < TOAST_DURATION_MS;
}

export function StatusBar({ toast, activeTab, onToastExpired }: StatusBarProps): React.ReactElement {
  useEffect(() => {
    if (!toast) {
      return;
    }
    const elapsed = Date.now() - toast.at;
    const remaining = TOAST_DURATION_MS - elapsed;
    if (remaining <= 0) {
      onToastExpired();
      return;
    }
    const timer = setTimeout(onToastExpired, remaining);
    return () => clearTimeout(timer);
  }, [onToastExpired, toast]);

  const hints = TAB_HINTS[activeTab];
  const showToast = isToastVisible(toast);

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
