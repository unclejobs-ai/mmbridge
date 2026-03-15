import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { importIntegrations, jsonOutput } from './helpers.js';

export interface HookCommandOptions {
  global?: boolean;
  json?: boolean;
}

export async function runHookInstallCommand(options: HookCommandOptions): Promise<void> {
  const home = os.homedir();
  const settingsPath = options.global
    ? path.join(home, '.claude', 'settings.json')
    : path.join(process.cwd(), '.claude', 'settings.json');

  await fs.mkdir(path.dirname(settingsPath), { recursive: true });

  let existing: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(settingsPath, 'utf8');
    existing = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // File doesn't exist yet — start with empty config
  }

  const hooks = (existing.hooks ?? {}) as Record<string, unknown>;

  const { generateHookConfig } = await importIntegrations();
  const mmHooks = generateHookConfig();

  for (const [event, hookDefs] of Object.entries(mmHooks)) {
    const existingHooks = Array.isArray(hooks[event]) ? (hooks[event] as Array<Record<string, unknown>>) : [];
    const filtered = existingHooks.filter((h) => {
      if (!Array.isArray(h.hooks)) return true;
      return !(h.hooks as Array<Record<string, unknown>>).some(
        (hh) => typeof hh.command === 'string' && hh.command.includes('mmbridge'),
      );
    });
    hooks[event] = [...filtered, ...(hookDefs as Array<unknown>)];
  }

  existing.hooks = hooks;

  await fs.writeFile(settingsPath, JSON.stringify(existing, null, 2), 'utf8');

  if (options.json) {
    jsonOutput({ installed: true, path: settingsPath, hooks: Object.keys(mmHooks) });
  } else {
    process.stderr.write(`[mmbridge] Hooks installed to ${settingsPath}\n`);
  }
}

export async function runHookUninstallCommand(options: HookCommandOptions): Promise<void> {
  const home = os.homedir();
  const settingsPath = options.global
    ? path.join(home, '.claude', 'settings.json')
    : path.join(process.cwd(), '.claude', 'settings.json');

  let existing: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(settingsPath, 'utf8');
    existing = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    process.stderr.write(`[mmbridge] No settings file found at ${settingsPath}\n`);
    return;
  }

  const hooks = (existing.hooks ?? {}) as Record<string, unknown>;

  for (const event of Object.keys(hooks)) {
    const eventHooks = Array.isArray(hooks[event]) ? (hooks[event] as Array<Record<string, unknown>>) : [];
    hooks[event] = eventHooks.filter((h) => {
      if (!Array.isArray(h.hooks)) return true;
      return !(h.hooks as Array<Record<string, unknown>>).some(
        (hh) => typeof hh.command === 'string' && hh.command.includes('mmbridge'),
      );
    });
  }

  existing.hooks = hooks;
  await fs.writeFile(settingsPath, JSON.stringify(existing, null, 2), 'utf8');

  if (options.json) {
    jsonOutput({ uninstalled: true, path: settingsPath });
  } else {
    process.stderr.write(`[mmbridge] Hooks removed from ${settingsPath}\n`);
  }
}
