import { defaultRegistry, initRegistry } from '@mmbridge/adapters';
import { DEFAULT_CLASSIFIERS, commandExists, loadConfig, resolveClassifiers, saveConfig } from '@mmbridge/core';
import type { MmbridgeConfig } from '@mmbridge/core';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { KVRow } from '../components/KVRow.js';
import { Panel } from '../components/Panel.js';
import { PromptInput } from '../components/PromptInput.js';
import { deriveAdapterActivity } from '../hooks/session-analytics.js';
import { useTui } from '../store.js';
import { ADAPTER_NAMES, CHARS, colors, toolColor } from '../theme.js';

const SETTINGS_ITEMS = ['classifiers', 'redaction', 'context', 'bridge'] as const;
const DEFAULT_MAX_CONTEXT_BYTES = 2 * 1024 * 1024;

type SettingsItem = (typeof SETTINGS_ITEMS)[number];
type ConfigStatus = 'loading' | 'ready' | 'error';
type EditorState = {
  kind: 'adapter-command' | 'context-max-bytes' | 'redaction-rule';
  label: string;
  initialValue?: string;
  placeholder?: string;
} | null;

export function canBeginConfigInteraction(input: {
  configStatus: ConfigStatus;
  saving: boolean;
  testing: boolean;
}): boolean {
  return input.configStatus === 'ready' && !input.saving && !input.testing;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    const mb = bytes / (1024 * 1024);
    return `${Number.isInteger(mb) ? mb.toFixed(0) : mb.toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    const kb = bytes / 1024;
    return `${Number.isInteger(kb) ? kb.toFixed(0) : kb.toFixed(1)} KB`;
  }
  return `${bytes} B`;
}

function parseByteInput(value: string): number | null {
  const normalized = value.trim().toLowerCase();
  const match = normalized.match(/^(\d+)(kb|mb|b)?$/);
  if (!match) return null;

  const amount = Number.parseInt(match[1] ?? '', 10);
  const unit = match[2] ?? 'b';
  if (!Number.isFinite(amount) || amount <= 0) return null;

  switch (unit) {
    case 'mb':
      return amount * 1024 * 1024;
    case 'kb':
      return amount * 1024;
    default:
      return amount;
  }
}

function normalizeConfig(config: MmbridgeConfig): MmbridgeConfig {
  const next: MmbridgeConfig = { ...config };

  if (next.adapters) {
    const cleaned = Object.fromEntries(
      Object.entries(next.adapters).filter(([, value]) => {
        const hasCommand = typeof value.command === 'string' && value.command.trim().length > 0;
        const hasModule = typeof value.module === 'string' && value.module.trim().length > 0;
        const hasArgs = Array.isArray(value.args) && value.args.length > 0;
        return hasCommand || hasModule || hasArgs;
      }),
    );
    next.adapters = Object.keys(cleaned).length > 0 ? cleaned : undefined;
  }

  if (next.redaction?.extraRules && next.redaction.extraRules.length === 0) {
    next.redaction = undefined;
  }

  if (next.context?.maxBytes === undefined) {
    next.context = undefined;
  }

  if (next.bridge?.mode === undefined && next.bridge?.profile === undefined) {
    next.bridge = undefined;
  }

  return next;
}

export function ConfigView(): React.ReactElement {
  const [state, dispatch] = useTui();
  const { config, adapters, sessions } = state;

  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [configData, setConfigData] = useState<MmbridgeConfig>({});
  const [configStatus, setConfigStatus] = useState<ConfigStatus>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState>(null);
  const reloadIdRef = useRef(0);

  const projectDir = process.cwd();
  const adapterActivity = useMemo(() => deriveAdapterActivity(sessions), [sessions]);
  const canMutateConfig = canBeginConfigInteraction({ configStatus, saving, testing });

  const reloadConfig = useCallback(async (): Promise<void> => {
    const reloadId = reloadIdRef.current + 1;
    reloadIdRef.current = reloadId;
    setConfigStatus('loading');
    try {
      const nextConfig = await loadConfig(projectDir);
      if (reloadId !== reloadIdRef.current) return;
      setConfigData(nextConfig);
      setConfigStatus('ready');
      setLoadError(null);
    } catch (err) {
      if (reloadId !== reloadIdRef.current) return;
      setConfigData({});
      setConfigStatus('error');
      setLoadError(err instanceof Error ? err.message : 'Failed to load config');
    }
  }, [projectDir]);

  useEffect(() => {
    void reloadConfig();
  }, [reloadConfig]);

  const selectedAdapter = ADAPTER_NAMES[config.selectedSection === 'adapters' ? config.selectedIndex : 0] ?? 'kimi';
  const selectedSetting: SettingsItem =
    config.selectedSection === 'settings' ? (SETTINGS_ITEMS[config.selectedIndex] ?? 'classifiers') : 'classifiers';

  const resolvedClassifiers = resolveClassifiers(configData);
  const customClassifiers = configData.classifiers ?? [];
  const customRedactionRules = configData.redaction?.extraRules ?? [];
  const contextMaxBytes = configData.context?.maxBytes ?? DEFAULT_MAX_CONTEXT_BYTES;
  const bridgeMode = configData.bridge?.mode ?? 'standard';
  const bridgeProfile = configData.bridge?.profile ?? 'standard';
  const adapterOverrideCount = Object.values(configData.adapters ?? {}).filter(
    (value) =>
      Boolean(value.command?.trim()) ||
      Boolean(value.module?.trim()) ||
      Boolean(Array.isArray(value.args) && value.args.length > 0),
  ).length;
  const selectedAdapterConfig = configData.adapters?.[selectedAdapter];
  const selectedAdapterBinary =
    selectedAdapterConfig?.command ?? adapters.find((a) => a.name === selectedAdapter)?.binary ?? selectedAdapter;
  const installedAdapterCount = adapters.filter((adapter) => adapter.installed).length;
  const bridgeReady = installedAdapterCount >= 2;
  const classifierCategories = [...new Set(resolvedClassifiers.map((rule) => rule.category))];
  const selectedAdapterInfo = adapters.find((adapter) => adapter.name === selectedAdapter);
  const selectedAdapterActivity = adapterActivity[selectedAdapter] ?? { sessionCount: 0, lastSessionDate: null };

  const refreshAdapterStatuses = async (): Promise<void> => {
    const adapterStatuses = await Promise.all(
      ADAPTER_NAMES.map(async (name) => {
        const adapter = defaultRegistry.get(name);
        const binary = adapter?.binary ?? name;
        const installed = await commandExists(binary).catch(() => false);
        return {
          name,
          binary,
          installed,
        };
      }),
    );

    dispatch({ type: 'SET_ADAPTERS', adapters: adapterStatuses });
  };

  const persistConfig = async (nextConfig: MmbridgeConfig, successMessage: string): Promise<void> => {
    setSaving(true);
    try {
      const normalized = normalizeConfig(nextConfig);
      await saveConfig(projectDir, normalized);
      await initRegistry(projectDir, true);
      await reloadConfig();
      await refreshAdapterStatuses();
      setTestResult(null);
      dispatch({ type: 'SHOW_TOAST', message: successMessage, toastType: 'success' });
    } catch (err) {
      dispatch({
        type: 'SHOW_TOAST',
        message: err instanceof Error ? err.message : 'Failed to save config',
        toastType: 'error',
      });
    } finally {
      setSaving(false);
    }
  };

  const beginEdit = (nextEditor: NonNullable<EditorState>): void => {
    if (!canMutateConfig) {
      dispatch({
        type: 'SHOW_TOAST',
        message:
          configStatus === 'error'
            ? 'Fix config load error before editing settings'
            : 'Wait for config to finish loading',
        toastType: 'error',
      });
      return;
    }
    setEditor(nextEditor);
    dispatch({ type: 'START_CONFIG_EDIT' });
  };

  const cancelEdit = (): void => {
    setEditor(null);
    dispatch({ type: 'CANCEL_INPUT' });
  };

  const completeEdit = (): void => {
    setEditor(null);
    dispatch({ type: 'COMPLETE_INPUT' });
  };

  const handleTest = async (): Promise<void> => {
    if (testing || saving) return;
    setTesting(true);
    setTestResult(null);
    try {
      const adapter = defaultRegistry.get(selectedAdapter);
      if (!adapter) {
        setTestResult('Not registered');
        return;
      }
      const exists = await commandExists(adapter.binary);
      setTestResult(exists ? `OK - ${adapter.binary}` : `FAIL - ${adapter.binary}`);
    } catch (err) {
      setTestResult(err instanceof Error ? err.message : 'Error');
    } finally {
      setTesting(false);
    }
  };

  const handleEditorSubmit = async (value: string): Promise<void> => {
    if (!editor || !canMutateConfig) return;

    if (editor.kind === 'adapter-command') {
      const nextConfig: MmbridgeConfig = {
        ...configData,
        adapters: {
          ...(configData.adapters ?? {}),
          [selectedAdapter]: {
            ...(configData.adapters?.[selectedAdapter] ?? {}),
            command: value,
          },
        },
      };
      completeEdit();
      await persistConfig(nextConfig, `Saved ${selectedAdapter} command override`);
      return;
    }

    if (editor.kind === 'context-max-bytes') {
      const parsed = parseByteInput(value);
      if (!parsed) {
        dispatch({
          type: 'SHOW_TOAST',
          message: 'Use a positive byte value like 262144, 256kb, or 2mb',
          toastType: 'error',
        });
        return;
      }

      completeEdit();
      await persistConfig(
        {
          ...configData,
          context: {
            ...(configData.context ?? {}),
            maxBytes: parsed,
          },
        },
        `Saved context limit: ${formatBytes(parsed)}`,
      );
      return;
    }

    const parts = value.split('|').map((part) => part.trim());
    if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
      dispatch({
        type: 'SHOW_TOAST',
        message: 'Use pattern|replacement|label',
        toastType: 'error',
      });
      return;
    }

    const [pattern, replacement, label] = parts;
    completeEdit();
    await persistConfig(
      {
        ...configData,
        redaction: {
          extraRules: [...customRedactionRules, { pattern, replacement, label }],
        },
      },
      `Added redaction rule: ${label}`,
    );
  };

  const clearAdapterOverride = async (): Promise<void> => {
    if (!selectedAdapterConfig?.command || !canMutateConfig) return;

    const nextAdapters = { ...(configData.adapters ?? {}) };
    const { command: _removed, ...nextSelected } = {
      ...(nextAdapters[selectedAdapter] ?? {}),
    };
    nextAdapters[selectedAdapter] = nextSelected;

    await persistConfig({ ...configData, adapters: nextAdapters }, `Cleared ${selectedAdapter} command override`);
  };

  const clearRedactionRules = async (): Promise<void> => {
    if (customRedactionRules.length === 0 || !canMutateConfig) return;
    await persistConfig(
      {
        ...configData,
        redaction: {
          extraRules: [],
        },
      },
      'Cleared custom redaction rules',
    );
  };

  const resetContextLimit = async (): Promise<void> => {
    if (configData.context?.maxBytes === undefined || !canMutateConfig) return;
    await persistConfig(
      {
        ...configData,
        context: {
          ...(configData.context ?? {}),
          maxBytes: undefined,
        },
      },
      `Reset context limit to default ${formatBytes(DEFAULT_MAX_CONTEXT_BYTES)}`,
    );
  };

  const toggleBridgeMode = async (): Promise<void> => {
    if (!canMutateConfig) return;
    const nextMode = bridgeMode === 'interpreted' ? 'standard' : 'interpreted';
    await persistConfig(
      {
        ...configData,
        bridge: {
          ...(configData.bridge ?? {}),
          mode: nextMode,
        },
      },
      `Bridge mode set to ${nextMode}`,
    );
  };

  const cycleBridgeProfile = async (): Promise<void> => {
    if (!canMutateConfig) return;
    const profiles: Array<'standard' | 'strict' | 'relaxed'> = ['standard', 'strict', 'relaxed'];
    const currentIndex = profiles.indexOf(bridgeProfile);
    const nextProfile = profiles[(currentIndex + 1) % profiles.length] ?? 'standard';

    await persistConfig(
      {
        ...configData,
        bridge: {
          ...(configData.bridge ?? {}),
          profile: nextProfile,
        },
      },
      `Bridge profile set to ${nextProfile}`,
    );
  };

  const toggleClassifierDefaults = async (): Promise<void> => {
    if (!canMutateConfig) return;
    const nextValue = configData.extendDefaultClassifiers === false;
    await persistConfig(
      {
        ...configData,
        extendDefaultClassifiers: nextValue,
      },
      `Default classifiers ${nextValue ? 'enabled' : 'disabled'}`,
    );
  };

  const maxIndex = config.selectedSection === 'adapters' ? ADAPTER_NAMES.length - 1 : SETTINGS_ITEMS.length - 1;

  useInput((input, key) => {
    if (editor) return;

    if (key.upArrow || input === 'k') {
      dispatch({ type: 'CONFIG_SELECT', index: Math.max(0, config.selectedIndex - 1) });
      return;
    }

    if (key.downArrow || input === 'j') {
      dispatch({ type: 'CONFIG_SELECT', index: Math.min(maxIndex, config.selectedIndex + 1) });
      return;
    }

    if (key.tab) {
      dispatch({
        type: 'CONFIG_SET_SECTION',
        section: config.selectedSection === 'adapters' ? 'settings' : 'adapters',
      });
      return;
    }

    if (config.selectedSection === 'adapters') {
      if (key.return) {
        void handleTest();
        return;
      }
      if (input === 'e' || input === 'i') {
        beginEdit({
          kind: 'adapter-command',
          label: `${selectedAdapter} command`,
          initialValue: selectedAdapterConfig?.command ?? '',
          placeholder: 'e.g. kaku-kimi',
        });
        return;
      }
      if (input === 'x') {
        void clearAdapterOverride();
      }
      return;
    }

    if (key.return && selectedSetting === 'classifiers') {
      void toggleClassifierDefaults();
      return;
    }

    if ((key.return && selectedSetting === 'context') || (input === 'e' && selectedSetting === 'context')) {
      beginEdit({
        kind: 'context-max-bytes',
        label: 'context.maxBytes',
        initialValue: String(contextMaxBytes),
        placeholder: '262144 | 256kb | 2mb',
      });
      return;
    }

    if ((key.return && selectedSetting === 'redaction') || (input === 'e' && selectedSetting === 'redaction')) {
      beginEdit({
        kind: 'redaction-rule',
        label: 'pattern|replacement|label',
        placeholder: 'session_[A-Za-z0-9]+|[REDACTED]|Session token',
      });
      return;
    }

    if (input === 'x' && selectedSetting === 'context') {
      void resetContextLimit();
      return;
    }

    if (input === 'x' && selectedSetting === 'redaction') {
      void clearRedactionRules();
      return;
    }

    if (key.return && selectedSetting === 'bridge') {
      void toggleBridgeMode();
      return;
    }

    if (input === 'e' && selectedSetting === 'bridge') {
      void cycleBridgeProfile();
    }
  });

  const settingsBadge = (setting: SettingsItem): string => {
    switch (setting) {
      case 'classifiers':
        return `${resolvedClassifiers.length} rules`;
      case 'redaction':
        return `${customRedactionRules.length} custom`;
      case 'context':
        return formatBytes(contextMaxBytes);
      case 'bridge':
        return `${bridgeMode}/${bridgeProfile}`;
    }
  };

  return (
    <Box flexDirection="column" width="100%" paddingY={1}>
      <Box flexDirection="row" width="100%" gap={1}>
        <Box flexDirection="column" width={26} paddingX={1}>
          <Text
            color={config.selectedSection === 'adapters' ? colors.text : colors.overlay1}
            bold={config.selectedSection === 'adapters'}
          >
            ADAPTERS
          </Text>
          <Box flexDirection="column" marginTop={1}>
            {ADAPTER_NAMES.map((adapter, index) => {
              const info = adapters.find((item) => item.name === adapter);
              const isSelected = config.selectedSection === 'adapters' && config.selectedIndex === index;
              const installed = info?.installed ?? false;
              return (
                <Box key={adapter} flexDirection="row" gap={1}>
                  <Text color={isSelected ? colors.accent : colors.textDim}>{isSelected ? CHARS.selected : ' '}</Text>
                  <Text color={toolColor(adapter)} bold={isSelected}>
                    {adapter.padEnd(8)}
                  </Text>
                  <Text color={installed ? colors.green : colors.red}>
                    {installed ? CHARS.installed : CHARS.missing}
                  </Text>
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
              {SETTINGS_ITEMS.map((setting, index) => {
                const isSelected = config.selectedSection === 'settings' && config.selectedIndex === index;
                return (
                  <Box key={setting} flexDirection="row" gap={1}>
                    <Text color={isSelected ? colors.accent : colors.textDim}>{isSelected ? CHARS.selected : ' '}</Text>
                    <Text color={isSelected ? colors.text : colors.overlay1}>{setting.padEnd(14)}</Text>
                    <Text color={colors.textDim}>{settingsBadge(setting)}</Text>
                  </Box>
                );
              })}
            </Box>
          </Box>
        </Box>

        <Panel
          title={config.selectedSection === 'adapters' ? selectedAdapter.toUpperCase() : selectedSetting.toUpperCase()}
        >
          <Box flexDirection="column" marginTop={1}>
            {configStatus === 'loading' && (
              <Box flexDirection="row" gap={1}>
                <Text color={colors.yellow}>
                  <Spinner type="dots" />
                </Text>
                <Text color={colors.yellow}>Loading config...</Text>
              </Box>
            )}
            {loadError && <Text color={colors.red}>Config load error: {loadError}</Text>}

            {config.selectedSection === 'adapters' ? (
              <>
                <KVRow label="Binary" value={selectedAdapterBinary} labelWidth={16} />
                <KVRow
                  label="Status"
                  value={(selectedAdapterInfo?.installed ?? false) ? 'Installed' : 'Not found'}
                  valueColor={(selectedAdapterInfo?.installed ?? false) ? colors.green : colors.red}
                  labelWidth={16}
                />
                <KVRow label="Sessions" value={String(selectedAdapterActivity.sessionCount)} labelWidth={16} />
                <KVRow
                  label="Override"
                  value={selectedAdapterConfig?.command ?? '(default)'}
                  valueColor={selectedAdapterConfig?.command ? colors.yellow : colors.overlay1}
                  labelWidth={16}
                />
                <KVRow
                  label="Last test"
                  value={testResult ?? 'not run'}
                  valueColor={
                    testResult?.startsWith('OK')
                      ? colors.green
                      : testResult?.startsWith('FAIL')
                        ? colors.red
                        : colors.overlay1
                  }
                  labelWidth={16}
                />
                <Box marginTop={2} flexDirection="column">
                  {testing || saving ? (
                    <Box flexDirection="row" gap={1}>
                      <Text color={colors.yellow}>
                        <Spinner type="dots" />
                      </Text>
                      <Text color={colors.yellow}>{testing ? 'Testing adapter...' : 'Saving config...'}</Text>
                    </Box>
                  ) : (
                    <>
                      <Text color={colors.accent} bold>
                        Enter test | e edit command | x clear override
                      </Text>
                      <Text color={colors.textDim}>
                        Command override is persisted to mmbridge config and applied immediately.
                      </Text>
                    </>
                  )}
                </Box>
              </>
            ) : (
              <>
                {selectedSetting === 'classifiers' && (
                  <>
                    <KVRow label="Resolved rules" value={String(resolvedClassifiers.length)} labelWidth={16} />
                    <KVRow label="Custom rules" value={String(customClassifiers.length)} labelWidth={16} />
                    <KVRow
                      label="Use defaults"
                      value={configData.extendDefaultClassifiers === false ? 'false' : 'true'}
                      valueColor={configData.extendDefaultClassifiers === false ? colors.yellow : colors.green}
                      labelWidth={16}
                    />
                    <KVRow
                      label="Categories"
                      value={classifierCategories.slice(0, 4).join(', ') || 'None'}
                      labelWidth={16}
                    />
                    <Box marginTop={2}>
                      <Text color={colors.accent} bold>
                        Enter toggle default classifiers
                      </Text>
                    </Box>
                  </>
                )}

                {selectedSetting === 'redaction' && (
                  <>
                    <KVRow label="Built-in rules" value="runtime defaults" labelWidth={16} />
                    <KVRow label="Custom rules" value={String(customRedactionRules.length)} labelWidth={16} />
                    <KVRow
                      label="Last custom"
                      value={customRedactionRules.at(-1)?.label ?? '(none)'}
                      valueColor={customRedactionRules.length > 0 ? colors.text : colors.overlay1}
                      labelWidth={16}
                    />
                    <Box marginTop={2}>
                      <Text color={colors.accent} bold>
                        Enter/e add rule | x clear custom rules
                      </Text>
                      <Text color={colors.textDim}>Custom rules now apply during workspace redaction.</Text>
                    </Box>
                  </>
                )}

                {selectedSetting === 'context' && (
                  <>
                    <KVRow label="Max size" value={formatBytes(contextMaxBytes)} labelWidth={16} />
                    <KVRow
                      label="Source"
                      value={configData.context?.maxBytes === undefined ? 'runtime default' : 'project config'}
                      valueColor={configData.context?.maxBytes === undefined ? colors.overlay1 : colors.green}
                      labelWidth={16}
                    />
                    <KVRow label="Default" value={formatBytes(DEFAULT_MAX_CONTEXT_BYTES)} labelWidth={16} />
                    <Box marginTop={2}>
                      <Text color={colors.accent} bold>
                        Enter/e edit size | x reset to default
                      </Text>
                      <Text color={colors.textDim}>This limit now feeds the actual context builder.</Text>
                    </Box>
                  </>
                )}

                {selectedSetting === 'bridge' && (
                  <>
                    <KVRow
                      label="Installed tools"
                      value={`${installedAdapterCount}/${adapters.length}`}
                      labelWidth={16}
                    />
                    <KVRow
                      label="Bridge ready"
                      value={bridgeReady ? 'yes' : 'no'}
                      valueColor={bridgeReady ? colors.green : colors.yellow}
                      labelWidth={16}
                    />
                    <KVRow
                      label="Mode"
                      value={bridgeMode}
                      valueColor={bridgeMode === 'interpreted' ? colors.yellow : colors.green}
                      labelWidth={16}
                    />
                    <KVRow label="Profile" value={bridgeProfile} labelWidth={16} />
                    <KVRow label="Config overrides" value={String(adapterOverrideCount)} labelWidth={16} />
                    <KVRow
                      label="Interpretation"
                      value={bridgeMode === 'interpreted' ? 'enabled' : 'disabled'}
                      valueColor={bridgeMode === 'interpreted' ? colors.green : colors.overlay1}
                      labelWidth={16}
                    />
                    <Box marginTop={2}>
                      <Text color={colors.accent} bold>
                        Enter toggle mode | e cycle profile
                      </Text>
                      <Text color={colors.textDim}>
                        These defaults are now used when running `mmbridge review --tool all` without explicit bridge
                        flags.
                      </Text>
                    </Box>
                  </>
                )}
              </>
            )}
          </Box>
        </Panel>
      </Box>

      {editor && (
        <Box marginTop={1}>
          <PromptInput
            key={`${editor.label}:${editor.initialValue ?? ''}:${configStatus}`}
            label={editor.label}
            initialValue={editor.initialValue}
            placeholder={editor.placeholder}
            onCancel={cancelEdit}
            onSubmit={(value) => {
              void handleEditorSubmit(value);
            }}
          />
        </Box>
      )}
    </Box>
  );
}
