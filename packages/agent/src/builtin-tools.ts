import type { AgentTool } from './types.js';

// ─── mmbridge_review ──────────────────────────────────────────────────────────

export const mmbridge_review: AgentTool = {
  name: 'mmbridge_review',
  description:
    'Run a multi-model code review on staged or changed files. ' +
    'Aggregates findings from Kimi, Qwen, Codex, and Gemini and returns a unified report.',
  inputSchema: {
    type: 'object',
    properties: {
      tool: {
        type: 'string',
        description: 'Adapter to use (e.g. "kimi", "qwen", "codex", "gemini", "all"). Defaults to "kimi".',
      },
      mode: {
        type: 'string',
        enum: ['quick', 'full', 'review'],
        description: 'Review depth: "quick" for diff only, "full" for full context, "review" is default.',
      },
      scope: {
        type: 'string',
        description: 'Optional file glob to restrict review scope (e.g. "src/**/*.ts").',
      },
    },
    required: [],
  },
  async execute(input: Record<string, unknown>): Promise<string> {
    try {
      const tool = typeof input.tool === 'string' ? input.tool : 'kimi';
      const mode = typeof input.mode === 'string' ? input.mode : 'review';
      const projectDir = process.cwd();

      const { runReviewPipeline } = await import('@mmbridge/core');
      const { defaultRegistry, runReviewAdapter, initRegistry } = await import('@mmbridge/adapters');
      const { SessionStore, RunStore, ProjectMemoryStore } = await import('@mmbridge/session-store');

      await initRegistry(projectDir);

      const sessionStore = new SessionStore();
      const runStore = new RunStore(sessionStore.baseDir);
      const memoryStore = new ProjectMemoryStore(sessionStore.baseDir);

      const recall = await memoryStore.buildRecall(projectDir, { mode, tool });

      const result = await runReviewPipeline({
        tool,
        mode,
        projectDir,
        recallPromptContext: recall.promptContext,
        recallSummary: recall.summary,
        runAdapter: runReviewAdapter,
        listInstalledTools: () => defaultRegistry.listInstalled(),
        saveSession: async (data) => {
          const session = await sessionStore.save({
            ...data,
            recalledMemoryIds: recall.recalledMemoryIds,
            contextDigest: null,
          });
          return { id: session.id };
        },
        persistRun: async (run) => {
          await runStore.save(run);
        },
        onContextReady: () => {},
      });

      const { findings } = result;
      if (findings.length === 0) {
        return `Review complete (${tool}): No findings.`;
      }

      const lines = findings.map((f) => {
        const location = f.line != null ? `${f.file}:${f.line}` : f.file;
        return `[${f.severity}] ${location}: ${f.message}`;
      });
      return `Review complete (${tool}): ${findings.length} finding(s)\n${lines.join('\n')}`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Review failed: ${message}`;
    }
  },
};

// ─── mmbridge_security ────────────────────────────────────────────────────────

export const mmbridge_security: AgentTool = {
  name: 'mmbridge_security',
  description:
    'Run a security audit using multiple models. Checks for CWE vulnerabilities, ' +
    'secret exposure, and attack surface issues. Returns severity-ranked findings.',
  inputSchema: {
    type: 'object',
    properties: {
      scope: {
        type: 'string',
        enum: ['all', 'auth', 'api', 'infra'],
        description: 'Optional scope to restrict audit (defaults to "all").',
      },
      tools: {
        type: 'array',
        items: { type: 'string' },
        description: 'Adapters to run (e.g. ["kimi", "qwen"]). Defaults to all installed.',
      },
    },
    required: [],
  },
  async execute(input: Record<string, unknown>): Promise<string> {
    try {
      const rawScope = typeof input.scope === 'string' ? input.scope : 'all';
      const scope = (['all', 'auth', 'api', 'infra'] as const).includes(rawScope as 'all' | 'auth' | 'api' | 'infra')
        ? (rawScope as 'all' | 'auth' | 'api' | 'infra')
        : ('all' as const);

      const projectDir = process.cwd();

      const { runSecurityPipeline } = await import('@mmbridge/core');
      const { defaultRegistry, runReviewAdapter, initRegistry } = await import('@mmbridge/adapters');
      const { SessionStore, RunStore, ProjectMemoryStore } = await import('@mmbridge/session-store');

      await initRegistry(projectDir);

      const inputTools = Array.isArray(input.tools)
        ? input.tools.filter((t): t is string => typeof t === 'string')
        : ['all'];

      const sessionStore = new SessionStore();
      const runStore = new RunStore(sessionStore.baseDir);
      const memoryStore = new ProjectMemoryStore(sessionStore.baseDir);
      const recall = await memoryStore.buildRecall(projectDir, { mode: 'security-audit' });

      const result = await runSecurityPipeline({
        scope,
        tools: inputTools,
        projectDir,
        runAdapter: runReviewAdapter,
        listInstalledTools: () => defaultRegistry.listInstalled(),
        saveSession: async (data) => {
          const session = await sessionStore.save({
            ...data,
            recalledMemoryIds: recall.recalledMemoryIds,
            contextDigest: null,
          });
          await runStore.save({
            id: data.runId ?? undefined,
            tool: data.tool,
            mode: data.mode,
            projectDir,
            baseRef: null,
            diffDigest: data.diffDigest ?? null,
            changedFiles: 0,
            status: 'completed',
            phase: 'handoff',
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            findingsSoFar: data.findings.length,
            warnings: [],
            sessionId: session.id,
            lanes: [],
          });
          return { id: session.id };
        },
      });

      const { report } = result;
      if (report.findings.length === 0) {
        return `Security audit (${scope}): No findings.`;
      }

      const lines = report.findings.map((f) => {
        const location = f.line != null ? `${f.file}:${f.line}` : f.file;
        const cweTag = f.cwe.length > 0 ? ` [${f.cwe.map((c) => c.id).join(', ')}]` : '';
        return `[${f.securitySeverity}]${cweTag} ${location}: ${f.message}`;
      });
      const counts = report.severityCounts;
      const summary = [`P0: ${counts.P0}`, `P1: ${counts.P1}`, `P2: ${counts.P2}`, `P3: ${counts.P3}`].join(', ');
      return `Security audit (${scope}): ${report.findings.length} finding(s) — ${summary}\n${lines.join('\n')}`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Security audit failed: ${message}`;
    }
  },
};

