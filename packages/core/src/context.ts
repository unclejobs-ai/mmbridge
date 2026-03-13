import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { runCommand, ensureDir, isBinaryExtension, isPotentialSecretFile, safeRead, limitBytes, projectSlug } from './utils.js';
import { getHead, getChangedFiles, getDiff, getDefaultBaseRef } from './git.js';
import { redactWorkspace } from './redaction.js';
import type { ContextWorkspace, CreateContextOptions } from './types.js';

const DEFAULT_MAX_CONTEXT_BYTES = 2 * 1024 * 1024; // 2 MB

export async function createContext(options: CreateContextOptions = {}): Promise<ContextWorkspace> {
  const projectDir = path.resolve(options.projectDir ?? process.cwd());
  const mode = options.mode ?? 'review';
  const maxContextBytes = options.maxContextBytes ?? DEFAULT_MAX_CONTEXT_BYTES;

  const head = await getHead(projectDir);
  const baseRef = options.baseRef ?? options.commit ?? await getDefaultBaseRef(projectDir);

  const changedFiles = await getChangedFiles(baseRef, projectDir);

  // Create workspace directory
  const slug = projectSlug(projectDir);
  const workspaceId = crypto.randomBytes(4).toString('hex');
  const workspace = path.join(os.tmpdir(), `mmctx-${workspaceId}${slug}`);
  await ensureDir(workspace);

  // Copy changed files to workspace
  let copiedFileCount = 0;
  let totalBytes = 0;

  for (const relPath of changedFiles) {
    if (isBinaryExtension(relPath)) continue;
    if (isPotentialSecretFile(relPath)) continue;

    const srcPath = path.join(projectDir, relPath);
    const destPath = path.join(workspace, 'files', relPath);

    let content: string;
    try {
      content = await fs.readFile(srcPath, 'utf8');
    } catch {
      continue;
    }

    if (totalBytes + Buffer.byteLength(content, 'utf8') > maxContextBytes) {
      content = limitBytes(content, maxContextBytes - totalBytes);
    }

    await ensureDir(path.dirname(destPath));
    await fs.writeFile(destPath, content, 'utf8');
    totalBytes += Buffer.byteLength(content, 'utf8');
    copiedFileCount++;

    if (totalBytes >= maxContextBytes) break;
  }

  // Write diff
  const diffContent = await getDiff(baseRef, projectDir);
  const diffPath = path.join(workspace, 'diff.patch');
  await fs.writeFile(diffPath, limitBytes(diffContent, maxContextBytes), 'utf8');

  // Write context index file
  const contextPath = path.join(workspace, 'context.md');
  const contextContent = [
    `# MMBridge Context`,
    ``,
    `- **Project**: ${projectDir}`,
    `- **Mode**: ${mode}`,
    `- **Branch**: ${head.branch} (${head.sha})`,
    `- **Base ref**: ${baseRef}`,
    `- **Changed files**: ${changedFiles.length}`,
    `- **Copied files**: ${copiedFileCount}`,
    ``,
    `## Changed Files`,
    changedFiles.map((f) => `- ${f}`).join('\n'),
  ].join('\n');
  await fs.writeFile(contextPath, contextContent, 'utf8');

  // Redact secrets from workspace
  const redaction = await redactWorkspace(workspace);

  return {
    workspace,
    mode,
    projectDir,
    baseRef,
    changedFiles,
    copiedFileCount,
    contextPath,
    diffPath,
    promptPaths: [],
    redaction,
    head,
  };
}

export async function cleanupContext(workspace: string): Promise<void> {
  try {
    await fs.rm(workspace, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}
