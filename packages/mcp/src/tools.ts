import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { defaultRegistry, runFollowupAdapter, runReviewAdapter } from '@mmbridge/adapters';
import { ContextAssembler, ContextTree, RecallEngine } from '@mmbridge/context-broker';
import {
  commandExists,
  evaluateGate,
  getChangedFiles,
  getDefaultBaseRef,
  getDiff,
  interpretFindings,
  runCommand,
  runDebatePipeline,
  runResearchPipeline,
  runReviewPipeline,
  runSecurityPipeline,
  shortDigest,
} from '@mmbridge/core';
import type { Finding } from '@mmbridge/core';
import { ProjectMemoryStore, RunStore, SessionStore } from '@mmbridge/session-store';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const store = new SessionStore();
const memoryStore = new ProjectMemoryStore();
const contextTree = new ContextTree();
const recallEngine = new RecallEngine({ sessionStore: store, memoryStore, contextTree });
const contextAssembler = new ContextAssembler({ contextTree, recallEngine, sessionStore: store });

export const TOOL_DEFINITIONS = [
  {
    name: 'mmbridge_review',
    description:
      'Run a code review using AI tools. Supports single-tool or multi-tool bridge mode with consensus analysis.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        tool: {
          type: 'string',
          enum: ['kimi', 'qwen', 'codex', 'gemini', 'droid', 'claude', 'all'],
          description: 'AI tool to use. "all" runs all installed tools with bridge consensus.',
        },
        mode: {
          type: 'string',
          enum: ['review', 'security', 'architecture'],
          default: 'review',
          description: 'Review mode',
        },
        bridge: {
          type: 'string',
          enum: ['none', 'standard', 'interpreted'],
          default: 'none',
          description: 'Bridge mode. "interpreted" adds Codex GPT-5.4 analysis.',
        },
        baseRef: {
          type: 'string',
          description: 'Git base ref for diff (default: auto-detected)',
        },
        projectDir: {
          type: 'string',
          description: 'Project directory (default: cwd)',
        },
      },
      required: ['tool'],
    },
  },
  {
    name: 'mmbridge_followup',
    description: 'Send a follow-up prompt to an existing review session for deeper analysis.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        tool: { type: 'string', description: 'AI tool that ran the original review' },
        sessionId: { type: 'string', description: 'External session ID from the original review' },
        prompt: { type: 'string', description: 'Follow-up question or analysis request' },
        projectDir: { type: 'string', description: 'Project directory (default: cwd)' },
      },
      required: ['tool', 'sessionId', 'prompt'],
    },
  },
  {
    name: 'mmbridge_interpret',
    description:
      'Request additional interpretation of review findings using Codex GPT-5.4. Filters false positives and generates action plans.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        findings: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              severity: { type: 'string' },
              file: { type: 'string' },
              line: { type: 'number' },
              message: { type: 'string' },
            },
          },
          description: 'Findings to interpret',
        },
        changedFiles: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of changed file paths for context',
        },
        projectDir: { type: 'string', description: 'Project directory (default: cwd)' },
      },
      required: ['findings', 'changedFiles'],
    },
  },
  {
    name: 'mmbridge_sessions',
    description: 'List recent review sessions with summaries and finding counts.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        tool: { type: 'string', description: 'Filter by tool name' },
        limit: { type: 'number', default: 10, description: 'Max sessions to return' },
        query: { type: 'string', description: 'Text search in summaries and findings' },
        severity: {
          type: 'string',
          enum: ['CRITICAL', 'WARNING', 'INFO', 'REFACTOR'],
          description: 'Filter by severity',
        },
        projectDir: { type: 'string', description: 'Project directory (default: cwd)' },
      },
    },
  },
  {
    name: 'mmbridge_search',
    description: 'Search review sessions by query string, file path, or severity filter.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Text to search in findings and summaries' },
        file: { type: 'string', description: 'Filter findings by file path (substring match)' },
        severity: {
          type: 'string',
          enum: ['CRITICAL', 'WARNING', 'INFO', 'REFACTOR'],
          description: 'Filter by exact severity level',
        },
        tool: { type: 'string', description: 'Filter by tool name' },
        limit: { type: 'number', default: 20, description: 'Max results to return' },
        projectDir: { type: 'string', description: 'Project directory (default: cwd)' },
      },
    },
  },
  {
    name: 'mmbridge_research',
    description: 'Research a topic using multiple AI models with insight synthesis and consensus detection.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        topic: { type: 'string', description: 'Research topic or question' },
        type: { type: 'string', enum: ['code-aware', 'open'], default: 'open', description: 'Research type' },
        tools: { type: 'string', description: 'Comma-separated tool names (default: all)' },
        projectDir: { type: 'string', description: 'Project directory (default: cwd)' },
      },
      required: ['topic'],
    },
  },
  {
    name: 'mmbridge_debate',
    description: 'Multi-round debate between AI models on a proposition with verdict synthesis.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        proposition: { type: 'string', description: 'Proposition to debate' },
        rounds: { type: 'number', default: 3, description: 'Number of debate rounds' },
        teams: { type: 'string', description: 'Team spec "for_tools:against_tools"' },
        projectDir: { type: 'string', description: 'Project directory (default: cwd)' },
      },
      required: ['proposition'],
    },
  },
  {
    name: 'mmbridge_security',
    description: 'Comprehensive security audit with CWE classification, severity mapping, and attack surface analysis.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        scope: { type: 'string', enum: ['auth', 'api', 'infra', 'all'], default: 'all', description: 'Audit scope' },
        tools: { type: 'string', description: 'Comma-separated tool names' },
        compliance: { type: 'string', description: 'Comma-separated compliance frameworks' },
        bridge: { type: 'string', enum: ['none', 'standard', 'interpreted'], default: 'standard' },
        projectDir: { type: 'string', description: 'Project directory (default: cwd)' },
      },
    },
  },
  {
    name: 'mmbridge_embrace',
    description: 'Full development lifecycle: research → debate → checkpoint → review → security → report.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        task: { type: 'string', description: 'Task description for the full lifecycle' },
        resumeId: { type: 'string', description: 'ID of paused embrace run to resume' },
        resolveCheckpoint: { type: 'string', description: 'Response to resolve a checkpoint' },
        skipPhases: { type: 'string', description: 'Comma-separated phases to skip' },
        projectDir: { type: 'string', description: 'Project directory (default: cwd)' },
      },
      required: ['task'],
    },
  },
  {
    name: 'mmbridge_gate',
    description: 'Evaluate review freshness and unresolved critical findings for a project diff.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectDir: { type: 'string', description: 'Project directory (default: cwd)' },
        baseRef: { type: 'string', description: 'Git base ref for diff' },
        mode: { type: 'string', enum: ['review', 'security', 'architecture'], default: 'review' },
      },
    },
  },
  {
    name: 'mmbridge_handoff',
    description: 'Fetch the latest handoff artifact or a handoff for a specific session.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectDir: { type: 'string', description: 'Project directory (default: cwd)' },
        session: { type: 'string', description: 'Session ID to fetch handoff for' },
      },
    },
  },
  {
    name: 'mmbridge_doctor',
    description: 'Inspect mmbridge tooling, adapter availability, and local runtime hints.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectDir: { type: 'string', description: 'Project directory (default: cwd)' },
      },
    },
  },
  {
    name: 'mmbridge_context_packet',
    description:
      'Assemble a ContextPacket with project state, recall entries, gate signals, and suggested commands for a given task.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        task: { type: 'string', description: 'Task description to build context for' },
        command: { type: 'string', default: 'mmbridge review', description: 'mmbridge command being executed' },
        projectDir: { type: 'string', description: 'Project directory (default: cwd)' },
        parentNodeId: { type: 'string', description: 'Parent context-tree node ID for branching' },
        recallBudget: { type: 'number', description: 'Max recall tokens (default: 2000)' },
      },
      required: ['task'],
    },
  },
];

