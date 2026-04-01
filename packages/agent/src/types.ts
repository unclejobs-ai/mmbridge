export interface AgentTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (input: Record<string, unknown>) => Promise<string>;
}

export interface AgentConfig {
  model: string;
  apiKey?: string;
  systemPrompt: string;
  tools: AgentTool[];
  maxTurns: number;
  onText?: (text: string) => void;
  onToolUse?: (name: string, input: unknown) => void;
  onToolResult?: (name: string, result: string) => void;
  onError?: (error: Error) => void;
}

export interface AgentMessage {
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: Array<{
    name: string;
    input: Record<string, unknown>;
    result: string;
  }>;
  timestamp: number;
}

export interface AgentSession {
  messages: AgentMessage[];
  totalTokens: { input: number; output: number };
  turnCount: number;
}

export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; name: string; input: unknown }
  | { type: 'tool_result'; name: string; result: string }
  | { type: 'error'; error: string }
  | { type: 'done'; session: AgentSession };