// ─── mmbridge_research ────────────────────────────────────────────────────────

export const mmbridge_research: AgentTool = {
  name: 'mmbridge_research',
  description:
    'Research a technical topic using multiple models and synthesize insights. ' +
    'Useful for evaluating libraries, architectures, or unfamiliar code patterns.',
  inputSchema: {
    type: 'object',
    properties: {
      topic: {
        type: 'string',
        description: 'The topic or question to research.',
      },
      depth: {
        type: 'string',
        enum: ['shallow', 'deep'],
        description: 'Research depth. "shallow" is faster; "deep" uses more context.',
      },
    },
    required: ['topic'],
  },
  async execute(input: Record<string, unknown>): Promise<string> {
    const topic = typeof input.topic === 'string' ? input.topic : '';
    if (!topic.trim()) {
      return 'Research failed: topic is required.';
    }
    // Research requires CLI-level streaming and multi-model orchestration that
    // depends on adapter process spawning with interactive output. Returning a
    // descriptive message directs the caller to the CLI for the full experience.
    return `Research topic: "${topic}"\nNote: Full multi-model research requires CLI streaming. Use \`mmbridge research "${topic}"\` for the full experience.`;
  },
};

// ─── mmbridge_memory_search ───────────────────────────────────────────────────

export const mmbridge_memory_search: AgentTool = {
  name: 'mmbridge_memory_search',
  description:
    'Search project memory files for prior decisions, patterns, or context. ' +
    'Reads from the .claude/agent-memory/ directory.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Keywords or phrase to search for in memory files.',
      },
    },
    required: ['query'],
  },
  async execute(input: Record<string, unknown>): Promise<string> {
    try {
      const query = typeof input.query === 'string' ? input.query : '';
      const { ProjectMemoryStore } = await import('@mmbridge/session-store');
      const store = new ProjectMemoryStore();
      const results = await store.searchMemory({
        projectDir: process.cwd(),
        query,
        limit: 5,
      });
      if (results.length === 0) {
        return `No memory entries found for "${query}".`;
      }
      return results.map((r) => `[${r.type}] ${r.title}: ${(r.content ?? '').slice(0, 200)}`).join('\n');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Memory search failed: ${message}`;
    }
  },
};

// ─── mmbridge_gate ────────────────────────────────────────────────────────────

export const mmbridge_gate: AgentTool = {
  name: 'mmbridge_gate',
  description:
    'Check review coverage for the current session. Reports which files have been ' +
    'reviewed, critical findings count, and whether the session is safe to merge.',
  inputSchema: {
    type: 'object',
    properties: {
      baseRef: {
        type: 'string',
        description: 'Git ref to compare against (defaults to main/master).',
      },
    },
    required: [],
  },
  async execute(input: Record<string, unknown>): Promise<string> {
    try {
      const projectDir = process.cwd();
      const baseRefOption = typeof input.baseRef === 'string' ? input.baseRef : undefined;
      const mode = 'review';

      const { evaluateGate, getChangedFiles, getDefaultBaseRef, getDiff, runCommand, shortDigest } = await import(
        '@mmbridge/core'
      );
      const { ProjectMemoryStore, RunStore, SessionStore } = await import('@mmbridge/session-store');

      const sessionStore = new SessionStore();
      const runStore = new RunStore(sessionStore.baseDir);
      const memoryStore = new ProjectMemoryStore(sessionStore.baseDir);

      let baseRef: string | null = baseRefOption ?? null;
      let diffDigest: string | null = null;
      let changedFilesCount = 0;

      const gitCheck = await runCommand('git', ['rev-parse', '--is-inside-work-tree'], {
        cwd: projectDir,
      }).catch(() => null);
      if (gitCheck?.ok && gitCheck.stdout.trim() === 'true') {
        baseRef = baseRef ?? (await getDefaultBaseRef(projectDir));
        const [diffText, changedFiles] = await Promise.all([
          getDiff(baseRef, projectDir),
          getChangedFiles(baseRef, projectDir),
        ]);
        diffDigest = shortDigest(diffText);
        changedFilesCount = changedFiles.length;
      }

      const [latestRun, latestSessions, latestHandoff] = await Promise.all([
        runStore.getLatest({ projectDir, mode }),
        sessionStore.list({ projectDir, mode, limit: 1 }),
        memoryStore.getLatestHandoff(projectDir).catch(() => null),
      ]);

      const handoffDocument =
        latestSessions[0]?.id != null
          ? await memoryStore.getHandoffBySession(projectDir, latestSessions[0].id).catch(() => null)
          : null;

      const latestSession = latestSessions[0] ?? null;
      const gateSession = latestSession
        ? {
            id: latestSession.id,
            tool: latestSession.tool,
            mode: latestSession.mode,
            externalSessionId: latestSession.externalSessionId ?? null,
            followupSupported: latestSession.followupSupported ?? false,
            findings: latestSession.findings ?? [],
            findingDecisions: latestSession.findingDecisions ?? [],
          }
        : null;

      const gateHandoff = handoffDocument
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
          : null;

      const result = evaluateGate({
        current: {
          projectDir,
          mode,
          baseRef,
          diffDigest,
          changedFilesCount,
          explicitMode: false,
        },
        latestRun,
        latestSession: gateSession,
        latestHandoff: gateHandoff,
      });

      if (result.status === 'pass') {
        return 'Gate: pass — review coverage is fresh for the current diff.';
      }

      const warningLines = result.warnings.map((w) => `- ${w.code}: ${w.message}\n  next: ${w.nextCommand}`);
      return `Gate: warn\n${warningLines.join('\n')}`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Gate check failed: ${message}`;
    }
  },
};

