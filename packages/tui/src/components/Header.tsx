import React from 'react';
import { Box, Text } from 'ink';
import { colors } from '../theme.js';

type TabId = 'review' | 'config' | 'sessions' | 'diff';

interface TabDef {
  id: TabId;
  label: string;
}

const TABS: TabDef[] = [
  { id: 'review', label: 'Review' },
  { id: 'config', label: 'Config' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'diff', label: 'Diff' },
];

interface HeaderProps {
  activeTab: TabId;
  onTabChange?: (tab: TabId) => void;
}

export function Header({ activeTab }: HeaderProps): React.ReactElement {
  return (
    <Box
      borderStyle="single"
      borderColor={colors.borderIdle}
      paddingX={1}
      flexDirection="row"
      gap={2}
    >
      <Text color={colors.cyan} bold>
        MMBRIDGE v0.2.0
      </Text>
      <Text color={colors.dim}>{'\u2500\u2500\u2500'}</Text>
      {TABS.map((tab) => {
        const isActive = tab.id === activeTab;
        return (
          <Text
            key={tab.id}
            color={isActive ? colors.green : colors.dim}
            bold={isActive}
          >
            {isActive ? `[${tab.label.toUpperCase()}]` : tab.label}
          </Text>
        );
      })}
    </Box>
  );
}
