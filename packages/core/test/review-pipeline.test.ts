import test from 'node:test';
import assert from 'node:assert/strict';
import { runReviewPipeline } from '../dist/review-pipeline.js';
import type { ReviewPipelineOptions } from '../dist/review-pipeline.js';

function makeMockAdapter(text: string) {
  return async (_tool: string, _opts: unknown) => ({
    text,
    externalSessionId: 'ext-123',
    followupSupported: true,
  });
}

const baseOptions: ReviewPipelineOptions = {
  tool: 'kimi',
  mode: 'review',
  projectDir: process.cwd(),
  runAdapter: makeMockAdapter('[WARNING] src/a.ts:10 — Missing validation'),
};

// Note: These tests hit the real git/filesystem via createContext,
// so they work on the actual mmbridge repo. We skip the context creation
// by checking that the pipeline runs end-to-end.

test('runReviewPipeline: single tool produces findings', async () => {
  const phases: string[] = [];

  const result = await runReviewPipeline({
    ...baseOptions,
    onProgress: (phase) => phases.push(phase),
  });

  assert.ok(result.sessionId);
  assert.ok(Array.isArray(result.findings));
  assert.ok(result.resultIndex);
  assert.ok(phases.includes('context'));
  assert.ok(phases.includes('review'));
});

test('runReviewPipeline: saves session when saveSession provided', async () => {
  let savedData: unknown = null;

  const result = await runReviewPipeline({
    ...baseOptions,
    saveSession: async (data) => {
      savedData = data;
      return { id: 'saved-123' };
    },
  });

  assert.equal(result.sessionId, 'saved-123');
  assert.notEqual(savedData, null);
});

test('runReviewPipeline: session is "unsaved" without saveSession', async () => {
  const result = await runReviewPipeline(baseOptions);
  assert.equal(result.sessionId, 'unsaved');
});

test('runReviewPipeline: bridge mode throws without installed tools', async () => {
  await assert.rejects(
    () => runReviewPipeline({
      ...baseOptions,
      tool: 'all',
      bridge: 'standard',
      listInstalledTools: async () => [],
    }),
    /No review tools installed/,
  );
});
