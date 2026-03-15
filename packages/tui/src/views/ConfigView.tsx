import { defaultRegistry } from '@mmbridge/adapters';
import { DEFAULT_CLASSIFIERS, commandExists, loadConfig, resolveClassifiers } from '@mmbridge/core';
import type { MmbridgeConfig } from '@mmbridge/core';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import type React from 'react';
import { useEffect, useState } from 'react';
import { KVRow } from '../components/KVRow.js';
import { Panel } from '../components/Panel.js';
import { useTui } from '../store.js';
import { ADAPTER_NAMES, CHARS, colors, toolColor } from '../theme.js';

const SETTINGS_ITEMS = ['classifiers', 'redaction', 'context', 'bridge'] as const;
type SettingsItem = (typeof SETTINGS_ITEMS)[number];

export function ConfigView(): React.ReactElement {
  const [state, dispatch] = useTui();
  const { config, adapters } = state;

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [configData, setConfigData] = useState<MmbridgeConfig | null>(null);
  const [classifierCount, setClassifierCount] = useState(DEFAULT_CLASSIFIERS.length);

  useEffect(() => {
    const load = async (): Promise<void> => {
      try {
        const cfg = await loadConfig(process.cwd());
        setConfigData(cfg);
        const rules = resolveClassifiers(cfg);
        setClassifierCount(rules.length);
      } catch {
        setConfigData(null);
      }
    };
    load();
  }, []);

  const selectedAdapter = ADAPTER_NAMES[config.selectedSection === 'adapters' ? config.selectedIndex : 0] ?? 'kimi';

  const selectedSetting: SettingsItem =
    config.selectedSection === 'settings' ? (SETTINGS_ITEMS[config.selectedIndex] ?? 'classifiers') : 'classifiers';

  const handleTest = async (): Promise<void> => {
    if (testing) return;
    setTesting(true);
    setTestResult(null);
    try {
      const adapter = defaultRegistry.get(selectedAdapter);
      if (!adapter) {
        setTestResult('Not registered');
        return;
      }
      const exists = await commandExists(adapter.binary);
      setTestResult(exists ? 'OK - binary found' : 'FAIL - binary not in PATH');
    } catch (err) {
      setTestResult(err instanceof Error ? err.message : 'Error');
    } finally {
      setTesting(false);
    }
  };

  const maxIndex = config.selectedSection === 'adapters' ? ADAPTER_NAMES.length - 1 : SETTINGS_ITEMS.length - 1;

  useInput((input, key) => {
    if (key.upArrow || input === 'k') {
      const next = Math.max(0, config.selectedIndex - 1);
      dispatch({ type: 'CONFIG_SELECT', index: next });
    }
    if (key.downArrow || input === 'j') {
      const next = Math.min(maxIndex, config.selectedIndex + 1);
      dispatch({ type: 'CONFIG_SELECT', index: next });
    }
    if (key.tab) {
      if (config.selectedSection === 'adapters') {
        dispatch({ type: 'CONFIG_SET_SECTION', section: 'settings' });
      } else {
        dispatch({ type: 'CONFIG_SET_SECTION', section: 'adapters' });
      }
    }
    if (key.return && config.selectedSection === 'adapters') {
      handleTest();
    }
  });

  const adapterInfo = adapters.find((a) => a.name === selectedAdapter);

  return (
    <Box flexDirection="row" width="100%" paddingY={1} gap={1}>
      {/* Left sidebar */}
      <Box flexDirection="column" width={26} paddingX={1}>
        <Text
          color={config.selectedSection === 'adapters' ? colors.text : colors.overlay1}
          bold={config.selectedSection === 'adapters'}
        >
          ADAPTERS
        </Text>
        <Box flexDirection="column" marginTop={1}>
          {ADAPTER_NAMES.map((adapter, i) => {
            const info = adapters.find((a) => a.name === adapter);
            const isSelected = config.selectedSection === 'adapters' && config.selectedIndex === i;
            const installed = info?.installed ?? false;
            return (
              <Box key={adapter} flexDirection="row" gap={1}>
                <Text color={isSelected ? colors.accent : colors.textDim}>{isSelected ? CHARS.selected : ' '}</Text>
                <Text color={toolColor(adapter)} bold={isSelected}>
                  {adapter.padEnd(8)}
                </Text>
                <Text color={installed ? colors.green : colors.red}>{installed ? CHARS.installed : CHARS.missing}</Text>
              </Box>
            );
          })}
        </Box>

        <Box flexDirection="column" marginTop={2}>
          <Text
            color={config.selectedSection === 'settings' ? colors.text : colors.overlay1}
            bold={config.selectedSection === 'settings'}
          >
            SETTINGS
          </Text>
          <Box flexDirection="column" marginTop={1}>
            {SETTINGS_ITEMS.map((s, i) => {
              const isSelected = config.selectedSection === 'settings' && config.selectedIndex === i;
              const badge =
                s === 'classifiers'
                  ? `${classifierCount} rules`
                  : s === 'redaction'
                    ? '9 patterns'
                    : s === 'context'
                      ? '128 KB max'
                      : 'standard';
              return (
                <Box key={s} flexDirection="row" gap={1}>
                  <Text color={isSelected ? colors.accent : colors.textDim}>{isSelected ? CHARS.selected : ' '}</Text>
                  <Text color={isSelected ? colors.text : colors.overlay1}>{s.padEnd(14)}</Text>
                  <Text color={colors.textDim}>{badge}</Text>
                </Box>
              );
            })}
          </Box>
        </Box>
      </Box>

      {/* Right detail panel */}
      <Panel
        title={config.selectedSection === 'adapters' ? selectedAdapter.toUpperCase() : selectedSetting.toUpperCase()}
      >
        {config.selectedSection === 'adapters' ? (
          <Box flexDirection="column" marginTop={1}>
            <KVRow label="Binary" value={adapterInfo?.binary ?? selectedAdapter} labelWidth={14} />
            <KVRow
              label="Status"
              value={(adapterInfo?.installed ?? false) ? 'Installed' : 'Not found'}
              valueColor={(adapterInfo?.installed ?? false) ? colors.green : colors.red}
              labelWidth={14}
            />
            <KVRow label="Sessions" value={String(adapterInfo?.sessionCount ?? 0)} labelWidth={14} />
            <KVRow
              label="Last test"
              value={testResult ?? 'never'}
              valueColor={
                testResult?.startsWith('OK')
                  ? colors.green
                  : testResult?.startsWith('FAIL')
                    ? colors.red
                    : colors.overlay1
              }
              labelWidth={14}
            />
            <Box marginTop={2}>
              {testing ? (
                <Box flexDirection="row" gap={1}>
                  <Text color={colors.yellow}>
                    <Spinner type="dots" />
                  </Text>
                  <Text color={colors.yellow}>Testing connection...</Text>
                </Box>
              ) : (
                <Text bold color={colors.accent}>
                  Enter TEST CONNECTION
                </Text>
              )}
            </Box>
          </Box>
        ) : (
          <Box flexDirection="column" marginTop={1}>
            {selectedSetting === 'classifiers' && (
              <>
                <KVRow label="Total rules" value={String(classifierCount)} labelWidth={14} />
                <KVRow label="Categories" value="API, Component, Hook, Test, ..." labelWidth={14} />
                <KVRow label="Source" value={configData ? 'config file' : 'defaults'} labelWidth={14} />
              </>
            )}
            {selectedSetting === 'redaction' && (
              <>
                <KVRow label="Patterns" value="9 active" labelWidth={14} />
                <KVRow label="Tokens" value="enabled" valueColor={colors.green} labelWidth={14} />
                <KVRow label="PII" value="enabled" valueColor={colors.green} labelWidth={14} />
                <KVRow label="Custom" value="(none)" labelWidth={14} />
              </>
            )}
            {selectedSetting === 'context' && (
              <>
                <KVRow label="Max size" value="128 KB" labelWidth={14} />
                <KVRow label="Include tests" value="true" labelWidth={14} />
                <KVRow label="Workspace" value="/tmp/mmctx-*" labelWidth={14} />
              </>
            )}
            {selectedSetting === 'bridge' && (
              <>
                <KVRow label="Profile" value="standard" labelWidth={14} />
                <KVRow label="Threshold" value="2 tools agree" labelWidth={14} />
                <KVRow label="Auth model" value="claude-sonnet" labelWidth={14} />
                <KVRow label="Timeout" value="120s" labelWidth={14} />
              </>
            )}
          </Box>
        )}
      </Panel>
    </Box>
  );
}
