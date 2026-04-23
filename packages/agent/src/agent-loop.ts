import Anthropic from '@anthropic-ai/sdk';
import { ToolRegistry } from './tool-registry.js';
import type { AgentConfig, AgentEvent, AgentMessage, AgentSession, AgentTool } from './types.js';

type ConversationMessage = Anthropic.MessageParam;

interface TurnResult {
  textAccumulated: string;
  toolCalls: Array<{ id: string; name: string; input: unknown }>;
  inputTokens: number;
  outputTokens: number;
}

export class AgentLoop {
  private readonly config: AgentConfig;
  private readonly client: Anthropic;
  private readonly registry: ToolRegistry;
  private readonly history: ConversationMessage[] = [];
  private session: AgentSession;
  private abortController: AbortController | null = null;

  constructor(config: AgentConfig) {
    this.config = config;
    const key = config.apiKey ?? process.env.ANTHROPIC_API_KEY ?? '';
    const isOAuthToken = key.startsWith('sk-ant-oat') || key.startsWith('eyJ');
    if (isOAuthToken) {
      this.client = new Anthropic({
        authToken: key,
        apiKey: '',
        defaultHeaders: { 'anthropic-beta': 'oauth-2025-04-20' },
      });
    } else {
      this.client = new Anthropic({ apiKey: key });
    }
    this.registry = new ToolRegistry();
    for (const tool of config.tools) {
      this.registry.register(tool);
    }
    this.session = {
      messages: [],
      totalTokens: { input: 0, output: 0 },
      turnCount: 0,
    };
  }

  async *run(userMessage: string): AsyncGenerator<AgentEvent> {
    this.abortController = new AbortController();

    this.history.push({ role: 'user', content: userMessage });
    this.session.messages.push({
      role: 'user',
      content: userMessage,
      timestamp: Date.now(),
    });

    const maxTurns = this.config.maxTurns ?? 30;
    let retryCount = 0;

    while (this.session.turnCount < maxTurns) {
      if (this.abortController.signal.aborted) {
        yield { type: 'error', error: 'Agent run aborted.' };
        return;
      }

      const events: AgentEvent[] = [];
      let turnResult: TurnResult;

      try {
        const { collected, result } = await this.collectOneTurn();
        events.push(...collected);
        turnResult = result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Auto-retry on rate limit (429), max 2 retries
        if ((message.includes('429') || message.includes('rate_limit')) && retryCount < 2) {
          retryCount++;
          const wait = retryCount * 15;
          yield { type: 'text', text: `\n⏳ Rate limited. Retrying in ${wait}s... (${retryCount}/2)\n` };
          await new Promise((r) => setTimeout(r, wait * 1000));
          continue;
        }
        yield { type: 'error', error: message };
        this.config.onError?.(err instanceof Error ? err : new Error(message));
        return;
      }

      for (const ev of events) {
        yield ev;
      }

      const { textAccumulated, toolCalls, inputTokens, outputTokens } = turnResult;

      this.session.totalTokens.input += inputTokens;
      this.session.totalTokens.output += outputTokens;
      this.session.turnCount++;

      if (toolCalls.length === 0) {
        this.session.messages.push({
          role: 'assistant',
          content: textAccumulated,
          timestamp: Date.now(),
        });
        yield { type: 'done', session: this.session };
        return;
      }

      // Build assistant message with tool use blocks
      const assistantBlocks: Anthropic.Messages.ToolUseBlock[] = toolCalls.map((tc) => ({
        type: 'tool_use' as const,
        id: tc.id,
        name: tc.name,
        input: tc.input as Record<string, unknown>,
      }));

      const assistantContent: Anthropic.Messages.ContentBlock[] =
        textAccumulated.length > 0
          ? [{ type: 'text' as const, text: textAccumulated, citations: [] }, ...assistantBlocks]
          : assistantBlocks;

      this.history.push({ role: 'assistant', content: assistantContent });

      // Execute each tool and collect results
      const toolResultBlocks: Anthropic.ToolResultBlockParam[] = [];
      const sessionToolCalls: AgentMessage['toolCalls'] = [];

      for (const tc of toolCalls) {
        yield { type: 'tool_use', name: tc.name, input: tc.input };
        this.config.onToolUse?.(tc.name, tc.input);

        const tool = this.registry.get(tc.name);
        let result: string;
        if (tool === undefined) {
          result = `Error: unknown tool "${tc.name}"`;
        } else {
          try {
            result = await tool.execute(tc.input as Record<string, unknown>);
          } catch (err) {
            result = `Error executing tool "${tc.name}": ${err instanceof Error ? err.message : String(err)}`;
          }
        }

        yield { type: 'tool_result', name: tc.name, result };
        this.config.onToolResult?.(tc.name, result);

        toolResultBlocks.push({ type: 'tool_result', tool_use_id: tc.id, content: result });
        sessionToolCalls.push({
          name: tc.name,
          input: tc.input as Record<string, unknown>,
          result,
        });
      }

      this.session.messages.push({
        role: 'assistant',
        content: textAccumulated,
        toolCalls: sessionToolCalls,
        timestamp: Date.now(),
      });

      this.history.push({ role: 'user', content: toolResultBlocks });
    }

    yield {
      type: 'error',
      error: `Reached maxTurns limit (${maxTurns}). Stopping.`,
    };
  }

