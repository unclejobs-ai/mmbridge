import { defaultRegistry, runFollowupAdapter, runReviewAdapter } from '@mmbridge/adapters';
import { interpretFindings, runReviewPipeline } from '@mmbridge/core';
import type { Finding } from '@mmbridge/core';
import { SessionStore } from '@mmbridge/session-store';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const store = new SessionStore();

const TOOL_DEFINITIONS = [
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
      },
    },
  },
];

function textContent(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], ...(isError && { isError: true }) };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
      default:
        return textContent(`Unknown tool: ${name}`, true);
    }
  });
}

async function handleReview(args: Record<string, unknown>, server: Server) {
  const tool = String(args.tool ?? 'kimi');
  const mode = String(args.mode ?? 'review');
  const bridge = String(args.bridge ?? 'none') as 'none' | 'standard' | 'interpreted';
  const baseRef = args.baseRef as string | undefined;
  const projectDir = process.cwd();

  try {
    const result = await runReviewPipeline({
      tool,
      mode,
      projectDir,
      baseRef,
      bridge: tool === 'all' && bridge === 'none' ? 'standard' : bridge,
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
      workspace: process.cwd(),
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
      workspace: process.cwd(),
    });
    return textContent(JSON.stringify(result, null, 2));
  } catch (err) {
    return textContent(`Interpret failed: ${errorMessage(err)}`, true);
  }
}

async function handleSessions(args: Record<string, unknown>) {
  const tool = args.tool as string | undefined;
  const limit = typeof args.limit === 'number' ? args.limit : 10;
  const query = args.query as string | undefined;
  const severity = args.severity as string | undefined;

  let sessions = await store.list({ tool });

  // Text search filter
  if (query) {
    const q = query.toLowerCase();
    sessions = sessions.filter((s) => {
      const summaryMatch = s.summary?.toLowerCase().includes(q) ?? false;
      const findingMatch = (s.findings ?? []).some(
        (f) => f.message?.toLowerCase().includes(q) || f.file?.toLowerCase().includes(q),
      );
      return summaryMatch || findingMatch;
    });
  }

  // Severity filter
  if (severity) {
    const sev = severity.toUpperCase();
    sessions = sessions.filter((s) => (s.findings ?? []).some((f) => f.severity === sev));
  }

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
  const query = args.query as string | undefined;
  const file = args.file as string | undefined;
  const severity = args.severity as string | undefined;
  const tool = args.tool as string | undefined;
  const limit = typeof args.limit === 'number' ? args.limit : 20;

  if (!query && !file && !severity && !tool) {
    return textContent('At least one filter (query, file, severity, or tool) is required.', true);
  }

  const sessions = await store.list({ tool });

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
