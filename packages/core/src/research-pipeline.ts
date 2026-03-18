import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cleanupContext, createContext } from './context.js';
import { orchestrateReview } from './orchestrate.js';
import { synthesizeResearch } from './research-synthesize.js';
import type { ReviewPipelineOptions } from './review-pipeline.js';
import { buildContextIndex, buildResultIndex } from './session-index.js';
import type { ContextWorkspace, ResearchReport, ResearchType, ResultIndex } from './types.js';
import { ensureDir, nowIso, projectSlug } from './utils.js';

// ─── Public interfaces ───────────────────────────────────────────────────────

export interface ResearchPipelineOptions {
  topic: string;
  type: ResearchType;
  tools: string[];
  projectDir: string;
  baseRef?: string;
  onProgress?: (phase: string, detail: string) => void;
  onStdout?: (tool: string, chunk: string) => void;
  runAdapter: ReviewPipelineOptions['runAdapter'];
  listInstalledTools?: () => Promise<string[]>;
  saveSession?: ReviewPipelineOptions['saveSession'];
}

export interface ResearchPipelineResult {
  runId: string;
  sessionId: string;
  report: ResearchReport;
  toolContributions: Record<string, string>;
}

// ─── Workspace helpers ───────────────────────────────────────────────────────

function buildResearchPrompt(tool: string, topic: string, type: ResearchType, changedFiles: string[]): string {
  const fileList = changedFiles
    .slice(0, 30)
    .map((f) => `- ${f}`)
    .join('\n');
  const truncNote = changedFiles.length > 30 ? `\n- *(${changedFiles.length} files total — showing first 30)*` : '';

  return [
    `# MMBridge Research: ${topic}`,
    '',
    `## Type: ${type}`,
    '',
    'Conduct in-depth research on the given topic.',
    'Provide structured insights with evidence and confidence levels.',
    'Classify each insight by category: consensus (agreed by multiple sources), unique (novel perspective), or contradiction (conflicting views).',
    'Include source attribution for each insight.',
    '',
    '## Output Format',
    '',
    'For each insight, output:',
    '**[CONFIDENCE]** insight text',
    'Sources: source1, source2',
    'Category: consensus|unique|contradiction',
    '',
    'Where CONFIDENCE is one of: HIGH, MEDIUM, LOW',
    '',
    '## Topic',
    '',
    topic,
    ...(type === 'code-aware' && changedFiles.length > 0 ? ['', '## Changed Files', '', fileList + truncNote] : []),
    '',
    '## Instructions',
    '',
    `- You are the "${tool}" adapter. Research the topic thoroughly from your perspective.`,
    '- Output structured insights using the format above.',
    '- Be specific and cite evidence where possible.',
    '- Mark confidence levels accurately.',
  ].join('\n');
}

async function createOpenWorkspace(
  topic: string,
  type: ResearchType,
  tools: string[],
  projectDir: string,
): Promise<ContextWorkspace> {
  const slug = projectSlug(projectDir);
  const workspaceId = randomUUID().slice(0, 8);
  const workspace = path.join(os.tmpdir(), `mmresearch-${workspaceId}${slug}`);
  await ensureDir(workspace);

  const promptDir = path.join(workspace, 'prompt');
  await ensureDir(promptDir);

  const promptPaths: string[] = [];
  for (const tool of tools) {
    const content = buildResearchPrompt(tool, topic, type, []);
    const promptPath = path.join(promptDir, `${tool}.md`);
    await fs.writeFile(promptPath, content, 'utf8');
    promptPaths.push(promptPath);
  }

  const contextPath = path.join(workspace, 'context.md');
  const contextContent = [
    '# MMBridge Research Context',
    '',
    `- **Topic**: ${topic}`,
    `- **Type**: ${type}`,
    '- **Mode**: research',
    `- **Project**: ${projectDir}`,
  ].join('\n');
  await fs.writeFile(contextPath, contextContent, 'utf8');

  const diffPath = path.join(workspace, 'diff.patch');
  await fs.writeFile(diffPath, '', 'utf8');

  return {
    workspace,
    mode: 'research',
    projectDir,
    baseRef: undefined,
    diffDigest: '',
    changedFiles: [],
    copiedFileCount: 0,
    contextPath,
    diffPath,
    promptPaths,
    redaction: { changedFiles: 0, usedRuleCount: 0 },
    head: { sha: '', branch: '' },
  };
}

