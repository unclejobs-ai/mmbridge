import type { DebateTranscript } from '@mmbridge/core';
import { StreamRenderer } from '../render/stream-renderer.js';
import {
  exitWithError,
  importAdapters,
  importCore,
  importSessionStore,
  jsonOutput,
  resolveProjectDir,
} from './helpers.js';

export interface DebateCommandOptions {
  proposition: string;
  rounds?: string;
  teams?: string;
  tool?: string;
  project?: string;
  json?: boolean;
  stream?: boolean;
}

function parseTeams(spec: string): { for: string[]; against: string[] } | undefined {
  const parts = spec.split(':');
  if (parts.length !== 2) return undefined;
  const forTools = (parts[0] ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  const againstTools = (parts[1] ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  if (forTools.length === 0 || againstTools.length === 0) return undefined;
  return { for: forTools, against: againstTools };
}

function printTranscript(transcript: DebateTranscript, tools: string[]): void {
  process.stdout.write('\n=== MMBridge Debate ===\n');
  process.stdout.write(`Proposition: ${transcript.proposition}\n`);
  process.stdout.write(`Rounds: ${transcript.totalRounds} | Tools: ${tools.join(', ')}\n`);

  if (transcript.teams) {
    process.stdout.write(
      `Teams — For: ${transcript.teams.for.join(', ')} | Against: ${transcript.teams.against.join(', ')}\n`,
    );
  }

  for (const round of transcript.rounds) {
    const roundLabel =
      round.type === 'position' ? 'Position' : round.type === 'cross-examination' ? 'Cross-Examination' : 'Synthesis';
    process.stdout.write(`\n── Round ${round.roundNumber}: ${roundLabel} ──\n`);

    for (const pos of round.positions) {
      process.stdout.write(`[${pos.source}] Stance: ${pos.stance}\n`);
      if (pos.arguments.length > 0) {
        process.stdout.write('  Arguments:\n');
        for (const arg of pos.arguments) {
          process.stdout.write(`    - ${arg}\n`);
        }
      }
      if (pos.evidence.length > 0) {
        process.stdout.write('  Evidence:\n');
        for (const ev of pos.evidence) {
          process.stdout.write(`    - ${ev}\n`);
        }
      }
      process.stdout.write(`  Confidence: ${pos.confidence}\n`);
    }

    if (round.agreements && round.agreements.length > 0) {
      process.stdout.write('  Agreements:\n');
      for (const a of round.agreements) {
        process.stdout.write(`    - ${a}\n`);
      }
    }
    if (round.disagreements && round.disagreements.length > 0) {
      process.stdout.write('  Disagreements:\n');
      for (const d of round.disagreements) {
        process.stdout.write(`    - ${d}\n`);
      }
    }
  }

  const { verdict } = transcript;
  process.stdout.write('\n── Verdict ──\n');
  process.stdout.write(`Conclusion: ${verdict.conclusion}\n`);

  if (verdict.agreements.length > 0) {
    process.stdout.write('Agreements:\n');
    for (const a of verdict.agreements) {
      process.stdout.write(`  - ${a}\n`);
    }
  }

  if (verdict.disagreements.length > 0) {
    process.stdout.write('Disagreements:\n');
    for (const d of verdict.disagreements) {
      process.stdout.write(`  - ${d}\n`);
    }
  }

  if (verdict.novelInsights.length > 0) {
    process.stdout.write('Novel Insights:\n');
    for (const insight of verdict.novelInsights) {
      process.stdout.write(`  - ${insight}\n`);
    }
  }

  process.stdout.write(`Recommended Action: ${verdict.recommendedAction}\n`);
}

export async function runDebateCommand(options: DebateCommandOptions): Promise<void> {
  const { proposition } = options;
  const projectDir = resolveProjectDir(options.project);
  const totalRounds = options.rounds ? Number.parseInt(options.rounds, 10) : 3;
  const teams = options.teams ? parseTeams(options.teams) : undefined;

  if (Number.isNaN(totalRounds) || totalRounds < 2) {
    exitWithError('--rounds must be an integer >= 2');
  }

  if (!proposition || proposition.trim().length === 0) {
    exitWithError('A proposition is required for the debate command.');
  }

  const { runDebatePipeline } = await import('@mmbridge/core');
  const { defaultRegistry, runReviewAdapter } = await importAdapters(projectDir);
  const { SessionStore } = await importSessionStore();
  const { commandExists } = await importCore();

  // Resolve tools
  let tools: string[];
  if (options.tool) {
    tools = options.tool
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    // Validate each tool
    for (const tool of tools) {
      const adapter = defaultRegistry.get(tool);
      if (!adapter) {
        exitWithError(`Unknown tool: ${tool}. Available: ${defaultRegistry.list().join(', ')}`);
      }
      const isInstalled = await commandExists(adapter.binary);
      if (!isInstalled) {
        exitWithError(`Binary "${adapter.binary}" not found in PATH. Install it to use the "${tool}" adapter.`);
      }
    }
  } else {
    tools = await defaultRegistry.listInstalled();
    if (tools.length === 0) {
      exitWithError('No review tools installed. Run `mmbridge doctor` to check your setup.');
    }
  }

  // Validate teams reference valid tools
  if (teams) {
    const allTeamTools = [...teams.for, ...teams.against];
    for (const t of allTeamTools) {
      if (!tools.includes(t)) {
        exitWithError(`Team tool "${t}" is not in the resolved tool list: ${tools.join(', ')}`);
      }
    }
  }

  const sessionStore = new SessionStore();

  const saveSession = (data: Parameters<typeof sessionStore.save>[0]) =>
    sessionStore.save({
      ...data,
      recalledMemoryIds: [],
      contextDigest: null,
    });

  if (options.stream) {
    const renderer = new StreamRenderer('debate', 'debate');
    const startedAt = Date.now();
    renderer.start();

    try {
      const result = await runDebatePipeline({
        proposition,
        rounds: totalRounds,
        tools,
        teams,
        projectDir,
        runAdapter: runReviewAdapter,
        saveSession,
        onProgress: (phase, detail) => renderer.phase(phase, detail),
        onStdout: (_tool, chunk) => {
          for (const line of chunk.split('\n')) {
            renderer.streamLine(line);
          }
        },
      });

      const elapsedMs = Date.now() - startedAt;
      const elapsed = elapsedMs < 1000 ? `${elapsedMs}ms` : `${(elapsedMs / 1000).toFixed(1)}s`;

      renderer.printFindings([]);
      renderer.printSummary([], elapsed);
      renderer.done(result.sessionId);

      if (options.json) {
        jsonOutput(result.transcript);
        return;
      }

      printTranscript(result.transcript, tools);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[mmbridge] Debate failed: ${message}\n`);
      process.exitCode = 1;
    } finally {
      renderer.cleanup();
    }

    return;
  }

  // Non-streaming path
  try {
    const result = await runDebatePipeline({
      proposition,
      rounds: totalRounds,
      tools,
      teams,
      projectDir,
      runAdapter: runReviewAdapter,
      saveSession,
    });

    if (options.json) {
      jsonOutput(result.transcript);
      return;
    }

    printTranscript(result.transcript, tools);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[mmbridge] Debate failed: ${message}\n`);
    process.exitCode = 1;
  }
}
