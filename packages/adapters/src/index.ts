import { runKimiReview, runKimiFollowup } from './kimi.js';
import { runQwenReview, runQwenFollowup } from './qwen.js';
import { runCodexReview, runCodexFollowup } from './codex.js';
import { runGeminiReview, runGeminiFollowup } from './gemini.js';
import type { ReviewOptions, FollowupOptions, AdapterResult } from './types.js';

export type { ReviewOptions, FollowupOptions, AdapterResult } from './types.js';
export type { AdapterDefinition } from './types.js';

export async function runReviewAdapter(
  tool: string,
  options: ReviewOptions,
): Promise<AdapterResult> {
  switch (tool) {
    case 'kimi':
      return runKimiReview(options);
    case 'qwen':
      return runQwenReview(options);
    case 'codex':
      return runCodexReview(options);
    case 'gemini':
      return runGeminiReview({
        workspace: options.workspace,
        changedFiles: options.changedFiles ?? [],
      });
    default:
      throw new Error(`Unsupported tool: ${tool}`);
  }
}

export async function runFollowupAdapter(
  tool: string,
  options: FollowupOptions,
): Promise<AdapterResult> {
  switch (tool) {
    case 'kimi':
      return runKimiFollowup(options);
    case 'qwen':
      return runQwenFollowup(options);
    case 'codex':
      return runCodexFollowup(options);
    case 'gemini':
      return runGeminiFollowup(options);
    default:
      throw new Error(`Unsupported tool: ${tool}`);
  }
}
