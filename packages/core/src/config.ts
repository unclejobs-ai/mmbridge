import fs from 'node:fs/promises';
import path from 'node:path';
import type { FileClassifierRule, MmbridgeConfig } from './types.js';

const CONFIG_FILENAMES = ['.mmbridge.config.json', 'mmbridge.config.json'];

export const DEFAULT_CLASSIFIERS: FileClassifierRule[] = [
  { pattern: 'src/api/', category: 'API' },
  { pattern: 'src/routes/', category: 'Routes' },
  { pattern: 'api/', category: 'API' },
  { pattern: 'routes/', category: 'Routes' },
  { pattern: 'src/components/', category: 'Component' },
  { pattern: 'components/', category: 'Component' },
  { pattern: 'src/lib/', category: 'Library' },
  { pattern: 'lib/', category: 'Library' },
  { pattern: 'src/hooks/', category: 'Hook' },
  { pattern: 'hooks/', category: 'Hook' },
  { pattern: 'src/stores/', category: 'State' },
  { pattern: 'stores/', category: 'State' },
  { pattern: 'src/utils/', category: 'Utility' },
  { pattern: 'utils/', category: 'Utility' },
  { pattern: 'test/', category: 'Test' },
  { pattern: 'tests/', category: 'Test' },
  { pattern: '__tests__/', category: 'Test' },
  { pattern: 'spec/', category: 'Test' },
  { pattern: '.github/', category: 'CI/CD' },
  { pattern: 'scripts/', category: 'Script' },
  { pattern: 'docs/', category: 'Documentation' },
];

function isMmbridgeConfig(value: unknown): value is MmbridgeConfig {
  if (value === null || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  if (obj.classifiers !== undefined && !Array.isArray(obj.classifiers)) return false;
  if (obj.extendDefaultClassifiers !== undefined && typeof obj.extendDefaultClassifiers !== 'boolean') return false;
  if (obj.adapters !== undefined && (typeof obj.adapters !== 'object' || obj.adapters === null)) return false;
  if (obj.context !== undefined && (typeof obj.context !== 'object' || obj.context === null)) return false;
  if (obj.redaction !== undefined && (typeof obj.redaction !== 'object' || obj.redaction === null)) return false;
  if (obj.bridge !== undefined && (typeof obj.bridge !== 'object' || obj.bridge === null)) return false;

  const context = obj.context as Record<string, unknown> | undefined;
  if (context?.maxBytes !== undefined && typeof context.maxBytes !== 'number') return false;

  const redaction = obj.redaction as Record<string, unknown> | undefined;
  if (redaction?.extraRules !== undefined && !Array.isArray(redaction.extraRules)) return false;

  const bridge = obj.bridge as Record<string, unknown> | undefined;
  if (bridge?.mode !== undefined && bridge.mode !== 'standard' && bridge.mode !== 'interpreted') return false;
  if (bridge?.profile !== undefined && !['standard', 'strict', 'relaxed'].includes(String(bridge.profile)))
    return false;

  return true;
}

async function findConfigPath(projectDir: string): Promise<string | null> {
  for (const filename of CONFIG_FILENAMES) {
    const configPath = path.join(projectDir, filename);
    try {
      await fs.access(configPath);
      return configPath;
    } catch {
      // Try next known config filename.
    }
  }
  return null;
}

export async function loadConfig(projectDir: string): Promise<MmbridgeConfig> {
  const configPath = await findConfigPath(projectDir);
  if (!configPath) {
    return {};
  }

  try {
    const raw = await fs.readFile(configPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!isMmbridgeConfig(parsed)) {
      throw new Error(`Invalid mmbridge config at ${configPath}`);
    }
    return parsed;
  } catch (err) {
    if (err instanceof SyntaxError || (err instanceof Error && err.message.startsWith('Invalid mmbridge'))) {
      throw err;
    }
  }

  return {};
}

export async function saveConfig(projectDir: string, config: MmbridgeConfig): Promise<string> {
  if (!isMmbridgeConfig(config)) {
    throw new Error('Invalid mmbridge config');
  }

  const configPath = (await findConfigPath(projectDir)) ?? path.join(projectDir, CONFIG_FILENAMES[0]);
  const content = `${JSON.stringify(config, null, 2)}\n`;
  await fs.writeFile(configPath, content, 'utf8');
  return configPath;
}

export function resolveClassifiers(config: MmbridgeConfig): FileClassifierRule[] {
  if (!config.classifiers) return DEFAULT_CLASSIFIERS;
  if (config.extendDefaultClassifiers !== false) {
    return [...config.classifiers, ...DEFAULT_CLASSIFIERS];
  }
  return config.classifiers;
}

export function classifyFileWithRules(filePath: string, rules: FileClassifierRule[]): string {
  for (const rule of rules) {
    if (filePath.startsWith(rule.pattern)) {
      return rule.category;
    }
  }
  return 'Other';
}
