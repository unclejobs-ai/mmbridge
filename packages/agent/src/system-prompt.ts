import type { AgentTool } from './types.js';

export interface SystemPromptOptions {
  tools?: AgentTool[];
  projectContext?: {
    branch?: string;
    changedFiles?: string[];
  };
  language?: string;
}

export function buildSystemPrompt(options: SystemPromptOptions = {}): string {
  const { tools = [], projectContext, language } = options;

  const sections: string[] = [];

  sections.push(
    'You are mmbridge, a multi-model orchestrator for coding work. ' +
      'You coordinate multiple AI models (Kimi, Qwen, Codex, Gemini) to perform ' +
      'code reviews, security audits, research, and other engineering tasks. ' +
      'You are precise, concise, and tool-first: prefer calling a tool over narrating what you would do.',
  );

  if (tools.length > 0) {
    const toolList = tools.map((t) => `- **${t.name}**: ${t.description}`).join('\n');
    sections.push(`## Available Tools\n\n${toolList}`);
  }

  if (projectContext !== undefined) {
    const ctxLines: string[] = ['## Project Context'];
    if (projectContext.branch !== undefined && projectContext.branch.length > 0) {
      ctxLines.push(`- Branch: \`${projectContext.branch}\``);
    }
    if (projectContext.changedFiles !== undefined && projectContext.changedFiles.length > 0) {
      const fileList = projectContext.changedFiles.map((f) => `  - ${f}`).join('\n');
      ctxLines.push(`- Changed files:\n${fileList}`);
    }
    sections.push(ctxLines.join('\n'));
  }

  const langInstruction =
    language !== undefined && language.length > 0
      ? `Respond in ${language}.`
      : 'Respond in the same language the user writes in.';

  sections.push(
    `## Instructions\n\n- ${langInstruction}\n- Be concise: skip preamble, get to the point.\n- Use tools proactively when they can provide better information than you have.\n- When a tool fails, report the error clearly and suggest a remedy.\n- Do not fabricate command output or file contents — use tools to obtain real data.`,
  );

  return sections.join('\n\n');
}
