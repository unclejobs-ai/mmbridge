import React, { useState, useCallback, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { colors, toolColor, severityColor, severityIcon, ADAPTER_NAMES, CHARS } from '../theme.js';
import { Panel } from '../components/Panel.js';
import { PromptInput } from '../components/PromptInput.js';
import { SeverityBar } from '../components/SeverityBar.js';
import { useTui, REVIEW_MODES } from '../store.js';
import type { FindingItem } from '../store.js';
import { groupFindingsByFile } from '../hooks/session-analytics.js';
import { countBySeverity } from '../utils/format.js';
import { useExportReport } from '../hooks/use-export.js';
import { useFollowup } from '../hooks/use-followup.js';

// ─── Navigation types ─────────────────────────────────────────────────────────

interface NavPosition {
  groupIndex: number;
  findingIndex: number | null;
}

function shortSeverityLabel(severity: string): string {
  const s = severity.toUpperCase();
  switch (s) {
    case 'CRITICAL': return 'CRITICAL';
    case 'WARNING':  return 'WARNING ';
    case 'REFACTOR': return 'REFACTOR';
    default:         return 'INFO    ';
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ReviewResults(): React.ReactElement {
  const [state, dispatch] = useTui();
  const { review } = state;

  const selectedTool = ADAPTER_NAMES[review.selectedTool] ?? 'kimi';
  const selectedMode = REVIEW_MODES[review.selectedMode] ?? 'review';

  const findings = review.result?.findings ?? [];
  const grouped = useMemo(() => groupFindingsByFile(findings), [findings]);

  const [expandedGroups, setExpandedGroups] = useState<Set<number>>(
    () => new Set(grouped.map((_, i) => i)),
  );
  const [nav, setNav] = useState<NavPosition>({ groupIndex: 0, findingIndex: null });

  const counts = countBySeverity(findings);

  const toggleGroup = useCallback((groupIndex: number): void => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupIndex)) {
        next.delete(groupIndex);
      } else {
        next.add(groupIndex);
      }
      return next;
    });
  }, []);

  const doExport = useExportReport(dispatch);
  const { submit: submitFollowup, cancel: cancelFollowup } = useFollowup(dispatch);

  const handleExport = useCallback(() => {
    doExport({
      summary: review.result?.summary ?? '',
      findings: review.result?.findings ?? [],
    });
  }, [doExport, review.result]);

  useInput((input, key) => {
    if (input === 'n') {
      dispatch({ type: 'REVIEW_COMPLETE', result: null });
      return;
    }

    if (input === 'f') {
      dispatch({ type: 'SHOW_TOAST', message: 'Followup: select from Sessions tab', toastType: 'info' });
      return;
    }

    if (input === 'e') {
      handleExport();
      return;
    }

    if (key.return) {
      if (nav.findingIndex === null) {
        toggleGroup(nav.groupIndex);
      }
      return;
    }

    if (input === 'j' || key.downArrow) {
      setNav((prev) => {
        const group = grouped[prev.groupIndex];
        if (!group) return prev;

        const isExpanded = expandedGroups.has(prev.groupIndex);

        if (prev.findingIndex === null) {
          // On group header: move into first finding if expanded
          if (isExpanded && group.findings.length > 0) {
            return { groupIndex: prev.groupIndex, findingIndex: 0 };
          }
          // Move to next group header
          if (prev.groupIndex < grouped.length - 1) {
            return { groupIndex: prev.groupIndex + 1, findingIndex: null };
          }
          return prev;
        }

        // On a finding: move to next finding or next group header
        if (prev.findingIndex < group.findings.length - 1) {
          return { groupIndex: prev.groupIndex, findingIndex: prev.findingIndex + 1 };
        }
        if (prev.groupIndex < grouped.length - 1) {
          return { groupIndex: prev.groupIndex + 1, findingIndex: null };
        }
        return prev;
      });
      return;
    }

    if (input === 'k' || key.upArrow) {
      setNav((prev) => {
        if (prev.findingIndex === null) {
          // On group header: move to previous group's last finding or its header
          if (prev.groupIndex === 0) return prev;
          const prevGroupIndex = prev.groupIndex - 1;
          const prevGroup = grouped[prevGroupIndex];
          const prevExpanded = expandedGroups.has(prevGroupIndex);
          if (prevGroup && prevExpanded && prevGroup.findings.length > 0) {
            return { groupIndex: prevGroupIndex, findingIndex: prevGroup.findings.length - 1 };
          }
          return { groupIndex: prevGroupIndex, findingIndex: null };
        }

        // On a finding: move up to previous finding or group header
        if (prev.findingIndex > 0) {
          return { groupIndex: prev.groupIndex, findingIndex: prev.findingIndex - 1 };
        }
        return { groupIndex: prev.groupIndex, findingIndex: null };
      });
    }
  });

  const headerSuffix = `${findings.length} finding${findings.length !== 1 ? 's' : ''} (${counts.critical}C ${counts.warning}W ${counts.info}I)`;

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1} gap={1} flexGrow={1}>
      {/* Header */}
      <Box flexDirection="row" gap={2}>
        <Text color={colors.green} bold>REVIEW COMPLETE</Text>
        <Text color={toolColor(selectedTool)} bold>{selectedTool}</Text>
        <Text color={colors.textMuted}>/</Text>
        <Text color={colors.text}>{selectedMode}</Text>
        <Text color={colors.textMuted}>— {headerSuffix}</Text>
      </Box>

      {/* Severity distribution */}
      <SeverityBar counts={counts} />

      {/* Findings panel */}
      <Panel title="FINDINGS" flexGrow={1}>
        <Box flexDirection="column" marginTop={1}>
          {grouped.length === 0 && (
            <Text color={colors.green}>No findings — all clear.</Text>
          )}
          {grouped.map((group, gi) => {
            const isExpanded = expandedGroups.has(gi);
            const isGroupSelected = nav.groupIndex === gi && nav.findingIndex === null;

            return (
              <Box key={group.file} flexDirection="column">
                {/* File group header */}
                <Box flexDirection="row" gap={1}>
                  <Text color={isGroupSelected ? colors.accent : colors.textMuted}>
                    {isExpanded ? CHARS.expanded : CHARS.collapsed}
                  </Text>
                  <Text
                    color={isGroupSelected ? colors.accent : colors.text}
                    bold={isGroupSelected}
                  >
                    {group.file}
                  </Text>
                  <Text color={colors.textMuted}>({group.findings.length})</Text>
                  {!isExpanded && (
                    <Text color={colors.textDim}> [collapsed]</Text>
                  )}
                </Box>

                {/* Findings within group */}
                {isExpanded &&
                  group.findings.map((f, fi) => {
                    const isFindingSelected =
                      nav.groupIndex === gi && nav.findingIndex === fi;
                    const sev = f.severity.toUpperCase();
                    const loc = f.line != null ? `L:${f.line}` : '';

                    return (
                      <Box
                        key={`${f.file}:${f.line ?? ''}:${fi}`}
                        flexDirection="row"
                        gap={1}
                        paddingLeft={2}
                      >
                        <Text color={isFindingSelected ? colors.accent : severityColor(sev)}>
                          {severityIcon(sev)}
                        </Text>
                        <Text
                          color={isFindingSelected ? colors.accent : severityColor(sev)}
                          bold={isFindingSelected}
                        >
                          {shortSeverityLabel(sev)}
                        </Text>
                        {loc !== '' && (
                          <Text color={colors.textMuted}>{loc}</Text>
                        )}
                        <Text color={isFindingSelected ? colors.text : colors.subtext1}>
                          {f.message}
                        </Text>
                      </Box>
                    );
                  })}
              </Box>
            );
          })}
        </Box>
      </Panel>

      {/* Followup input */}
      {state.inputMode === 'followup' && state.inputTarget && (
        <PromptInput
          label={`Followup (${state.inputTarget.tool})`}
          onSubmit={(prompt) => submitFollowup(state.inputTarget!.tool, state.inputTarget!.sessionId, prompt)}
          onCancel={cancelFollowup}
        />
      )}
    </Box>
  );
}
