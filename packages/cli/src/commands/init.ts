import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveProjectDir, importCore, importAdapters } from './helpers.js';

export interface InitCommandOptions {
  project?: string;
  yes?: boolean;
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

  if (options.yes) {
    // Non-interactive: generate default config
    const config = await buildDefaultConfig(defaultRegistry, commandExists);
    await writeConfig(configPath, config);
    return;
  }

  // Interactive mode with @clack/prompts
  const { intro, outro, select, multiselect, confirm, isCancel, cancel } = await import('@clack/prompts');

  intro('mmbridge init');

  // Detect installed adapters
  const adapters = defaultRegistry.values();
  const installedAdapters: Array<{ name: string; binary: string }> = [];
  for (const adapter of adapters) {
    if (await commandExists(adapter.binary)) {
      installedAdapters.push({ name: adapter.name, binary: adapter.binary });
    }
  }

  if (installedAdapters.length === 0) {
    process.stderr.write('[mmbridge] No AI tools detected. Install at least one (kimi, qwen, codex, opencode).\n');
    process.stderr.write('[mmbridge] Run `mmbridge doctor` for details.\n');
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

  if (isCancel(selectedTools)) {
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

  const config: Record<string, unknown> = {
    adapters: Object.fromEntries(
      (selectedTools as string[]).map((tool) => {
        const adapter = defaultRegistry.get(tool);
        return [tool, { command: adapter?.binary ?? tool }];
      }),
    ),
    context: {
      maxBytes: largeContext ? 2097152 : 1048576,
    },
  };

  if (defaultMode !== 'review') {
    config.defaultMode = defaultMode;
  }

  await writeConfig(configPath, config);
  outro(`Config written to ${configPath}`);
}

async function buildDefaultConfig(
  registry: { values: () => Array<{ name: string; binary: string }> },
  commandExists: (cmd: string) => Promise<boolean>,
): Promise<Record<string, unknown>> {
  const adapters: Record<string, { command: string }> = {};
  for (const adapter of registry.values()) {
    if (await commandExists(adapter.binary)) {
      adapters[adapter.name] = { command: adapter.binary };
    }
  }
  return {
    adapters,
    context: { maxBytes: 2097152 },
  };
}

async function writeConfig(configPath: string, config: Record<string, unknown>): Promise<void> {
  await fs.writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  process.stderr.write(`[mmbridge] Config written to ${configPath}\n`);
}
