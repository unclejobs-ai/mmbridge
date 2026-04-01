import type { AgentTool } from './types.js';

function stubExecute(toolName: string): (input: Record<string, unknown>) => Promise<string> {
  return async (_input: Record<string, unknown>): Promise<string> => {
    throw new Error(`Not implemented: ${toolName} — wire to mmbridge CLI commands`);
  };
}

export const mmbridge_review: AgentTool = {
  name: 'mmbridge_review',
  description:
    'Run a multi-model code review on staged or changed files. ' +
    'Aggregates findings from Kimi, Qwen, Codex, and Gemini and returns a unified report.',
  inputSchema: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: ['quick', 'full'],
        description: 'Review depth: "quick" for diff only, "full" for full context.',
      },
      scope: {
        type: 'string',
        description: 'Optional file glob to restrict review scope (e.g. "src/**/*.ts").',
      },
    },
    required: [],
  },
  execute: stubExecute('mmbridge_review'),
};

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
        description: 'Optional file glob to restrict audit scope.',
      },
    },
    required: [],
  },
  execute: stubExecute('mmbridge_security'),
};

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
  execute: stubExecute('mmbridge_research'),
};

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
  execute: stubExecute('mmbridge_memory_search'),
};

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
  execute: stubExecute('mmbridge_gate'),
};

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
  execute: stubExecute('mmbridge_status'),
};

export const BUILTIN_TOOLS: AgentTool[] = [
  mmbridge_review,
  mmbridge_security,
  mmbridge_research,
  mmbridge_memory_search,
  mmbridge_gate,
  mmbridge_status,
];