// ─── mmbridge_status ──────────────────────────────────────────────────────────

export const mmbridge_status: AgentTool = {
  name: 'mmbridge_status',
  description:
    'Show current mmbridge project and tool status: installed adapters, ' +
    'last review timestamp, active session, and configuration summary.',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  async execute(_input: Record<string, unknown>): Promise<string> {
    try {
      const { defaultRegistry, initRegistry } = await import('@mmbridge/adapters');
      const { commandExists } = await import('@mmbridge/core');
      const projectDir = process.cwd();

      await initRegistry(projectDir);

      const tools = defaultRegistry.list();
      const statuses = await Promise.all(
        tools.map(async (t) => {
          const adapter = defaultRegistry.get(t);
          const installed = adapter ? await commandExists(adapter.binary).catch(() => false) : false;
          return `${t}: ${installed ? 'installed' : 'not installed'}`;
        }),
      );

      return `Installed tools:\n${statuses.join('\n')}`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Status check failed: ${message}`;
    }
  },
};

// ─── Registry ─────────────────────────────────────────────────────────────────

export const BUILTIN_TOOLS: AgentTool[] = [
  mmbridge_review,
  mmbridge_security,
  mmbridge_research,
  mmbridge_memory_search,
  mmbridge_gate,
  mmbridge_status,
];
