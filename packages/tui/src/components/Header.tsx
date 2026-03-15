import { Box, Text } from 'ink';
import type React from 'react';
import type { TabId } from '../store.js';
import { TAB_ORDER } from '../store.js';
import { CHARS, colors } from '../theme.js';

const TAB_LABELS: Record<TabId, string> = {
  dashboard: 'Dashboard',
  sessions: 'Sessions',
  config: 'Config',
};

interface HeaderProps {
  activeTab: TabId;
  branch?: string;
  dirtyCount?: number;
}

// Dim horizontal rule — stretches to full terminal width
export function HRule(): React.ReactElement {
  const cols = process.stdout.columns ?? 80;
  return (
    <Box paddingX={1}>
      <Text color={colors.surface0}>{CHARS.hrule.repeat(Math.max(40, cols - 2))}</Text>
    </Box>
  );
}

export function Header({ activeTab, branch, dirtyCount }: HeaderProps): React.ReactElement {
  const branchLabel = branch ? ` ${branch}${dirtyCount != null && dirtyCount > 0 ? ` *${dirtyCount}` : ''}` : '';

  return (
    <Box flexDirection="column">
      <Box paddingX={1} paddingY={0} flexDirection="row" justifyContent="space-between">
        <Box flexDirection="row" gap={1}>
          <Text color={colors.accent} bold>
            mmbridge
          </Text>
          <Text color={colors.surface0}>{'  --  '}</Text>
          {TAB_ORDER.map((tab, i) => {
            const isActive = tab === activeTab;
            const num = String(i + 1);
            return (
              <Box key={tab} flexDirection="column" gap={0} alignItems="center">
                {isActive ? (
                  <>
                    <Text bold color={colors.text}>{` ${num}:${TAB_LABELS[tab]} `}</Text>
                    <Text color={colors.accent}>{'━'.repeat(num.length + TAB_LABELS[tab].length + 3)}</Text>
                  </>
                ) : (
                  <>
                    <Text color={colors.overlay1}>{` ${num}:${TAB_LABELS[tab]} `}</Text>
                    <Text>{' '.repeat(num.length + TAB_LABELS[tab].length + 3)}</Text>
                  </>
                )}
              </Box>
            );
          })}
        </Box>
        <Box flexDirection="row" gap={1} alignItems="flex-start">
          {branchLabel.length > 0 && <Text color={colors.overlay1}>{branchLabel}</Text>}
          <Text color={colors.overlay1}>v0.6.0</Text>
        </Box>
      </Box>
      <HRule />
    </Box>
  );
}
