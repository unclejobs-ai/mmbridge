import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cleanupContext, createContext } from './context.js';
import { buildRoundPrompt, computeVerdict, parsePositions } from './debate-rounds.js';
import { orchestrateReview } from './orchestrate.js';
import type { ReviewPipelineOptions } from './review-pipeline.js';
import { buildContextIndex, buildResultIndex } from './session-index.js';
import type { DebateRound, DebateRoundType, DebateTranscript, ResultIndex } from './types.js';
import { ensureDir, nowIso } from './utils.js';

export interface DebatePipelineOptions {
  proposition: string;
  rounds: number;
  tools: string[];
  teams?: { for: string[]; against: string[] };
  projectDir: string;
  baseRef?: string;
  onProgress?: (phase: string, detail: string) => void;
  onStdout?: (tool: string, chunk: string) => void;
  runAdapter: ReviewPipelineOptions['runAdapter'];
  listInstalledTools?: () => Promise<string[]>;
  saveSession?: ReviewPipelineOptions['saveSession'];
}

export interface DebatePipelineResult {
  runId: string;
  sessionId: string;
  transcript: DebateTranscript;
  toolContributions: Record<string, string[]>;
}

function roundTypeForNumber(roundNumber: number, totalRounds: number): DebateRoundType {
  if (roundNumber === 1) return 'position';
  if (roundNumber === totalRounds) return 'synthesis';
  return 'cross-examination';
}

async function writeDebatePrompt(workspace: string, tool: string, content: string): Promise<void> {
  const promptPath = path.join(workspace, `debate-prompt-${tool}.md`);
  await fs.writeFile(promptPath, content, 'utf8');
}

async function createDebateWorkspace(proposition: string, tools: string[]): Promise<string> {
  const workspace = path.join(os.tmpdir(), `mmbridge-debate-${randomUUID()}`);
  await ensureDir(workspace);

  // Write a brief context file so adapters know what they're working with
  const contextContent = [
    '# MMBridge Debate Session',
    '',
    `**Proposition**: ${proposition}`,
    '',
    `**Participants**: ${tools.join(', ')}`,
    '',
    'This is a structured debate session. Read your assigned prompt file and respond accordingly.',
  ].join('\n');

  await fs.writeFile(path.join(workspace, 'debate-context.md'), contextContent, 'utf8');
  return workspace;
}

export async function runDebatePipeline(options: DebatePipelineOptions): Promise<DebatePipelineResult> {
  const {
    proposition,
    rounds: totalRounds,
    tools,
    teams,
    projectDir,
    baseRef,
    onProgress,
    onStdout,
    runAdapter,
    saveSession,
  } = options;

  const runId = randomUUID();
  const completedRounds: DebateRound[] = [];
  const toolContributions: Record<string, string[]> = {};
  for (const tool of tools) {
    toolContributions[tool] = [];
  }

  // Determine whether to use a git-aware context or a plain debate workspace
  let workspace: string;
  let changedFiles: string[] = [];
  let diffDigest: string | null = null;
  let contextFromGit = false;

  onProgress?.('context', 'Setting up debate workspace...');

  // Try to build a git-aware context; fall back to plain workspace if project has no git changes
  try {
    const ctx = await createContext({
      projectDir,
      mode: 'debate',
      baseRef,
    });
    // Only use the git context if there are actual changed files to discuss
    if (ctx.changedFiles.length > 0) {
      workspace = ctx.workspace;
      changedFiles = ctx.changedFiles;
      diffDigest = ctx.diffDigest;
      contextFromGit = true;
    } else {
      await cleanupContext(ctx.workspace).catch(() => {});
      workspace = await createDebateWorkspace(proposition, tools);
    }
  } catch {
    workspace = await createDebateWorkspace(proposition, tools);
  }

  const contextIndex = buildContextIndex({
    workspace,
    projectDir,
    mode: 'debate',
    baseRef,
    diffDigest: diffDigest ?? undefined,
    changedFiles,
  });

  try {
    // Run each round sequentially — each round feeds on the previous output
    for (let roundNumber = 1; roundNumber <= totalRounds; roundNumber++) {
      const roundType = roundTypeForNumber(roundNumber, totalRounds);
      onProgress?.('round', `Round ${roundNumber}/${totalRounds}: ${roundType}`);

      // Write per-tool prompts into workspace so adapters can read them
      for (const tool of tools) {
        const prompt = buildRoundPrompt({
          proposition,
          roundNumber,
          roundType,
          tool,
          previousRounds: completedRounds,
          teams,
        });
        await writeDebatePrompt(workspace, tool, prompt);
      }

      // Run all tools for this round (sequentially via orchestrateReview which runs parallel,
      // but each *round* is sequential — rounds feed into each other)
      const orchResult = await orchestrateReview({
        tools,
        workspace,
        mode: 'debate',
        baseRef,
        changedFiles,
        runAdapter: (tool, adapterOpts) =>
          runAdapter(tool, {
            ...adapterOpts,
            cwd: projectDir,
          }),
        onStdout,
        onToolProgress: async (tool, status) => {
          onProgress?.('round', `Round ${roundNumber} — ${tool}: ${status}`);
        },
      });

      // Parse positions from each tool's output
      const positions = orchResult.results
        .filter((r) => !r.skipped)
        .map((r) => {
          const text = r.summary;
          toolContributions[r.tool]?.push(text);
          return parsePositions(r.tool, text, roundType);
        });

      const round: DebateRound = {
        roundNumber,
        type: roundType,
        positions,
      };

      // For synthesis rounds, extract top-level agreements/disagreements
      if (roundType === 'synthesis' && positions.length > 0) {
        const allArgs = positions.flatMap((p) => p.arguments);
        const agreementArgs = allArgs.filter(
          (a) => a.toLowerCase().includes('agree') || a.toLowerCase().includes('consensus'),
        );
        const disagreementArgs = allArgs.filter(
          (a) => a.toLowerCase().includes('disagree') || a.toLowerCase().includes('contend'),
        );
        if (agreementArgs.length > 0) round.agreements = agreementArgs.slice(0, 5);
        if (disagreementArgs.length > 0) round.disagreements = disagreementArgs.slice(0, 5);
      }

      completedRounds.push(round);
    }

    // Compute verdict from all rounds
    onProgress?.('verdict', 'Computing debate verdict...');
    const verdict = computeVerdict(completedRounds);

    const transcript: DebateTranscript = {
      proposition,
      teams,
      rounds: completedRounds,
      verdict,
      totalRounds,
      generatedAt: nowIso(),
    };

    // Build a summary for session storage
    const summary = [
      `Debate: "${proposition}"`,
      `${totalRounds} rounds · ${tools.length} participants`,
      `Verdict: ${verdict.conclusion}`,
    ].join(' | ');

    const resultIndex = buildResultIndex({
      summary,
      findings: [],
      parseState: 'debate',
      followupSupported: false,
    });

    // Save session
    const session = saveSession
      ? await saveSession({
          tool: 'debate',
          mode: 'debate',
          projectDir,
          workspace,
          runId,
          summary,
          findings: [],
          contextIndex,
          resultIndex,
          followupSupported: false,
          status: 'complete',
          diffDigest,
        })
      : { id: 'unsaved' };

    onProgress?.('handoff', 'Debate complete.');

    return {
      runId,
      sessionId: session.id,
      transcript,
      toolContributions,
    };
  } finally {
    if (!contextFromGit) {
      await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
    } else {
      await cleanupContext(workspace).catch(() => {});
    }
  }
}
