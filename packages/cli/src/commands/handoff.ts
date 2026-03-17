import fs from 'node:fs/promises';
import path from 'node:path';
import { importSessionStore, jsonOutput, resolveProjectDir } from './helpers.js';

export interface HandoffCommandOptions {
  session?: string;
  project?: string;
  write?: string;
  json?: boolean;
}

function renderHandoffText(document: import('@mmbridge/session-store').HandoffDocument): string {
  const findings = document.findings.slice(0, 5).map((finding) => {
    const location = finding.line != null ? `${finding.file}:${finding.line}` : finding.file;
    return `- [${finding.severity}] ${location} - ${finding.message}`;
  });
  const recalledMemory = document.recalledMemory.slice(0, 4).flatMap((entry) => {
    const meta = [
      entry.type,
      entry.severity ?? null,
      entry.file ? `${entry.file}${entry.line != null ? `:${entry.line}` : ''}` : null,
      entry.createdAt,
    ]
      .filter((part): part is string => Boolean(part))
      .join(' · ');
    return [`- ${entry.title}`, ...(meta ? [`  ${meta}`] : []), `  ${entry.content}`];
  });

  return [
    'MMBridge Handoff',
    `session: #${document.artifact.sessionId}`,
    `tool: ${document.tool} · mode: ${document.mode}${document.status ? ` · status: ${document.status}` : ''}`,
    `project: ${document.projectDir}`,
    document.baseRef ? `base: ${document.baseRef}` : null,
    document.head ? `head: ${document.head.branch} (${document.head.sha})` : null,
    '',
    'Summary',
    document.summary,
    '',
    'Recall',
    document.recalledMemorySummary ?? 'No recalled memory for this handoff.',
    ...(recalledMemory.length > 0 ? ['', 'Recalled Entries', ...recalledMemory] : []),
    '',
    'Next Prompt',
    document.recommendedNextPrompt,
    '',
    'Next Command',
    document.recommendedNextCommand,
    findings.length > 0 ? '' : null,
    findings.length > 0 ? 'Findings' : null,
    ...findings,
    '',
    `artifact: ${document.artifact.markdownPath}`,
  ]
    .filter((line): line is string => line != null)
    .join('\n');
}

export async function runHandoffCommand(options: HandoffCommandOptions): Promise<void> {
  const projectDir = resolveProjectDir(options.project);
  const { createMemoryProvider } = await importSessionStore();
  const memoryStore = await createMemoryProvider({ projectDir });

  let document: import('@mmbridge/session-store').HandoffDocument | null = null;
  if (options.session) {
    document = await memoryStore.getHandoffBySession(projectDir, options.session);
  } else {
    const latest = await memoryStore.getLatestHandoff(projectDir);
    document = latest ? await memoryStore.getHandoffBySession(projectDir, latest.sessionId) : null;
  }

  if (!document) {
    process.stderr.write('[mmbridge] No handoff found for this project.\n');
    process.exitCode = 1;
    return;
  }

  if (options.write) {
    const target = path.resolve(options.write);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(document.artifact.markdownPath, target);
  }

  if (options.json) {
    jsonOutput(document);
    return;
  }

  process.stdout.write(`${renderHandoffText(document)}\n`);
}
