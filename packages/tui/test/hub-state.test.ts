import assert from 'node:assert/strict';
import test from 'node:test';
import { createHubStore, initialLane, reduceLane } from '../dist/hub-state.js';
import type { LaneEvent, LaneState } from '../dist/hub-state.js';

function run(events: LaneEvent[]): LaneState {
  return events.reduce(reduceLane, initialLane('worker', 1000));
}

test('a lane waits until its first model is chosen', () => {
  const lane = initialLane('reviewer', 1000);
  assert.equal(lane.status, 'waiting');
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

test('abort shows immediately as aborting, then aborted when the worker stops', () => {
  const aborting = run([{ type: 'ready', readyMs: 500 }, { type: 'abort_requested' }]);
  assert.equal(aborting.status, 'aborting');
  const stopped = reduceLane(aborting, {
    type: 'done',
    at: 3000,
    stopReason: 'aborted',
    errorMessage: 'Interrupted by user',
  });
  assert.equal(stopped.status, 'aborted');
});

test('a steer is shown on the lane until the worker answers it', () => {
  const lane = run([
    { type: 'ready', readyMs: 500 },
    { type: 'steer', message: 'use (page - 1)' },
  ]);
  assert.equal(lane.lastSteer, 'use (page - 1)');
  assert.equal(lane.status, 'running');
});

test('the store routes steer and abort to the lane control and records them', () => {
  const store = createHubStore(['worker', 'reviewer'], 0);
  const calls: string[] = [];
  store.setControl(1, { steer: (m) => calls.push(`steer:${m}`), abort: () => calls.push('abort') });
  store.steer(1, 'focus on tests');
  store.abort(1);
  assert.deepEqual(calls, ['steer:focus on tests', 'abort']);
  const second = store.getSnapshot().lanes[1];
  assert.equal(second?.lastSteer, 'focus on tests');
  assert.equal(second?.status, 'aborting');
});

test('an abort pressed before the worker is up is delivered once its control arrives', () => {
  const store = createHubStore(['worker'], 0);
  store.abort(0);
  assert.equal(store.getSnapshot().lanes[0]?.status, 'aborting');
  let aborted = 0;
  store.setControl(0, { steer: () => {}, abort: () => aborted++ });
  assert.equal(aborted, 1);
});

test('steer and abort do nothing on a finished lane', () => {
  const store = createHubStore(['worker'], 0);
  const calls: string[] = [];
  store.setControl(0, { steer: () => calls.push('steer'), abort: () => calls.push('abort') });
  store.apply(0, { type: 'done', at: 10, stopReason: 'stop' });
  store.steer(0, 'late');
  store.abort(0);
  assert.deepEqual(calls, []);
  assert.equal(store.getSnapshot().lanes[0]?.status, 'done');
});

test('answer text from a later turn (e.g. after a steer) starts on a new line', () => {
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
  const lane = run([
    { type: 'text', delta: '60. last item.' },
    { type: 'turn', usage, costUsd: 0 },
    { type: 'text', delta: 'STEERED' },
    { type: 'turn', usage, costUsd: 0 },
  ]);
  assert.equal(lane.text, '60. last item.\nSTEERED');
});

test('a lane that starts late measures its time from its own start, and one that never starts is skipped', () => {
  const store = createHubStore(['worker', 'reviewer'], 0);
  store.apply(1, { type: 'model', provider: 'zai', modelId: 'glm-5.3' });
  assert.ok((store.getSnapshot().lanes[1]?.startedAt ?? 0) > 0);
  assert.equal(store.getSnapshot().lanes[1]?.status, 'starting');
  store.settle();
  const { lanes, busy } = store.getSnapshot();
  assert.equal(lanes[0]?.status, 'skipped');
  assert.equal(busy, false);
});

test('an abort held for a waiting lane survives its model starting', () => {
  const store = createHubStore(['reviewer'], 0);
  store.abort(0);
  store.apply(0, { type: 'model', provider: 'zai', modelId: 'glm-5.3' });
  store.apply(0, { type: 'ready', readyMs: 10 });
  assert.equal(store.getSnapshot().lanes[0]?.status, 'aborting');
});

test('activity and gate are shown until the run settles', () => {
  const store = createHubStore(['worker'], 0);
  store.setActivity('validate: node check.js');
  assert.equal(store.getSnapshot().activity, 'validate: node check.js');
  store.setGate({ verdict: 'pass', reasons: [], details: ['diff: 1 file'] });
  store.settle();
  assert.equal(store.getSnapshot().activity, undefined);
  assert.equal(store.getSnapshot().gate?.verdict, 'pass');
});
