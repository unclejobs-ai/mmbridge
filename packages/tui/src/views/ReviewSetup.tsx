import React, { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import { getDefaultBaseRef, getChangedFiles, classifyFile, runReviewPipeline } from '@mmbridge/core';
import { runReviewAdapter, defaultRegistry } from '@mmbridge/adapters';
import { SessionStore } from '@mmbridge/session-store';
import { colors, toolColor, ADAPTER_NAMES, CHARS } from '../theme.js';
import { Panel } from '../components/Panel.js';
import { MiniBar } from '../components/MiniBar.js';
import { useTui, REVIEW_MODES } from '../store.js';
import type { FindingItem } from '../store.js';

const CATEGORY_COLORS: Record<string, string> = {
  'API':        colors.blue,
  'Component':  colors.mauve,
  'Library':    colors.teal,
  'Config':     colors.peach,
  'Test':       colors.green,
  'Migration':  colors.yellow,
  'Script':     colors.sapphire,
  'Other':      colors.overlay2,
};

function categoryColor(cat: string): string {
  return CATEGORY_COLORS[cat] ?? colors.overlay2;
}

export function ReviewSetup(): React.ReactElement {
  const [state, dispatch] = useTui();
  const { review, adapters } = state;
  const [fileCount, setFileCount] = useState<number | null>(null);
  const [categories, setCategories] = useState<Record<string, number>>({});

  const selectedTool = ADAPTER_NAMES[review.selectedTool] ?? 'kimi';
  const selectedMode = REVIEW_MODES[review.selectedMode] ?? 'review';
  const adapterInfo = adapters.find((a) => a.name === selectedTool);
  const isInstalled = adapterInfo?.installed ?? false;

  React.useEffect(() => {
    const load = async (): Promise<void> => {
      try {
        const base = await getDefaultBaseRef();
        const files = await getChangedFiles(base);
        setFileCount(files.length);

        const cats: Record<string, number> = {};
        for (const f of files) {
          const cat = classifyFile(f);
          cats[cat] = (cats[cat] ?? 0) + 1;
        }
        setCategories(cats);
      } catch {
        setFileCount(null);
        setCategories({});
      }
    };
    load();
  }, []);

  const startReview = useCallback(async (): Promise<void> => {
    if (review.running) return;
    if (!review.bridgeMode && !isInstalled) return;

    dispatch({ type: 'REVIEW_START' });
    const startTime = Date.now();
    const sessionStore = new SessionStore();

    try {
      const tool = review.bridgeMode ? 'all' : selectedTool;

      // Initialize bridge tool progress indicators
      if (review.bridgeMode) {
        for (const a of adapters.filter((a) => a.installed)) {
          dispatch({ type: 'REVIEW_BRIDGE_TOOL_PROGRESS', tool: a.name, status: 'pending' });
        }
      }

      const result = await runReviewPipeline({
        tool,
        mode: selectedMode,
        projectDir: process.cwd(),
        bridge: review.bridgeMode ? 'interpreted' : 'none',
        runAdapter: runReviewAdapter,
        listInstalledTools: () => defaultRegistry.listInstalled(),
        saveSession: (data) => sessionStore.save(data),
        onProgress: (phase, detail) => {
          const elapsed = (Date.now() - startTime) / 1000;
          const mappedPhase = phase as 'context' | 'redact' | 'review' | 'enrich' | 'bridge';
          dispatch({ type: 'REVIEW_PROGRESS', progress: detail, elapsed, phase: mappedPhase });

          // Update bridge tool progress from detail string
          if (review.bridgeMode && phase === 'review') {
            const match = detail.match(/^(\w+): (start|done|error)$/);
            if (match) {
              const status = match[2] === 'start' ? 'running' : match[2] as 'done' | 'error';
              dispatch({ type: 'REVIEW_BRIDGE_TOOL_PROGRESS', tool: match[1], status });
            }
          }
        },
        onStdout: (_tool, chunk) => {
          dispatch({ type: 'REVIEW_STREAM_CHUNK', chunk });
        },
      });

      const findings: FindingItem[] = result.findings.map((f) => ({
        severity: f.severity,
        file: f.file,
        line: f.line ?? null,
        message: f.message,
      }));

      dispatch({ type: 'REVIEW_COMPLETE', result: { summary: result.summary, findings } });
      dispatch({
        type: 'SHOW_TOAST',
        message: `Review complete: ${findings.length} finding${findings.length !== 1 ? 's' : ''}`,
        toastType: findings.some((f) => f.severity === 'CRITICAL') ? 'error' : 'success',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      dispatch({ type: 'REVIEW_COMPLETE', result: { summary: `Error: ${message}`, findings: [] } });
      dispatch({ type: 'SHOW_TOAST', message: `Review failed: ${message.slice(0, 60)}`, toastType: 'error' });
    }
  }, [dispatch, adapters, isInstalled, review.bridgeMode, review.running, selectedMode, selectedTool]);

  useInput((input, key) => {
    if (input === 'h' || key.leftArrow) dispatch({ type: 'REVIEW_SET_FOCUS_COLUMN', column: 'tool' });
    if (input === 'l' || key.rightArrow) dispatch({ type: 'REVIEW_SET_FOCUS_COLUMN', column: 'mode' });

    if (input === 'j' || key.downArrow) {
      if (review.focusColumn === 'tool') {
        dispatch({ type: 'REVIEW_SET_TOOL', index: Math.min(ADAPTER_NAMES.length - 1, review.selectedTool + 1) });
      } else {
        dispatch({ type: 'REVIEW_SET_MODE', index: Math.min(REVIEW_MODES.length - 1, review.selectedMode + 1) });
      }
    }
    if (input === 'k' || key.upArrow) {
      if (review.focusColumn === 'tool') {
        dispatch({ type: 'REVIEW_SET_TOOL', index: Math.max(0, review.selectedTool - 1) });
      } else {
        dispatch({ type: 'REVIEW_SET_MODE', index: Math.max(0, review.selectedMode - 1) });
      }
    }

    if (input === 'b') dispatch({ type: 'REVIEW_TOGGLE_BRIDGE' });
    if (key.return) startReview();
  });

  const miniBarItems = Object.entries(categories).map(([cat, count]) => ({
    label: cat,
    value: count,
    color: categoryColor(cat),
  }));

  const focusTool = review.focusColumn === 'tool';
  const focusMode = review.focusColumn === 'mode';

  return (
    <Box flexDirection="row" width="100%" paddingY={1} gap={1}>
      {/* Tool column */}
      <Panel title="TOOL" width={22} borderColor={focusTool ? colors.accent : colors.surface0}>
        <Box flexDirection="column" marginTop={1}>
          {ADAPTER_NAMES.map((tool, i) => {
            const isSelected = i === review.selectedTool;
            const installed = adapters.find((a) => a.name === tool)?.installed ?? false;
            const isCursor = isSelected && focusTool;
            return (
              <Box key={tool} flexDirection="row" gap={1}>
                <Text color={isCursor ? colors.accent : colors.textDim}>
                  {isCursor ? CHARS.selected : ' '}
                </Text>
                <Text color={isSelected ? colors.green : colors.textDim}>
                  {isSelected ? CHARS.radioOn : CHARS.radioOff}
                </Text>
                <Text color={installed ? toolColor(tool) : colors.textDim} bold={isSelected} strikethrough={!installed}>
                  {tool}
                </Text>
                <Text color={installed ? colors.green : colors.red}>{installed ? CHARS.installed : CHARS.missing}</Text>
              </Box>
            );
          })}
        </Box>
      </Panel>

      {/* Mode column */}
      <Panel title="MODE" width={18} borderColor={focusMode ? colors.accent : colors.surface0}>
        <Box flexDirection="column" marginTop={1}>
          {REVIEW_MODES.map((mode, i) => {
            const isSelected = i === review.selectedMode;
            const isCursor = isSelected && focusMode;
            return (
              <Box key={mode} flexDirection="row" gap={1}>
                <Text color={isCursor ? colors.accent : colors.textDim}>{isCursor ? CHARS.selected : ' '}</Text>
                <Text color={isSelected ? colors.green : colors.textDim}>{isSelected ? CHARS.radioOn : CHARS.radioOff}</Text>
                <Text color={isSelected ? colors.text : colors.textMuted} bold={isSelected}>{mode}</Text>
              </Box>
            );
          })}
        </Box>
      </Panel>

      {/* Context preview + actions */}
      <Panel title="CONTEXT" flexGrow={1} borderColor={colors.surface0}>
        <Box flexDirection="column" marginTop={1} gap={1}>
          <Text color={colors.text}>
            {fileCount !== null ? `${fileCount} files changed` : 'scanning...'}
          </Text>
          {miniBarItems.length > 0 && (
            <Box flexDirection="row" flexWrap="wrap" gap={1}>
              {miniBarItems.slice(0, 6).map((item) => (
                <Text key={item.label} color={item.color}>{item.label}({item.value})</Text>
              ))}
            </Box>
          )}
          <Box flexDirection="row" gap={1}>
            <Text color={review.bridgeMode ? colors.green : colors.textDim}>
              {review.bridgeMode ? CHARS.radioOn : CHARS.radioOff}
            </Text>
            <Text color={review.bridgeMode ? colors.accent : colors.textMuted}>
              Bridge {review.bridgeMode ? 'ON' : 'OFF'}
            </Text>
          </Box>
          {review.bridgeMode || isInstalled ? (
            <Text bold color={colors.green}>Enter START  |  b Bridge</Text>
          ) : (
            <Text color={colors.red}>Tool not installed</Text>
          )}
        </Box>
      </Panel>
    </Box>
  );
}
