import { Box, Text, useStdout } from 'ink';
import type React from 'react';
import type { TabId } from '../store.js';
import { TAB_ORDER } from '../store.js';
import { CHARS, colors } from '../theme.js';

const TAB_LABELS: Record<TabId, string> = {
  repl: 'REPL',
  dashboard: 'Dashboard',
  sessions: 'Sessions',
  config: 'Config',
};

interface HeaderProps {
  activeTab: TabId;
  branch?: string;
  dirtyCount?: number;
  version?: string;
}

export function Header({ activeTab, branch, dirtyCount, version }: HeaderProps): React.ReactElement {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;

  const branchLabel = branch ? `${branch}${dirtyCount != null && dirtyCount > 0 ? ` *${dirtyCount}` : ''}` : '';
  const rightLabel = `${branchLabel ? `${branchLabel} ` : ''}v${version ?? 'dev'}`;

  const title = ' mmbridge ';
  const rightPart = ` ${rightLabel} `;
  // Top border: ╭─(2) + title + ─×midLen + rightPart + ─╮(2) = cols
  const midLen = Math.max(0, cols - 4 - title.length - rightPart.length);

  return (
    <Box flexDirection="column">
      {/* Top border */}
      <Box>
        <Text color={colors.surface1}>{'╭─'}</Text>
        <Text color={colors.accent} bold>
          {title}
        </Text>
        <Text color={colors.surface1}>{'─'.repeat(midLen)}</Text>
        <Text color={colors.overlay1}>{rightPart}</Text>
        <Text color={colors.surface1}>{'─╮'}</Text>
      </Box>

      {/* Tab row */}
      <Box>
        <Text color={colors.surface1}>{'│  '}</Text>
        {TAB_ORDER.map((tab, i) => {
          const isActive = tab === activeTab;
          const icon = isActive ? CHARS.radioOn : CHARS.radioOff;
          const label = `${i + 1}:${TAB_LABELS[tab]}`;
          return (
            <Box key={tab}>
              <Text color={isActive ? colors.accent : colors.overlay0}>{icon} </Text>
              <Text color={isActive ? colors.text : colors.overlay1} bold={isActive}>
                {label}
              </Text>
              <Text>{'    '}</Text>
            </Box>
          );
        })}
        <Box flexGrow={1} />
        <Text color={colors.surface1}>{'│'}</Text>
      </Box>

      {/* Bottom border */}
      <Box>
        <Text color={colors.surface1}>{`╰${'─'.repeat(Math.max(40, cols - 2))}╯`}</Text>
      </Box>
    </Box>
  );
}
