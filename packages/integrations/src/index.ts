import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AGENT_FILES = [
  'kimi-reviewer.md',
  'qwen-reviewer.md',
  'codex-reviewer.md',
  'gemini-design-reviewer.md',
  'plan-reviewer.md',
] as const;

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TEMPLATE_ROOT = path.resolve(MODULE_DIR, '../../../assets/claude-agents');

interface SyncOptions {
  homeDir?: string;
  restore?: string;
  dryRun?: boolean;
  templateRoot?: string;
}

interface FileEntry {
  fileName: string;
  source?: string;
  target?: string;
  backup?: string;
  template?: string;
}

interface SyncResult {
  mode: 'sync' | 'restore';
  backupId: string;
  dryRun: boolean;
  backedUp?: FileEntry[];
  updated?: FileEntry[];
  restored?: FileEntry[];
}

export async function syncClaudeAgents(options: SyncOptions = {}): Promise<SyncResult> {
  const homeDir = options.homeDir ?? os.homedir();
  const restore = options.restore;
  const dryRun = Boolean(options.dryRun);
  const templateRoot = options.templateRoot ?? DEFAULT_TEMPLATE_ROOT;

  const claudeAgentsDir = path.join(homeDir, '.claude', 'agents');
  const backupRoot = path.join(homeDir, '.mmbridge', 'backups');

  await fs.mkdir(claudeAgentsDir, { recursive: true });
  await fs.mkdir(backupRoot, { recursive: true });

  if (restore) {
    const restoreDir = path.join(backupRoot, restore, 'agents');
    await assertDirectoryExists(restoreDir, `Backup not found: ${restore}`);

    const restored: FileEntry[] = [];
    for (const fileName of AGENT_FILES) {
      const source = path.join(restoreDir, fileName);
      const target = path.join(claudeAgentsDir, fileName);
      if (!(await exists(source))) continue;
      restored.push({ fileName, source, target });
      if (!dryRun) {
        await fs.copyFile(source, target);
      }
    }

    return {
      mode: 'restore',
      backupId: restore,
      dryRun,
      restored,
    };
  }

  const backupId = createBackupId();
  const backupDir = path.join(backupRoot, backupId, 'agents');
  await fs.mkdir(backupDir, { recursive: true });

  const updated: FileEntry[] = [];
  const backedUp: FileEntry[] = [];

  for (const fileName of AGENT_FILES) {
    const currentPath = path.join(claudeAgentsDir, fileName);
    const backupPath = path.join(backupDir, fileName);
    const templatePath = path.join(templateRoot, fileName);

    await assertFileExists(templatePath, `Template missing: ${templatePath}`);

    if (await exists(currentPath)) {
      backedUp.push({ fileName, source: currentPath, backup: backupPath });
      if (!dryRun) {
        await fs.copyFile(currentPath, backupPath);
      }
    }

    updated.push({ fileName, template: templatePath, target: currentPath });
    if (!dryRun) {
      const content = await fs.readFile(templatePath, 'utf8');
      await fs.writeFile(currentPath, content, 'utf8');
    }
  }

  if (!dryRun) {
    const manifest = {
      backupId,
      createdAt: new Date().toISOString(),
      files: [...AGENT_FILES],
      templateRoot,
    };
    await fs.writeFile(
      path.join(backupRoot, backupId, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf8',
    );
  }

  return {
    mode: 'sync',
    backupId,
    dryRun,
    backedUp,
    updated,
  };
}

function createBackupId(): string {
  const date = new Date();
  const stamp = date.toISOString().replace(/[:.]/g, '-');
  return `backup-${stamp}`;
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function assertFileExists(filePath: string, errorMessage: string): Promise<void> {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat || !stat.isFile()) {
    throw new Error(errorMessage);
  }
}

async function assertDirectoryExists(dirPath: string, errorMessage: string): Promise<void> {
  const stat = await fs.stat(dirPath).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw new Error(errorMessage);
  }
}

export type { SyncOptions, SyncResult, FileEntry };