  private async collectOneTurn(): Promise<{ collected: AgentEvent[]; result: TurnResult }> {
    const anthropicTools = this.registry.toAnthropicTools();
    const collected: AgentEvent[] = [];

    const stream = this.client.messages.stream({
      model: this.config.model,
      max_tokens: 8192,
      system: this.config.systemPrompt,
      messages: this.history,
      ...(anthropicTools.length > 0 ? { tools: anthropicTools as Anthropic.Tool[] } : {}),
    });

    let textAccumulated = '';
    const toolCalls: Array<{ id: string; name: string; input: unknown }> = [];
    const toolInputBuffers = new Map<number, string>();

    for await (const event of stream) {
      if (this.abortController?.signal.aborted) {
        stream.abort();
        break;
      }

      if (event.type === 'content_block_start') {
        const block = event.content_block;
        if (block.type === 'tool_use') {
          toolCalls.push({ id: block.id, name: block.name, input: null });
          toolInputBuffers.set(event.index, '');
        }
      } else if (event.type === 'content_block_delta') {
        const delta = event.delta;
        if (delta.type === 'text_delta') {
          textAccumulated += delta.text;
          const ev: AgentEvent = { type: 'text', text: delta.text };
          collected.push(ev);
          this.config.onText?.(delta.text);
        } else if (delta.type === 'input_json_delta') {
          const existing = toolInputBuffers.get(event.index) ?? '';
          toolInputBuffers.set(event.index, existing + delta.partial_json);
        }
      }
    }

    // Assign parsed inputs to tool calls in order
    let toolCallIdx = 0;
    for (const [, rawJson] of toolInputBuffers) {
      const toolCall = toolCalls[toolCallIdx];
      if (toolCall) {
        try {
          toolCall.input = rawJson.length > 0 ? (JSON.parse(rawJson) as unknown) : {};
        } catch {
          toolCall.input = {};
        }
        toolCallIdx++;
      }
    }

    const finalMessage = await stream.finalMessage();
    const inputTokens = finalMessage.usage.input_tokens;
    const outputTokens = finalMessage.usage.output_tokens;

    return {
      collected,
      result: { textAccumulated, toolCalls, inputTokens, outputTokens },
    };
  }

  abort(): void {
    this.abortController?.abort();
  }

  getSession(): AgentSession {
    return { ...this.session };
  }

  registerTool(tool: AgentTool): void {
    this.registry.register(tool);
  }
}
