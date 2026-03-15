import { Box, Text } from 'ink';
import type React from 'react';
import type { FindingItem } from '../store.js';
import { CHARS, colors, severityColor, severityIcon } from '../theme.js';
import { Panel } from './Panel.js';

interface FindingsPreviewProps {
  findings: FindingItem[];
  selectedIndex?: number;
  windowSize?: number;
}

function shortFile(filePath: string): string {
  const parts = filePath.split('/');
  if (parts.length <= 2) return filePath;
  return `…/${parts.slice(-2).join('/')}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function statusText(status?: FindingItem['status']): { label: string; color: string } | null {
  if (status === 'accepted') return { label: 'accepted', color: colors.green };
  if (status === 'dismissed') return { label: 'dismissed', color: colors.red };
  return null;
}

export function FindingsPreview({
  findings,
  selectedIndex = 0,
  windowSize = 7,
}: FindingsPreviewProps): React.ReactElement {
  if (findings.length === 0) {
    return (
      <Panel title="FINDINGS" flexGrow={1} borderColor={colors.surface1}>
        <Text color={colors.green}>No findings</Text>
      </Panel>
    );
  }

  const clampedIndex = clamp(selectedIndex, 0, findings.length - 1);
  const selected = findings[clampedIndex] ?? findings[0];
  const start = Math.max(0, clampedIndex - Math.floor(windowSize / 2));
  const visible = findings.slice(start, start + windowSize);
  const selectedSeverity = (selected?.severity ?? 'INFO').toUpperCase();
  const selectedStatus = statusText(selected?.status);

  return (
    <Panel title={`FINDINGS (${findings.length})`} flexGrow={1} borderColor={colors.surface1}>
      <Box flexDirection="column" marginTop={1} gap={1}>
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Text color={severityColor(selectedSeverity)}>{severityIcon(selectedSeverity)}</Text>
            <Text color={severityColor(selectedSeverity)} bold>
              {selectedSeverity}
            </Text>
            {selected?.line != null && <Text color={colors.textDim}>L{selected.line}</Text>}
            {selectedStatus && <Text color={selectedStatus.color}>[{selectedStatus.label}]</Text>}
          </Box>
          <Text color={colors.text} bold wrap="truncate">
            {selected?.file || '(no file)'}
          </Text>
          <Text color={colors.subtext1}>{selected?.message ?? ''}</Text>
        </Box>

        <Box flexDirection="column">
          {visible.map((finding, index) => {
            const absoluteIndex = start + index;
            const sev = finding.severity.toUpperCase();
            const isSelected = absoluteIndex === clampedIndex;
            const rowStatus = statusText(finding.status);
            return (
              <Box key={`${finding.file}:${finding.line}:${absoluteIndex}`} flexDirection="row" gap={1}>
                <Text color={isSelected ? colors.accent : colors.textDim}>{isSelected ? CHARS.selected : ' '}</Text>
                <Text color={severityColor(sev)}>{severityIcon(sev)}</Text>
                <Text color={severityColor(sev)}>{sev.slice(0, 4).padEnd(4)}</Text>
                <Text color={isSelected ? colors.text : colors.overlay1}>{shortFile(finding.file || '(no file)')}</Text>
                {finding.line != null && <Text color={colors.textDim}>L{finding.line}</Text>}
                {rowStatus && <Text color={rowStatus.color}>[{rowStatus.label[0]?.toUpperCase()}]</Text>}
              </Box>
            );
          })}
        </Box>

        <Text color={colors.textDim}>
          [{clampedIndex + 1}/{findings.length}] [ / ] nav a accept z dismiss u clear
        </Text>
      </Box>
    </Panel>
  );
}
