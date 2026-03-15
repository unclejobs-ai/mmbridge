import React from 'react';
import { Box, Text } from 'ink';
import { colors, severityColor, severityIcon, CHARS } from '../theme.js';
import { Panel } from './Panel.js';
import type { FindingItem } from '../store.js';

interface FindingsPreviewProps {
  findings: FindingItem[];
  maxFiles?: number;
  maxFindings?: number;
}

interface FileGroup {
  file: string;
  findings: FindingItem[];
}

function groupByFile(findings: FindingItem[]): FileGroup[] {
  const map = new Map<string, FindingItem[]>();
  for (const f of findings) {
    const key = f.file || '(no file)';
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(f);
  }
  return Array.from(map.entries())
    .map(([file, items]) => ({ file, findings: items }))
    .sort((a, b) => b.findings.length - a.findings.length);
}

function shortFile(filePath: string): string {
  const parts = filePath.split('/');
  if (parts.length <= 2) return filePath;
  return `…/${parts.slice(-2).join('/')}`;
}

export function FindingsPreview({
  findings,
  maxFiles = 8,
  maxFindings = 3,
}: FindingsPreviewProps): React.ReactElement {
  const groups = groupByFile(findings).slice(0, maxFiles);

  if (groups.length === 0) {
    return (
      <Panel title="FINDINGS" flexGrow={1} borderColor={colors.surface1}>
        <Text color={colors.green}>No findings</Text>
      </Panel>
    );
  }

  return (
    <Panel title="FINDINGS" flexGrow={1} borderColor={colors.surface1}>
      <Box flexDirection="column" marginTop={1}>
        {groups.map((group) => (
          <Box key={group.file} flexDirection="column">
            <Box flexDirection="row" gap={1}>
              <Text color={colors.textMuted}>{CHARS.expanded}</Text>
              <Text color={colors.text} bold>{shortFile(group.file)}</Text>
              <Text color={colors.textDim}>({group.findings.length})</Text>
            </Box>
            {group.findings.slice(0, maxFindings).map((f, i) => {
              const sev = f.severity.toUpperCase();
              return (
                <Box key={`${f.file}:${f.line}:${i}`} flexDirection="row" gap={1} paddingLeft={2}>
                  <Text color={severityColor(sev)}>{severityIcon(sev)}</Text>
                  <Text color={severityColor(sev)}>{sev.slice(0, 4).padEnd(4)}</Text>
                  {f.line != null && <Text color={colors.textDim}>L{f.line}</Text>}
                  <Text color={colors.subtext1} wrap="truncate">{f.message}</Text>
                </Box>
              );
            })}
            {group.findings.length > maxFindings && (
              <Box paddingLeft={3}>
                <Text color={colors.textDim}>
                  +{group.findings.length - maxFindings} more
                </Text>
              </Box>
            )}
          </Box>
        ))}
      </Box>
    </Panel>
  );
}
