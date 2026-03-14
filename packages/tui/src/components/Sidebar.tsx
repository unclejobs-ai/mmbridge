import React from 'react';
import { Box, Text } from 'ink';
import { colors } from '../theme.js';

export interface SidebarItem {
  label: string;
  badge?: string;
  badgeColor?: string;
}

export interface SidebarSection {
  title: string;
  items: SidebarItem[];
}

export interface SidebarProps {
  sections: SidebarSection[];
  selectedIndex: number;
  focused: boolean;
  onSelect: (index: number) => void;
}

export function Sidebar({
  sections,
  selectedIndex,
  focused,
}: SidebarProps): React.ReactElement {
  // Build a flat list of all items with their global indices
  const flatItems: Array<{ sectionTitle: string; sectionIndex: number; item: SidebarItem; globalIndex: number }> = [];
  sections.forEach((section, si) => {
    section.items.forEach((item) => {
      flatItems.push({ sectionTitle: section.title, sectionIndex: si, item, globalIndex: flatItems.length });
    });
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={focused ? colors.borderFocus : colors.borderIdle}
      width={24}
      paddingX={1}
      paddingY={0}
    >
      {sections.map((section, si) => {
        const sectionItems = flatItems.filter((f) => f.sectionIndex === si);
        return (
          <Box key={section.title} flexDirection="column" marginTop={si > 0 ? 1 : 0}>
            <Text color={colors.dim} bold>
              {section.title.toUpperCase()}
            </Text>
            {sectionItems.map(({ item, globalIndex }) => {
              const isSelected = globalIndex === selectedIndex;
              return (
                <Box key={`${section.title}-${item.label}`} flexDirection="row" gap={1}>
                  <Text color={isSelected ? colors.green : colors.dim}>
                    {isSelected ? '\u25CF' : '\u25CB'}
                  </Text>
                  <Text color={isSelected ? colors.text : colors.textMuted} bold={isSelected}>
                    {item.label}
                  </Text>
                  {item.badge !== undefined && item.badge !== '' && (
                    <Text color={item.badgeColor ?? colors.dim}>{item.badge}</Text>
                  )}
                </Box>
              );
            })}
          </Box>
        );
      })}
    </Box>
  );
}
