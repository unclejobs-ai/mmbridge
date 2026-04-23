import { Box, Text, useApp, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import type React from 'react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { ReplOutputList } from '../components/ReplOutput.js';
import type { OutputEntry } from '../components/ReplOutput.js';
import { colors } from '../theme.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ReplCommandResult {
  type: 'success' | 'findings' | 'text' | 'error' | 'status';
  message?: string;
  content?: string;
  tool?: string;
  findings?: Array<{ severity: string; file: string; line: number | null; message: string }>;
  duration?: number;
  data?: Record<string, string>;
}

interface ReplViewProps {
  version?: string;
  onCommand: (command: string) => Promise<ReplCommandResult>;
  commandNames?: string[];
}

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_OUTPUT_LINES = 200;
const MAX_HISTORY = 500;

const DEFAULT_COMMANDS = [
  '/review',
  '/review --tool kimi',
  '/review --tool qwen',
  '/review --tool codex',
  '/review --tool all',
  '/security',
  '/followup',
  '/status',
  '/handoff',
  '/memory',
  '/doctor',
  '/gate',
  '/help',
  '/quit',
];

// ─── Main REPL view ─────────────────────────────────────────────────────────

export function ReplView({ version = '0.0.0', onCommand, commandNames }: ReplViewProps): React.ReactElement {
  const { exit } = useApp();
  const commands = commandNames ?? DEFAULT_COMMANDS;

  const [input, setInput] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [outputLines, setOutputLines] = useState<OutputEntry[]>([
    { type: 'text', text: `mmbridge v${version} — type /help for commands`, timestamp: Date.now() },
  ]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);

  const suggestions = useMemo(() => {
    if (!input.startsWith('/')) return [];
    return commands.filter((cmd) => cmd.startsWith(input) && cmd !== input);
  }, [input, commands]);

  const stateRef = useRef({ history, historyIndex, isProcessing });
  stateRef.current = { history, historyIndex, isProcessing };

  const pushLine = useCallback((line: OutputEntry) => {
    setOutputLines((prev) => [...prev.slice(-(MAX_OUTPUT_LINES - 1)), line]);
  }, []);

  const handleChange = useCallback((value: string) => {
    setInput(value);
    setHistoryIndex(-1);
    setSelectedSuggestion(0);
  }, []);

  const handleSubmit = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      if (stateRef.current.isProcessing) return;

      if (trimmed === '/quit' || trimmed === '/exit') {
        exit();
        return;
      }

      setInput('');
      setHistoryIndex(-1);
      setHistory((prev) => [trimmed, ...prev].slice(0, MAX_HISTORY));
      pushLine({ type: 'input', text: trimmed, timestamp: Date.now() });
      setIsProcessing(true);

      try {
        const result = await onCommand(trimmed);
        const ts = Date.now();
        switch (result.type) {
          case 'success':
            pushLine({ type: 'text', text: result.message ?? 'Done.', timestamp: ts });
            break;
          case 'text':
            pushLine({ type: 'text', text: result.content ?? '', timestamp: ts });
            break;
          case 'error':
            pushLine({ type: 'error', text: result.message ?? 'Unknown error', timestamp: ts });
            break;
          case 'findings':
            if (result.findings && result.tool) {
              pushLine({
                type: 'findings',
                tool: result.tool,
                findings: result.findings,
                duration: result.duration,
                timestamp: ts,
              });
            }
            break;
          case 'status':
            if (result.data) {
              pushLine({
                type: 'status',
                data: result.data,
                timestamp: ts,
              });
            }
            break;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        pushLine({ type: 'error', text: message, timestamp: Date.now() });
      } finally {
        setIsProcessing(false);
      }
    },
    [exit, onCommand, pushLine],
  );

  useInput((_rawInput, key) => {
    const { history: hist, historyIndex: idx, isProcessing: busy } = stateRef.current;

    if (key.escape && busy) {
      setIsProcessing(false);
      pushLine({ type: 'error', text: 'Command cancelled.', timestamp: Date.now() });
      return;
    }

    if (key.upArrow) {
      if (suggestions.length > 0) {
        setSelectedSuggestion((prev) => Math.max(0, prev - 1));
        return;
      }
      const next = Math.min(idx + 1, hist.length - 1);
      const val = hist[next];
      if (next >= 0 && val !== undefined) {
        setHistoryIndex(next);
        setInput(val);
      }
      return;
    }

    if (key.downArrow) {
      if (suggestions.length > 0) {
        setSelectedSuggestion((prev) => Math.min(suggestions.length - 1, prev + 1));
        return;
      }
      const next = idx - 1;
      if (next < 0) {
        setHistoryIndex(-1);
        setInput('');
      } else {
        const val = hist[next];
        if (val !== undefined) {
          setHistoryIndex(next);
          setInput(val);
        }
      }
      return;
    }

    if (key.tab && suggestions.length > 0) {
      const chosen = suggestions[selectedSuggestion];
      if (chosen !== undefined) {
        setInput(chosen);
        setSelectedSuggestion(0);
      }
    }
  });

  return (
    <Box flexDirection="column" width="100%" height="100%">
      <Box paddingX={1} borderStyle="single" borderColor={colors.border}>
        <Text color={colors.accent} bold>{`mmbridge v${version}`}</Text>
        {isProcessing && (
          <>
            <Text color={colors.textDim}>{'  '}</Text>
            <Text color={colors.yellow}>processing...</Text>
          </>
        )}
      </Box>

      <Box flexDirection="column" flexGrow={1} paddingX={1} overflowY="hidden">
        <ReplOutputList entries={outputLines} maxVisible={MAX_OUTPUT_LINES} />
      </Box>

      {suggestions.length > 0 && (
        <Box flexDirection="column" paddingX={2}>
          {suggestions.slice(0, 6).map((s, i) => (
            <Box key={s} flexDirection="row" gap={1}>
              <Text color={i === selectedSuggestion ? colors.accent : colors.textDim}>
                {i === selectedSuggestion ? '❯' : ' '}
              </Text>
              <Text color={i === selectedSuggestion ? colors.text : colors.textDim}>{s}</Text>
            </Box>
          ))}
        </Box>
      )}

      <Box flexDirection="row" gap={1} paddingX={1} borderStyle="single" borderColor={colors.border}>
        <Text color={isProcessing ? colors.yellow : colors.green} bold>
          {'mmbridge>'}
        </Text>
        {isProcessing ? (
          <Text color={colors.textDim}>running... (ESC to cancel)</Text>
        ) : (
          <TextInput
            value={input}
            onChange={handleChange}
            onSubmit={handleSubmit}
            placeholder="type a command or /help"
          />
        )}
      </Box>
    </Box>
  );
}
