import readline from 'node:readline';
import type { EmbraceCheckpoint, EmbracePhaseStatus, EmbracePhaseType } from '@mmbridge/core';
import { EmbraceRenderer } from '../render/embrace-renderer.js';
import {
  exitWithError,
  importAdapters,
  importCore,
  importSessionStore,
  jsonOutput,
  resolveProjectDir,
} from './helpers.js';

export interface EmbraceCommandOptions {
  task: string;
  resume?: string;
  resolve?: string;
  skipPhases?: string;
  tool?: string;
  project?: string;
  json?: boolean;
  stream?: boolean;
  nonInteractive?: boolean;
}

function parseSkipPhases(raw: string | undefined): EmbracePhaseType[] {
  if (!raw) return [];
  const valid: EmbracePhaseType[] = ['research', 'debate', 'checkpoint', 'review', 'security', 'report'];
  return raw
    .split(',')
    .map((s) => s.trim() as EmbracePhaseType)
    .filter((s) => {
      if (!valid.includes(s)) {
        process.stderr.write(`[mmbridge] Unknown phase "${s}" in --skip-phases. Valid: ${valid.join(', ')}\n`);
        return false;
      }
      return true;
    });
}

function parseTools(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

async function promptUser(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function formatPhaseHeader(
  index: number,
  phaseType: string,
  status: string,
  score?: number,
  threshold?: number,
): string {
  const statusLabel =
    status === 'completed' && score !== undefined && threshold !== undefined
      ? `PASS ${score}/${threshold}`
      : status === 'paused'
        ? 'PAUSED'
        : status === 'failed'
          ? 'FAILED'
          : status === 'skipped'
            ? 'SKIPPED'
            : status.toUpperCase();
  return `\n── Phase ${index}: ${phaseType.charAt(0).toUpperCase() + phaseType.slice(1)} ── [${statusLabel}]`;
}

export async function runEmbraceCommand(options: EmbraceCommandOptions): Promise<void> {
  const projectDir = resolveProjectDir(options.project);
  const skipPhases = parseSkipPhases(options.skipPhases);
  const tools = parseTools(options.tool);

  const { runEmbracePipeline } = await importCore();
  const { defaultRegistry, runReviewAdapter } = await importAdapters(projectDir);
  const { SessionStore } = await importSessionStore();

  // Load EmbraceRunStore lazily to avoid coupling
  const { EmbraceRunStore } = await import('@mmbridge/session-store');

  const sessionStore = new SessionStore();
  const embraceRunStore = new EmbraceRunStore();

  const saveSession = (data: Parameters<typeof sessionStore.save>[0]) =>
    sessionStore.save({
      ...data,
      recalledMemoryIds: [],
      contextDigest: null,
    });

  const loadEmbraceRun = (id: string) => embraceRunStore.load(id);
  const saveEmbraceRun = (run: Parameters<typeof embraceRunStore.save>[0]) => embraceRunStore.save(run);

  // Validate tools if provided
  if (tools.length > 0 && !tools.includes('all')) {
    for (const tool of tools) {
      const adapter = defaultRegistry.get(tool);
      if (!adapter) {
        exitWithError(`Unknown tool: ${tool}. Available: ${defaultRegistry.list().join(', ')}`);
      }
    }
  }

  const isInteractive = !options.nonInteractive && process.stdin.isTTY;

  const onCheckpoint = async (checkpoint: EmbraceCheckpoint): Promise<string | null> => {
    if (!isInteractive) {
      return 'Proceed with current approach';
    }

    process.stdout.write('\n── Checkpoint ──\n');
    process.stdout.write(`  Context: ${checkpoint.context}\n`);
    process.stdout.write('  Options:\n');
    checkpoint.options.forEach((opt, idx) => {
      process.stdout.write(`    [${idx + 1}] ${opt}\n`);
    });

    const answer = await promptUser('\n  Enter option number or custom resolution (Enter to pause): ');

    if (!answer) return null;

    const num = Number.parseInt(answer, 10);
    if (!Number.isNaN(num) && num >= 1 && num <= checkpoint.options.length) {
      const selected = checkpoint.options[num - 1];
      if (selected === undefined) return null;
      return selected;
    }

    return answer;
  };

  if (options.stream) {
    const renderer = new EmbraceRenderer(options.task);
    renderer.start();

    const onProgress = (phase: EmbracePhaseType, status: EmbracePhaseStatus, detail: string): void => {
      renderer.updatePhase(phase, status, detail);
    };

    try {
      const result = await runEmbracePipeline({
        task: options.task,
        projectDir,
        baseRef: undefined,
        tools,
        skipPhases,
        resumeId: options.resume,
        resolveCheckpoint: options.resolve,
        nonInteractive: options.nonInteractive,
        onProgress,
        onCheckpoint,
        onStdout: (_tool, chunk) => {
          for (const line of chunk.split('\n')) {
            if (line.trim()) process.stdout.write(`  ${line}\n`);
          }
        },
        runAdapter: runReviewAdapter,
        listInstalledTools: () => defaultRegistry.listInstalled(),
        saveSession,
        loadEmbraceRun,
        saveEmbraceRun,
      });

      // Mark gates on renderer
      for (const phase of result.run.phases) {
        if (phase.gate) {
          renderer.setGate(phase.type, phase.gate.score, phase.gate.threshold);
        }
      }

      if (options.json) {
        jsonOutput({ runId: result.runId, run: result.run, report: result.report });
        return;
      }

      renderer.printReport(result.report);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[mmbridge] Embrace failed: ${message}\n`);
      process.exitCode = 1;
    } finally {
      renderer.cleanup();
    }

    return;
  }

  // Non-streaming mode
  try {
    const result = await runEmbracePipeline({
      task: options.task,
      projectDir,
      baseRef: undefined,
      tools,
      skipPhases,
      resumeId: options.resume,
      resolveCheckpoint: options.resolve,
      nonInteractive: options.nonInteractive,
      onCheckpoint,
      onStdout: (_tool, _chunk) => {
        // No streaming in non-stream mode
      },
      runAdapter: runReviewAdapter,
      listInstalledTools: () => defaultRegistry.listInstalled(),
      saveSession,
      loadEmbraceRun,
      saveEmbraceRun,
    });

    if (options.json) {
      jsonOutput({ runId: result.runId, run: result.run, report: result.report });
      return;
    }

    printEmbraceReport(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[mmbridge] Embrace failed: ${message}\n`);
    process.exitCode = 1;
  }
}

function printEmbraceReport(result: {
  runId: string;
  run: import('@mmbridge/core').EmbraceRun;
  report: import('@mmbridge/core').EmbraceReport;
}): void {
  const { run, report } = result;

  process.stdout.write(`\n=== MMBridge Embrace: ${run.task} ===\n`);

  run.phases.forEach((phase, index) => {
    const header = formatPhaseHeader(index + 1, phase.type, phase.status, phase.gate?.score, phase.gate?.threshold);
    process.stdout.write(`${header}\n`);

    if (phase.summary) {
      process.stdout.write(`  Summary: ${phase.summary}\n`);
    }

    if (phase.type === 'research' && phase.status === 'completed') {
      // Research detail pulled from summary
    }

    if (phase.type === 'review' && phase.findings.length > 0) {
      const critical = phase.findings.filter((f) => f.severity === 'CRITICAL').length;
      const warning = phase.findings.filter((f) => f.severity === 'WARNING').length;
      const info = phase.findings.filter((f) => f.severity === 'INFO').length;
      process.stdout.write(
        `  ${phase.findings.length} findings (${critical} critical, ${warning} warning, ${info} info)\n`,
      );
    }

    if (phase.type === 'security' && phase.findings.length > 0) {
      const secFindings = phase.findings as import('@mmbridge/core').SecurityFinding[];
      const p0 = secFindings.filter((f) => f.securitySeverity === 'P0').length;
      const p1 = secFindings.filter((f) => f.securitySeverity === 'P1').length;
      const p2 = secFindings.filter((f) => f.securitySeverity === 'P2').length;
      process.stdout.write(`  ${phase.findings.length} findings (${p0} P0, ${p1} P1, ${p2} P2)\n`);
    }
  });

  process.stdout.write('\n── Report ──\n');
  process.stdout.write(`  Overall Score: ${report.overallScore}/100\n`);

  if (report.recommendations.length > 0) {
    process.stdout.write('  Recommendations:\n');
    for (const rec of report.recommendations) {
      process.stdout.write(`    • ${rec}\n`);
    }
  }

  process.stdout.write(
    `  Total: ${run.totalAdapterInvocations} adapter invocations · ~${run.totalEstimatedTokens.toLocaleString()} estimated tokens\n`,
  );

  if (run.status === 'paused') {
    process.stdout.write(
      `\n[mmbridge] Run paused (ID: ${run.id}). To resume: mmbridge embrace "${run.task}" --resume ${run.id}\n`,
    );
  }
}