function textContent(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], ...(isError && { isError: true }) };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function resolveProjectDirArg(args: Record<string, unknown>): string {
  const projectDir = args.projectDir;
  return typeof projectDir === 'string' && projectDir.trim().length > 0 ? projectDir : process.cwd();
}

function toGateSession(
  session: {
    id: string;
    tool: string;
    mode: string;
    externalSessionId?: string | null;
    followupSupported?: boolean;
    findings?: Finding[];
    findingDecisions?: Array<{ key: string; status: 'accepted' | 'dismissed' }>;
  } | null,
) {
  if (!session) return null;
  return {
    id: session.id,
    tool: session.tool,
    mode: session.mode,
    externalSessionId: session.externalSessionId ?? null,
    followupSupported: session.followupSupported ?? false,
    findings: session.findings ?? [],
    findingDecisions: session.findingDecisions ?? [],
  };
}

async function buildDoctorReport(projectDir: string) {
  const adapterBinaries = defaultRegistry.values().map((adapter) => adapter.binary);
  const binaries = Array.from(new Set([...adapterBinaries, 'claude']));
  const checks = await Promise.all(
    binaries.map(async (binary) => ({
      binary,
      installed: await commandExists(binary).catch(() => false),
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

  return {
    generatedAt: new Date().toISOString(),
    projectDir,
    checks,
    mmbridgeHome,
    claudeAgentsDir,
    runtimeAuthModel,
    sessionFileHints,
  };
}

export function registerToolHandlers(server: Server): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const safeArgs = (args ?? {}) as Record<string, unknown>;

    switch (name) {
      case 'mmbridge_review':
        return handleReview(safeArgs, server);
      case 'mmbridge_followup':
        return handleFollowup(safeArgs);
      case 'mmbridge_interpret':
        return handleInterpret(safeArgs);
      case 'mmbridge_sessions':
        return handleSessions(safeArgs);
      case 'mmbridge_search':
        return handleSearch(safeArgs);
      case 'mmbridge_research':
        return handleResearch(safeArgs, server);
      case 'mmbridge_debate':
        return handleDebate(safeArgs, server);
      case 'mmbridge_security':
        return handleSecurity(safeArgs, server);
      case 'mmbridge_embrace':
        return handleEmbrace(safeArgs, server);
      case 'mmbridge_gate':
        return handleGate(safeArgs);
      case 'mmbridge_handoff':
        return handleHandoff(safeArgs);
      case 'mmbridge_doctor':
        return handleDoctor(safeArgs);
      case 'mmbridge_context_packet':
        return handleContextPacket(safeArgs);
      default:
        return textContent(`Unknown tool: ${name}`, true);
    }
  });
}

async function handleReview(args: Record<string, unknown>, server: Server) {
  const tool = String(args.tool ?? 'kimi');
  const mode = String(args.mode ?? 'review');
  const bridge = args.bridge === undefined ? undefined : (String(args.bridge) as 'none' | 'standard' | 'interpreted');
  const baseRef = args.baseRef as string | undefined;
  const projectDir = resolveProjectDirArg(args);

  try {
    const result = await runReviewPipeline({
      tool,
      mode,
      projectDir,
      baseRef,
      bridge,
      runAdapter: runReviewAdapter,
      listInstalledTools: () => defaultRegistry.listInstalled(),
      saveSession: (data) => store.save(data),
      onProgress: (phase, detail) => {
        server.sendLoggingMessage({ level: 'info', data: `[${phase}] ${detail}` }).catch(() => {});
      },
    });

    return textContent(JSON.stringify(result, null, 2));
  } catch (err) {
    return textContent(`Review failed: ${errorMessage(err)}`, true);
  }
}

async function handleFollowup(args: Record<string, unknown>) {
  const tool = String(args.tool);
  const sessionId = String(args.sessionId);
  const prompt = String(args.prompt);

  try {
    const result = await runFollowupAdapter(tool, {
      workspace: resolveProjectDirArg(args),
      sessionId,
      prompt,
    });

    return textContent(JSON.stringify({ tool, sessionId, text: result.text, ok: result.ok }, null, 2));
  } catch (err) {
    return textContent(`Followup failed: ${errorMessage(err)}`, true);
  }
}

async function handleInterpret(args: Record<string, unknown>) {
  if (!Array.isArray(args.findings)) {
    return textContent('findings must be an array', true);
  }
  const rawFindings = args.findings as Array<Record<string, unknown>>;
  const findings: Finding[] = rawFindings.map((f) => ({
    severity: String(f.severity ?? 'INFO') as Finding['severity'],
    file: String(f.file ?? ''),
    line: typeof f.line === 'number' ? f.line : null,
    message: String(f.message ?? ''),
  }));
  const changedFiles = Array.isArray(args.changedFiles) ? (args.changedFiles as string[]) : [];

  try {
    const result = await interpretFindings({
      mergedFindings: findings,
      changedFiles,
      projectContext: '',
      workspace: resolveProjectDirArg(args),
    });
    return textContent(JSON.stringify(result, null, 2));
  } catch (err) {
    return textContent(`Interpret failed: ${errorMessage(err)}`, true);
  }
}

async function handleSessions(args: Record<string, unknown>) {
  const projectDir = resolveProjectDirArg(args);
  const tool = args.tool as string | undefined;
  const limit = typeof args.limit === 'number' ? args.limit : 10;
  const query = args.query as string | undefined;
  const severity = args.severity as string | undefined;
  const sessions = await store.list({ projectDir, tool, query, severity, limit });

  const result = sessions.slice(0, limit).map((s) => ({
    id: s.id,
    tool: s.tool,
    mode: s.mode,
    createdAt: s.createdAt,
    findingCount: (s.findings ?? []).length,
    summary: s.summary?.slice(0, 100),
    followupSupported: s.followupSupported ?? false,
    externalSessionId: s.externalSessionId ?? null,
  }));

  return textContent(JSON.stringify(result, null, 2));
}

async function handleSearch(args: Record<string, unknown>) {
  const projectDir = resolveProjectDirArg(args);
  const query = args.query as string | undefined;
  const file = args.file as string | undefined;
  const severity = args.severity as string | undefined;
  const tool = args.tool as string | undefined;
  const limit = typeof args.limit === 'number' ? args.limit : 20;

  if (!query && !file && !severity && !tool) {
    return textContent('At least one filter (query, file, severity, or tool) is required.', true);
  }

  const sessions = await store.list({ projectDir, tool, query, file, severity, limit });

  interface SearchResult {
    sessionId: string;
    tool: string;
    mode: string;
    createdAt: string;
    finding: { severity: string; file: string; line: number | null; message: string };
  }

  const results: SearchResult[] = [];

  const q = query?.toLowerCase();
  const sevUpper = severity?.toUpperCase();

  for (const session of sessions) {
    for (const finding of session.findings ?? []) {
      if (q && !finding.message?.toLowerCase().includes(q) && !finding.file?.toLowerCase().includes(q)) continue;
      if (file && !finding.file?.includes(file)) continue;
      if (sevUpper && finding.severity !== sevUpper) continue;

      results.push({
        sessionId: session.id,
        tool: session.tool,
        mode: session.mode,
        createdAt: session.createdAt,
        finding: {
          severity: finding.severity,
          file: finding.file,
          line: finding.line,
          message: finding.message,
        },
      });

      if (results.length >= limit) break;
    }
    if (results.length >= limit) break;
  }

  return textContent(JSON.stringify(results, null, 2));
}

async function handleResearch(args: Record<string, unknown>, server: Server) {
  const topic = String(args.topic);
  const type = String(args.type ?? 'open') as 'code-aware' | 'open';
  const toolsStr = args.tools as string | undefined;
  const tools = toolsStr ? toolsStr.split(',').map((t) => t.trim()) : await defaultRegistry.listInstalled();
  const projectDir = resolveProjectDirArg(args);

  try {
    const result = await runResearchPipeline({
      topic,
      type,
      tools,
      projectDir,
      runAdapter: runReviewAdapter,
      listInstalledTools: () => defaultRegistry.listInstalled(),
      saveSession: (data) => store.save(data),
      onProgress: (phase, detail) => {
        server.sendLoggingMessage({ level: 'info', data: `[${phase}] ${detail}` }).catch(() => {});
      },
    });
    return textContent(JSON.stringify(result.report, null, 2));
  } catch (err) {
    return textContent(`Research failed: ${errorMessage(err)}`, true);
  }
}

async function handleDebate(args: Record<string, unknown>, server: Server) {
  const proposition = String(args.proposition);
  const rounds = typeof args.rounds === 'number' ? args.rounds : 3;
  const teamsStr = args.teams as string | undefined;
  const tools = await defaultRegistry.listInstalled();
  const projectDir = resolveProjectDirArg(args);

  let teams: { for: string[]; against: string[] } | undefined;
  if (teamsStr) {
    const [forStr, againstStr] = teamsStr.split(':');
    teams = {
      for: (forStr ?? '').split(',').map((t) => t.trim()),
      against: (againstStr ?? '').split(',').map((t) => t.trim()),
    };
  }

  try {
    const result = await runDebatePipeline({
      proposition,
      rounds,
      tools,
      teams,
      projectDir,
      runAdapter: runReviewAdapter,
      listInstalledTools: () => defaultRegistry.listInstalled(),
      saveSession: (data) => store.save(data),
      onProgress: (phase, detail) => {
        server.sendLoggingMessage({ level: 'info', data: `[${phase}] ${detail}` }).catch(() => {});
      },
    });
    return textContent(JSON.stringify(result.transcript, null, 2));
  } catch (err) {
    return textContent(`Debate failed: ${errorMessage(err)}`, true);
  }
}

async function handleSecurity(args: Record<string, unknown>, server: Server) {
  const scope = String(args.scope ?? 'all') as 'auth' | 'api' | 'infra' | 'all';
  const toolsStr = args.tools as string | undefined;
  const tools = toolsStr ? toolsStr.split(',').map((t) => t.trim()) : await defaultRegistry.listInstalled();
  const complianceStr = args.compliance as string | undefined;
  const compliance = complianceStr ? complianceStr.split(',').map((c) => c.trim()) : undefined;
  const bridge = args.bridge === undefined ? undefined : (String(args.bridge) as 'none' | 'standard' | 'interpreted');
  const projectDir = resolveProjectDirArg(args);

  try {
    const result = await runSecurityPipeline({
      scope,
      tools,
      projectDir,
      compliance,
      bridge: bridge ?? 'standard',
      runAdapter: runReviewAdapter,
      listInstalledTools: () => defaultRegistry.listInstalled(),
      saveSession: (data) => store.save(data),
      onProgress: (phase, detail) => {
        server.sendLoggingMessage({ level: 'info', data: `[${phase}] ${detail}` }).catch(() => {});
      },
    });
    return textContent(JSON.stringify(result.report, null, 2));
  } catch (err) {
    return textContent(`Security audit failed: ${errorMessage(err)}`, true);
  }
}

async function handleContextPacket(args: Record<string, unknown>) {
  const task = String(args.task);
  const command = String(args.command ?? 'mmbridge review');
  const projectDir = resolveProjectDirArg(args);
  const parentNodeId = args.parentNodeId as string | undefined;
  const recallBudget = typeof args.recallBudget === 'number' ? args.recallBudget : undefined;

  try {
    const packet = await contextAssembler.assemble({
      projectDir,
      task,
      command,
      parentNodeId,
      recallBudget,
    });
    return textContent(JSON.stringify(packet, null, 2));
  } catch (err) {
    return textContent(`Context packet assembly failed: ${errorMessage(err)}`, true);
  }
}

async function handleEmbrace(args: Record<string, unknown>, server: Server) {
  const task = String(args.task);
  const resumeId = args.resumeId as string | undefined;
  const resolveCheckpoint = args.resolveCheckpoint as string | undefined;
  const skipPhasesStr = args.skipPhases as string | undefined;
  const skipPhases = skipPhasesStr ? skipPhasesStr.split(',').map((p) => p.trim()) : undefined;
  const projectDir = resolveProjectDirArg(args);
  const tools = await defaultRegistry.listInstalled();

  try {
    const { runEmbracePipeline } = await import('@mmbridge/core');
    const result = await runEmbracePipeline({
      task,
      projectDir,
      tools,
      resumeId,
      resolveCheckpoint,
      skipPhases: skipPhases as import('@mmbridge/core').EmbracePhaseType[] | undefined,
      nonInteractive: true,
      runAdapter: runReviewAdapter,
      listInstalledTools: () => defaultRegistry.listInstalled(),
      saveSession: (data: Parameters<typeof store.save>[0]) => store.save(data),
      onProgress: (phase: string, _status: string, detail: string) => {
        server.sendLoggingMessage({ level: 'info', data: `[${phase}] ${detail}` }).catch(() => {});
      },
    });
    return textContent(JSON.stringify(result.report, null, 2));
  } catch (err) {
    return textContent(`Embrace failed: ${errorMessage(err)}`, true);
  }
}

async function handleGate(args: Record<string, unknown>) {
  const projectDir = resolveProjectDirArg(args);
  const mode = String(args.mode ?? 'review');
  let baseRef = (args.baseRef as string | undefined) ?? null;
  let diffDigest: string | null = null;
  let changedFilesCount = 0;

  const gitRoot = await runCommand('git', ['rev-parse', '--is-inside-work-tree'], { cwd: projectDir }).catch(
    () => null,
  );
  if (gitRoot?.ok && gitRoot.stdout.trim() === 'true') {
    baseRef = baseRef ?? (await getDefaultBaseRef(projectDir));
    const [diffText, changedFiles] = await Promise.all([
      getDiff(baseRef, projectDir),
      getChangedFiles(baseRef, projectDir),
    ]);
    diffDigest = shortDigest(diffText);
    changedFilesCount = changedFiles.length;
  }

  const runStore = new RunStore(store.baseDir);
  const [latestRun, latestSessions, latestHandoff] = await Promise.all([
    runStore.getLatest({ projectDir, mode }),
    store.list({ projectDir, mode, limit: 1 }),
    memoryStore.getLatestHandoff(projectDir).catch(() => null),
  ]);

  const handoffDocument =
    latestSessions[0]?.id != null
      ? await memoryStore.getHandoffBySession(projectDir, latestSessions[0].id).catch(() => null)
      : null;

  const result = evaluateGate({
    current: {
      projectDir,
      mode,
      baseRef,
      diffDigest,
      changedFilesCount,
      explicitMode: typeof args.mode === 'string',
    },
    latestRun,
    latestSession: toGateSession(latestSessions[0] ?? null),
    latestHandoff: handoffDocument
      ? {
          artifact: {
            sessionId: handoffDocument.artifact.sessionId,
            nextCommand: handoffDocument.artifact.nextCommand,
            openBlockers: handoffDocument.artifact.openBlockers,
          },
          recommendedNextCommand: handoffDocument.recommendedNextCommand,
        }
      : latestHandoff
        ? {
            artifact: {
              sessionId: latestHandoff.sessionId,
              nextCommand: latestHandoff.nextCommand,
              openBlockers: latestHandoff.openBlockers,
            },
            recommendedNextCommand: latestHandoff.nextCommand,
          }
        : null,
  });

  return textContent(JSON.stringify(result, null, 2));
}

async function handleHandoff(args: Record<string, unknown>) {
  const projectDir = resolveProjectDirArg(args);
  const sessionId = args.session as string | undefined;

  let document = null;
  if (sessionId) {
    document = await memoryStore.getHandoffBySession(projectDir, sessionId).catch(() => null);
  } else {
    const latest = await memoryStore.getLatestHandoff(projectDir).catch(() => null);
    document = latest ? await memoryStore.getHandoffBySession(projectDir, latest.sessionId).catch(() => null) : null;
  }

  if (!document) {
    return textContent('No handoff found for this project.', true);
  }

  return textContent(JSON.stringify(document, null, 2));
}

async function handleDoctor(args: Record<string, unknown>) {
  const projectDir = resolveProjectDirArg(args);
  try {
    const report = await buildDoctorReport(projectDir);
    return textContent(JSON.stringify(report, null, 2));
  } catch (err) {
    return textContent(`Doctor failed: ${errorMessage(err)}`, true);
  }
}
