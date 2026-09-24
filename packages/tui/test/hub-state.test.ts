import assert from 'node:assert/strict';
import test from 'node:test';
import { initialLane, reduceLane } from '../dist/hub-state.js';
import type { LaneEvent, LaneState } from '../dist/hub-state.js';

function run(events: LaneEvent[]): LaneState {
  return events.reduce(reduceLane, initialLane('worker', 1000));
}

test('a lane starts before any model is chosen', () => {
  const lane = initialLane('reviewer', 1000);
  assert.equal(lane.status, 'starting');
  assert.equal(lane.model, undefined);
});

test('fallback: a skipped model is remembered and the next model becomes current', () => {
  const lane = run([
    {
      type: 'attempt',
      attempt: { provider: 'openai-codex', modelId: 'gpt-5.6-sol', outcome: 'skipped', errorMessage: 'cooling down' },
    },
    { type: 'model', provider: 'xai-oauth', modelId: 'grok-4.7' },
    { type: 'ready', readyMs: 580 },
  ]);
  assert.equal(lane.model, 'xai-oauth/grok-4.7');
  assert.equal(lane.status, 'running');
  assert.equal(lane.readyMs, 580);
  assert.deepEqual(
    lane.passed.map((a) => `${a.provider}/${a.modelId}:${a.outcome}`),
    ['openai-codex/gpt-5.6-sol:skipped'],
  );
});

test('tool calls become a trace capped at 3 lines, newest last, with errors kept', () => {
  const lane = run([
    { type: 'tool_start', name: 'glob', intent: 'Finding a' },
    { type: 'tool_end', name: 'glob', isError: false },
    { type: 'tool_start', name: 'read', intent: 'Reading a' },
    { type: 'tool_end', name: 'read', isError: false },
    { type: 'tool_start', name: 'grep', intent: 'Finding callers' },
    { type: 'tool_end', name: 'grep', isError: true },
    { type: 'tool_start', name: 'edit', intent: 'Fixing a' },
  ]);
  assert.deepEqual(
    lane.trace.map((t) => `${t.name}:${t.state}`),
    ['read:ok', 'grep:error', 'edit:running'],
  );
  assert.equal(lane.toolCalls, 4);
});

test('usage is summed across turns', () => {
  const lane = run([
    { type: 'turn', usage: { input: 6643, output: 71, cacheRead: 1152, cacheWrite: 0 }, costUsd: 0.01 },
    { type: 'turn', usage: { input: 199, output: 26, cacheRead: 7680, cacheWrite: 0 }, costUsd: 0.02 },
  ]);
  assert.deepEqual(lane.tokens, { input: 6842, output: 97 });
  assert.equal(lane.costUsd, 0.03);
});

test('answer text accumulates and done freezes elapsed', () => {
  const lane = run([
    { type: 'text', delta: 'Fixed ' },
    { type: 'text', delta: 'the slice.' },
    { type: 'done', at: 13_500, stopReason: 'stop' },
  ]);
  assert.equal(lane.text, 'Fixed the slice.');
  assert.equal(lane.status, 'done');
  assert.equal(lane.endedAt, 13_500);
});

test('a provider error or a thrown failure ends the lane as error with the message', () => {
  assert.equal(run([{ type: 'done', at: 2000, stopReason: 'error', errorMessage: 'quota' }]).status, 'error');
  const failed = run([{ type: 'failed', at: 2000, message: 'omp exited' }]);
  assert.equal(failed.status, 'error');
  assert.equal(failed.errorMessage, 'omp exited');
});
