import { getChangedFiles, getDefaultBaseRef, getGitStatusSummary, getHead } from '@mmbridge/core';
import { SessionStore } from '@mmbridge/session-store';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { GetPromptRequestSchema, ListPromptsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const store = new SessionStore();

export function registerPromptHandlers(server: Server): void {
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [
      {
        name: 'review-context',
        description:
          'Inject current project context (git status, changed files, last review summary) before starting a review.',
      },
    ],
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    if (request.params.name !== 'review-context') {
      return { description: 'Unknown prompt', messages: [] };
    }

    const parts: string[] = ['## Project Context for Code Review\n'];

    try {
      const [head, baseRef, gitStatus] = await Promise.all([getHead(), getDefaultBaseRef(), getGitStatusSummary()]);
      const changedFiles = await getChangedFiles(baseRef);

      parts.push(`**Branch:** ${head.branch} (${head.sha.slice(0, 7)})`);
      parts.push(`**Base ref:** ${baseRef}`);
      parts.push(
        `**Status:** ${gitStatus.staged} staged, ${gitStatus.unstaged} unstaged, ${gitStatus.untracked} untracked`,
      );
      parts.push(`**Changed files (${changedFiles.length}):**`);
      for (const f of changedFiles.slice(0, 20)) {
        parts.push(`  - ${f}`);
      }
      if (changedFiles.length > 20) {
        parts.push(`  ... and ${changedFiles.length - 20} more`);
      }
    } catch {
      parts.push('*Unable to read git status*');
    }

    try {
      const sessions = await store.list();
      const last = sessions.at(0);
      if (last !== undefined) {
        parts.push(`\n**Last review:** ${last.tool}/${last.mode} (${last.createdAt})`);
        parts.push(`**Findings:** ${(last.findings ?? []).length}`);
        if (last.summary) {
          parts.push(`**Summary:** ${last.summary.slice(0, 200)}`);
        }
      }
    } catch {
      // Session store not available — non-critical
    }

    return {
      description: 'Current project context for code review',
      messages: [
        {
          role: 'user' as const,
          content: { type: 'text' as const, text: parts.join('\n') },
        },
      ],
    };
  });
}
