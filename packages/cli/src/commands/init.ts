import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveProjectDir, importCore, importAdapters } from './helpers.js';
import type { AdapterRegistry } from '@mmbridge/adapters';

export interface InitCommandOptions {
  project?: string;
  yes?: boolean;
}

async function detectInstalledAdapters(
  registry: AdapterRegistry,
  commandExists: (cmd: string) => Promise<boolean>,
): Promise<Array<{ name: string; binary: string }>> {
  const installed: Array<{ name: string; binary: string }> = [];
  for (const adapter of registry.values()) {
    if (await commandExists(adapter.binary)) {
      installed.push({ name: adapter.name, binary: adapter.binary });
    }
  }
  return installed;
}

export async function runInitCommand(options: InitCommandOptions): Promise<void> {
  const projectDir = resolveProjectDir(options.project);
  const configPath = path.join(projectDir, '.mmbridge.config.json');

  // Check if config already exists
  try {
    await fs.access(configPath);
    process.stderr.write(`[mmbridge] Config already exists at ${configPath}\n`);
    return;
  } catch {
    // File doesn't exist — proceed with creation
  }

  const { commandExists } = await importCore();
  const { defaultRegistry } = await importAdapters();
  const installedAdapters = await detectInstalledAdapters(defaultRegistry, commandExists);

  if (options.yes) {
    const config = buildConfig(installedAdapters);
    await writeConfig(configPath, config);
    process.stderr.write(`[mmbridge] Config written to ${configPath}\n`);
    return;
  }

  // Interactive mode with @clack/prompts
  const { intro, outro, select, multiselect, confirm, isCancel, cancel } = await import('@clack/prompts');

  intro('mmbridge init');

  if (installedAdapters.length === 0) {
    cancel('No AI tools detected. Install at least one (kimi, qwen, codex, opencode). Run `mmbridge doctor` for details.');
    return;
  }

  // Select tools to use
  const selectedTools = await multiselect({
    message: 'Which AI tools do you want to use for reviews?',
    options: installedAdapters.map((a) => ({
      value: a.name,
      label: `${a.name} (${a.binary})`,
    })),
    initialValues: installedAdapters.map((a) => a.name),
  });

  if (isCancel(selectedTools) || !Array.isArray(selectedTools)) {
    cancel('Init cancelled.');
    return;
  }

  // Select default review mode
  const defaultMode = await select({
    message: 'Default review mode?',
    options: [
      { value: 'review', label: 'review — General code review' },
      { value: 'security', label: 'security — Security-focused review' },
      { value: 'architecture', label: 'architecture — Architecture review' },
    ],
  });

  if (isCancel(defaultMode)) {
    cancel('Init cancelled.');
    return;
  }

  // Context size
  const largeContext = await confirm({
    message: 'Use large context window? (2MB, recommended for monorepos)',
    initialValue: true,
  });

  if (isCancel(largeContext)) {
    cancel('Init cancelled.');
    return;
  }

  const selectedAdapters = installedAdapters.filter((a) => selectedTools.includes(a.name));
  const config = buildConfig(selectedAdapters, {
    maxBytes: largeContext ? 2097152 : 1048576,
    defaultMode: defaultMode !== 'review' ? String(defaultMode) : undefined,
  });

  await writeConfig(configPath, config);
  outro(`Config written to ${configPath}`);
}

function buildConfig(
  adapters: Array<{ name: string; binary: string }>,
  options?: { maxBytes?: number; defaultMode?: string },
): Record<string, unknown> {
  const config: Record<string, unknown> = {
    adapters: Object.fromEntries(
      adapters.map((a) => [a.name, { command: a.binary }]),
    ),
    context: { maxBytes: options?.maxBytes ?? 2097152 },
  };
  // Omit defaultMode when 'review' (the built-in default)
  if (options?.defaultMode) {
    config.defaultMode = options.defaultMode;
  }
  return config;
}

async function writeConfig(configPath: string, config: Record<string, unknown>): Promise<void> {
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}
