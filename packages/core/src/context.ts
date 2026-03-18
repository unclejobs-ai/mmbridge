import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from './config.js';
import { getChangedFiles, getDefaultBaseRef, getDiff, getHead } from './git.js';
import { redactWorkspace } from './redaction.js';
import { ADAPTER_NAMES } from './types.js';
import type { ContextWorkspace, CreateContextOptions } from './types.js';
import { ensureDir, isBinaryExtension, isPotentialSecretFile, limitBytes, projectSlug, shortDigest } from './utils.js';

const DEFAULT_MAX_CONTEXT_BYTES = 2 * 1024 * 1024; // 2 MB

const MODE_INSTRUCTIONS: Record<string, string> = {
  review: [
    'Perform a thorough code review of the changes.',
    'Focus on: correctness, maintainability, error handling, naming, and adherence to project conventions.',
    'Flag unused code, missing error handling, type safety issues, and potential regressions.',
  ].join('\n'),
  security: [
    'Perform a security-focused audit of the changes.',
    'Focus on: injection vulnerabilities (SQL, XSS, command), authentication/authorization gaps,',
    'secret exposure, insecure data handling, CSRF, SSRF, and OWASP Top 10 issues.',
    'Rate each finding as CRITICAL, WARNING, or INFO based on exploitability and impact.',
  ].join('\n'),
  architecture: [
    'Perform an architectural review of the changes.',
    'Focus on: SOLID violations, dependency direction, layer boundary crossings,',
    'module coupling, separation of concerns, and scalability implications.',
    'Flag over-engineering and under-abstraction equally.',
  ].join('\n'),
  research: [
    'Conduct in-depth research on the given topic.',
    'Provide structured insights with evidence and confidence levels.',
    'Classify each insight by category: consensus (agreed by multiple sources), unique (novel perspective), or contradiction (conflicting views).',
    'Include source attribution for each insight.',
  ].join('\n'),
  debate: [
    'Analyze the given proposition from your assigned perspective.',
    'State your stance (for, against, or nuanced) with clear arguments and evidence.',
    'In cross-examination rounds, directly address and critique other positions.',
    'In synthesis rounds, identify areas of agreement and persistent disagreement.',
  ].join('\n'),
  'security-audit': [
    'Perform a comprehensive security audit of the codebase.',
    'Focus on: OWASP Top 10, CWE classifications, authentication/authorization flaws,',
    'injection vulnerabilities, data exposure, cryptographic weaknesses, and supply chain risks.',
    'Classify each finding with severity (P0-P3), exploitability, and specific CWE IDs.',
    'Provide actionable remediation for each finding with code snippets where possible.',
    'Map the attack surface: entry points, data flows, and trust boundaries.',
  ].join('\n'),
};

function buildToolPrompt(
  tool: string,
  mode: string,
  changedFiles: string[],
  recallPromptContext?: string,
  recallSummary?: string,
): string {
  const modeInstr = MODE_INSTRUCTIONS[mode] ?? MODE_INSTRUCTIONS.review ?? '';
  const fileList = changedFiles
    .slice(0, 30)
    .map((f) => `- ${f}`)
    .join('\n');
  const truncNote = changedFiles.length > 30 ? `\n- *(${changedFiles.length} files total — showing first 30)*` : '';

  return [
    `# MMBridge ${tool} Review`,
    '',
    `## Mode: ${mode}`,
    '',
    modeInstr,
    '',
    '## Output Format',
    '',
    'For each finding, output a structured block:',
    '```',
    '**[SEVERITY]** file:line — message',
    '```',
    'Where SEVERITY is one of: CRITICAL, WARNING, INFO, REFACTOR',
    '',
    'End with a brief summary paragraph.',
    '',
    '## Changed Files',
    '',
    fileList + truncNote,
    ...(recallPromptContext
      ? [
          '',
          '## Recall',
          '',
          recallSummary ?? 'Project memory and the latest handoff were attached to this run.',
          '',
          recallPromptContext,
        ]
      : []),
    '',
    '## Instructions',
    '',
    '- Review ONLY the changed files listed above.',
    '- Reference the diff.patch and context.md in the workspace for full context.',
    '- Do not report issues in unchanged files or review instruction text.',
    '- Be concise — one finding per issue, no duplicates.',
  ].join('\n');
}

export async function createContext(options: CreateContextOptions = {}): Promise<ContextWorkspace> {
  const projectDir = path.resolve(options.projectDir ?? process.cwd());
  const mode = options.mode ?? 'review';
  const config = await loadConfig(projectDir);
  const maxContextBytes = options.maxContextBytes ?? config.context?.maxBytes ?? DEFAULT_MAX_CONTEXT_BYTES;

  const head = await getHead(projectDir);
  const baseRef = options.baseRef ?? options.commit ?? (await getDefaultBaseRef(projectDir));

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

    const srcPath = path.resolve(projectDir, relPath);
    const destPath = path.resolve(workspace, 'files', relPath);

    // Guard against path traversal from git output
    if (!srcPath.startsWith(projectDir + path.sep)) continue;
    if (!destPath.startsWith(path.resolve(workspace, 'files') + path.sep)) continue;

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
  const limitedDiffContent = limitBytes(diffContent, maxContextBytes);
  const diffPath = path.join(workspace, 'diff.patch');
  await fs.writeFile(diffPath, limitedDiffContent, 'utf8');

  // Write context index file
  const contextPath = path.join(workspace, 'context.md');
  const contextContent = [
    '# MMBridge Context',
    '',
    `- **Project**: ${projectDir}`,
    `- **Mode**: ${mode}`,
    `- **Branch**: ${head.branch} (${head.sha})`,
    `- **Base ref**: ${baseRef}`,
    `- **Changed files**: ${changedFiles.length}`,
    `- **Copied files**: ${copiedFileCount}`,
    ...(options.recallSummary ? [`- **Recall**: ${options.recallSummary}`] : []),
    '',
    '## Changed Files',
    changedFiles.map((f) => `- ${f}`).join('\n'),
    ...(options.recallPromptContext ? ['', '## Recall', options.recallPromptContext] : []),
  ].join('\n');
  await fs.writeFile(contextPath, contextContent, 'utf8');

  // Generate tool-specific prompt files (parallel writes)
  const promptDir = path.join(workspace, 'prompt');
  await ensureDir(promptDir);

  const toolNames = options.tools ?? [...ADAPTER_NAMES];
  const promptPaths = await Promise.all(
    toolNames.map(async (tool) => {
      const promptContent = buildToolPrompt(
        tool,
        mode,
        changedFiles,
        options.recallPromptContext,
        options.recallSummary,
      );
      const promptPath = path.join(promptDir, `${tool}.md`);
      await fs.writeFile(promptPath, promptContent, 'utf8');
      return promptPath;
    }),
  );

  // Redact secrets from workspace
  const redaction = await redactWorkspace(workspace, config.redaction?.extraRules ?? []);

  return {
    workspace,
    mode,
    projectDir,
    baseRef,
    diffDigest: shortDigest(limitedDiffContent),
    changedFiles,
    copiedFileCount,
    contextPath,
    diffPath,
    promptPaths,
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
