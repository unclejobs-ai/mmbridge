import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { importAdapters, importCore, importTui, jsonOutput } from './helpers.js';

export interface DoctorOptions {
  json?: boolean;
  setup?: boolean;
}

export async function runDoctorCommand(options: DoctorOptions): Promise<void> {
  const { commandExists } = await importCore();
  const { defaultRegistry } = await importAdapters();
  const { renderDoctor, renderSetupWizard } = await importTui();

  const adapterBinaries = defaultRegistry.values().map((a) => a.binary);
  const binaries = [...new Set([...adapterBinaries, 'claude'])];
  const checks = await Promise.all(
    binaries.map(async (binary) => ({
      binary,
      installed: await commandExists(binary),
    })),
  );

  const home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
  const mmbridgeHome = path.join(home, '.mmbridge');
  const claudeAgentsDir = path.join(home, '.claude', 'agents');
  const runtimeAuthModel = process.env.MMBRIDGE_AUTH_MODEL ?? 'claude-sonnet-4-5';

  const sessionFileHints: Record<string, string> = {};
  for (const tool of defaultRegistry.list()) {
    const hint = path.join(mmbridgeHome, 'sessions', `${tool}.jsonl`);
    try {
      await fs.access(hint);
      sessionFileHints[tool] = hint;
    } catch {
      sessionFileHints[tool] = `${hint} (not found)`;
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    checks,
    mmbridgeHome,
    claudeAgentsDir,
    runtimeAuthModel,
    sessionFileHints,
  };

  if (options.json) {
    jsonOutput(report);
    return;
  }

  if (options.setup) {
    await renderSetupWizard(report);
  } else {
    await renderDoctor(report);
  }
}
