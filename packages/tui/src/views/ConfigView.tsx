import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { RadioGroup } from '../components/RadioGroup.js';
import { InlineForm } from '../components/InlineForm.js';
import type { FormField } from '../components/InlineForm.js';

const colors = {
  green: '#22C55E',
  yellow: '#EAB308',
  red: '#EF4444',
  cyan: '#06B6D4',
  dim: '#64748B',
  text: '#F8FAFC',
  textMuted: '#94A3B8',
  surface: '#1E293B',
  borderFocus: '#22C55E',
  borderIdle: '#334155',
} as const;

const ADAPTERS = ['kimi', 'qwen', 'codex', 'gemini'] as const;
const SETTINGS = ['classifiers', 'redaction', 'context', 'bridge'] as const;

type Adapter = typeof ADAPTERS[number];
type Setting = typeof SETTINGS[number];

interface AdapterInfo {
  binary: string;
  installed: boolean;
  lastTested: string | null;
  latency: string | null;
}

const ADAPTER_INFO: Record<Adapter, AdapterInfo> = {
  kimi: { binary: 'kimi', installed: true, lastTested: '1.2s ago', latency: '1.2s' },
  qwen: { binary: 'qwen', installed: true, lastTested: '3.4s ago', latency: '3.4s' },
  codex: { binary: 'codex', installed: false, lastTested: null, latency: null },
  gemini: { binary: 'opencode', installed: true, lastTested: '0.8s ago', latency: '0.8s' },
};

const SETTINGS_FIELDS: Record<Setting, FormField[]> = {
  classifiers: [
    { label: 'severity levels', value: 'critical, warning, info, refactor' },
    { label: 'custom patterns', value: '(none)', editable: true },
  ],
  redaction: [
    { label: 'redact tokens', value: 'enabled' },
    { label: 'redact PII', value: 'enabled' },
    { label: 'custom rules', value: '(none)', editable: true },
  ],
  context: [
    { label: 'max files', value: '200' },
    { label: 'context window', value: '128k' },
    { label: 'include tests', value: 'true' },
  ],
  bridge: [
    { label: 'workspace dir', value: '/tmp/mmctx-*' },
    { label: 'auth model', value: 'claude-sonnet' },
    { label: 'timeout', value: '120s' },
  ],
};

type SelectionState =
  | { section: 'adapters'; index: number }
  | { section: 'settings'; index: number };

function AdapterDetailPanel({
  adapter,
  testing,
}: {
  adapter: Adapter;
  testing: boolean;
}): React.ReactElement {
  const info = ADAPTER_INFO[adapter];
  const fields: FormField[] = [
    { label: 'Binary', value: info.binary },
    {
      label: 'Status',
      value: info.installed ? '✓ installed' : '✗ not installed',
    },
    {
      label: 'Connection test',
      value: info.lastTested != null
        ? `✓ ${info.lastTested}`
        : '(not tested)',
    },
    { label: 'Custom args', value: '(default)', editable: true },
  ];

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold color={colors.cyan}>
        {adapter.toUpperCase()} ADAPTER
      </Text>
      <InlineForm fields={fields} />
      <Box marginTop={1}>
        {testing ? (
          <Text color={colors.yellow}>Testing connection...</Text>
        ) : (
          <Text bold color={colors.green}>[ TEST CONNECTION ]</Text>
        )}
      </Box>
    </Box>
  );
}

function SettingDetailPanel({ setting }: { setting: Setting }): React.ReactElement {
  const fields = SETTINGS_FIELDS[setting];
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold color={colors.cyan}>
        {setting.toUpperCase()} SETTINGS
      </Text>
      <InlineForm fields={fields} />
    </Box>
  );
}

function SidebarPanel({
  selection,
  onSelectAdapter,
  onSelectSetting,
}: {
  selection: SelectionState;
  onSelectAdapter: (idx: number) => void;
  onSelectSetting: (idx: number) => void;
}): React.ReactElement {
  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={colors.borderIdle}
      paddingX={1}
      width={26}
    >
      <Text bold color={colors.textMuted}>ADAPTERS</Text>
      <Box flexDirection="column" marginBottom={1}>
        {ADAPTERS.map((adapter, i) => {
          const info = ADAPTER_INFO[adapter];
          const isSelected =
            selection.section === 'adapters' && selection.index === i;
          return (
            <Box key={adapter}>
              <Text color={isSelected ? colors.green : colors.dim}>
                {isSelected ? '●' : '○'}
              </Text>
              <Text> </Text>
              <Text color={colors.text}>{adapter}</Text>
              <Text>{'  '}</Text>
              <Text color={info.installed ? colors.green : colors.red}>
                {info.installed ? '✓' : '✗'}
              </Text>
            </Box>
          );
        })}
      </Box>
      <Text bold color={colors.textMuted}>SETTINGS</Text>
      <RadioGroup
        items={[...SETTINGS]}
        selected={selection.section === 'settings' ? selection.index : -1}
        focused={selection.section === 'settings'}
        onChange={onSelectSetting}
      />
    </Box>
  );
}

export function ConfigView(): React.ReactElement {
  const [selection, setSelection] = useState<SelectionState>({
    section: 'adapters',
    index: 0,
  });
  const [testing, setTesting] = useState(false);

  const currentAdapter: Adapter =
    selection.section === 'adapters'
      ? (ADAPTERS[selection.index] ?? 'kimi')
      : 'kimi';

  const currentSetting: Setting =
    selection.section === 'settings'
      ? (SETTINGS[selection.index] ?? 'classifiers')
      : 'classifiers';

  const handleTest = (): void => {
    if (testing) return;
    setTesting(true);
    setTimeout(() => setTesting(false), 1500);
  };

  const selectAdapter = (idx: number): void => {
    setSelection({ section: 'adapters', index: idx });
  };

  const selectSetting = (idx: number): void => {
    setSelection({ section: 'settings', index: idx });
  };

  useInput((_input, key) => {
    if (key.upArrow || key.downArrow) {
      const dir = key.downArrow ? 1 : -1;
      if (selection.section === 'adapters') {
        const next = Math.max(0, Math.min(ADAPTERS.length - 1, selection.index + dir));
        setSelection({ section: 'adapters', index: next });
      } else {
        const next = Math.max(0, Math.min(SETTINGS.length - 1, selection.index + dir));
        setSelection({ section: 'settings', index: next });
      }
    }
    if (key.tab) {
      if (selection.section === 'adapters') {
        setSelection({ section: 'settings', index: 0 });
      } else {
        setSelection({ section: 'adapters', index: 0 });
      }
    }
    if (key.return && selection.section === 'adapters') {
      handleTest();
    }
  });

  return (
    <Box flexDirection="row" gap={1} padding={1}>
      <SidebarPanel
        selection={selection}
        onSelectAdapter={selectAdapter}
        onSelectSetting={selectSetting}
      />
      <Box
        flexDirection="column"
        borderStyle="single"
        borderColor={colors.borderIdle}
        paddingX={2}
        paddingY={1}
        flexGrow={1}
      >
        {selection.section === 'adapters' && (
          <AdapterDetailPanel
            adapter={currentAdapter}
            testing={testing}
          />
        )}
        {selection.section === 'settings' && (
          <SettingDetailPanel setting={currentSetting} />
        )}
      </Box>
    </Box>
  );
}