// ─── Pipeline ─────────────────────────────────────────────────────────────────

export async function runResearchPipeline(options: ResearchPipelineOptions): Promise<ResearchPipelineResult> {
  const { topic, type, tools, projectDir, onProgress, onStdout } = options;

  const runId = randomUUID();

  // Resolve the actual tools to use
  const resolvedTools = tools.length > 0 ? tools : options.listInstalledTools ? await options.listInstalledTools() : [];

  if (resolvedTools.length === 0) {
    throw new Error('No research tools available. Run `mmbridge doctor` to check installed tools.');
  }

  // Phase 1: Create workspace
  onProgress?.('context', `Building ${type} research context...`);

  let ctx: ContextWorkspace;

  if (type === 'code-aware') {
    ctx = await createContext({
      projectDir,
      mode: 'research',
      baseRef: options.baseRef,
      tools: resolvedTools,
    });

    // Overwrite prompt files with research-specific content
    const promptDir = path.join(ctx.workspace, 'prompt');
    await ensureDir(promptDir);
    for (const tool of resolvedTools) {
      const content = buildResearchPrompt(tool, topic, type, ctx.changedFiles);
      await fs.writeFile(path.join(promptDir, `${tool}.md`), content, 'utf8');
    }
  } else {
    ctx = await createOpenWorkspace(topic, type, resolvedTools, projectDir);
  }

  try {
    const contextIndex = buildContextIndex({
      workspace: ctx.workspace,
      projectDir,
      mode: 'research',
      baseRef: ctx.baseRef,
      diffDigest: ctx.diffDigest,
      head: ctx.head,
      changedFiles: ctx.changedFiles,
      copiedFileCount: ctx.copiedFileCount,
      redaction: ctx.redaction,
    });

    // Phase 2: Orchestrate parallel adapter runs
    onProgress?.('research', `Running ${resolvedTools.length} tools in parallel...`);
    const orchResult = await orchestrateReview({
      tools: resolvedTools,
      workspace: ctx.workspace,
      mode: 'research',
      baseRef: ctx.baseRef,
      changedFiles: ctx.changedFiles,
      runAdapter: (t, opts) => options.runAdapter(t, opts),
      onStdout,
      onToolProgress: async (tool, status) => {
        onProgress?.('research', `${tool}: ${status}`);
      },
    });

    // Phase 3: Synthesize insights
    onProgress?.('synthesize', 'Synthesizing insights across adapters...');
    const toolOutputs = orchResult.results
      .filter((r) => !r.skipped && r.summary.trim().length > 0)
      .map((r) => ({ tool: r.tool, text: r.summary }));

    const toolContributions: Record<string, string> = {};
    for (const r of orchResult.results) {
      toolContributions[r.tool] = r.summary;
    }

    const report = synthesizeResearch({ topic, type, toolOutputs });

    // Phase 4: Save session
    onProgress?.('report', 'Saving research session...');

    const resultIndex: ResultIndex = buildResultIndex({
      summary: report.summary,
      findings: [],
      parseState: 'research',
      followupSupported: false,
    });

    const session = options.saveSession
      ? await options.saveSession({
          tool: 'research',
          mode: 'research',
          projectDir,
          workspace: ctx.workspace,
          runId,
          summary: report.summary,
          findings: [],
          contextIndex,
          resultIndex,
          status: 'complete',
          diffDigest: ctx.diffDigest || null,
        })
      : { id: 'unsaved' };

    onProgress?.('handoff', 'Research complete.');

    return {
      runId,
      sessionId: session.id,
      report,
      toolContributions,
    };
  } finally {
    await cleanupContext(ctx.workspace).catch(() => {});
  }
}
