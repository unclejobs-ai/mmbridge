import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { toWorkerEvent } from '../dist/events.js';
import { type WorkerEvent, dispatch } from '../dist/index.js';

// Real `omp --mode rpc` output from one grok-4.7 worker run (2026-09-24), trimmed: deltas capped at 3 per kind,
// signatures and encrypted reasoning replaced with "…".
const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = path.join(fixtures, 'omp-rpc-worker-events.ndjson');
const raw = readFileSync(fixture, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line));

describe('toWorkerEvent (characterization against captured omp output)', () => {
  const events = raw.map(toWorkerEvent).filter((event) => event !== undefined);

  it('keeps tool starts with their intent, in order', () => {
    assert.deepEqual(
      events.filter((e) => e.type === 'tool_start'),
      [
        { type: 'tool_start', name: 'glob', intent: 'Finding paginate.js' },
        { type: 'tool_start', name: 'read', intent: 'Reading paginate.js' },
        { type: 'tool_start', name: 'grep', intent: 'Finding paginate callers' },
        { type: 'tool_start', name: 'edit', intent: 'Making page offset 1-based' },
      ],
    );
    assert.equal(events.filter((e) => e.type === 'tool_end' && e.isError === false).length, 4);
  });

  it('reports usage per turn (omp turn_end usage is not cumulative)', () => {
    const turns = events.filter((e) => e.type === 'turn');
    assert.equal(turns.length, 5);
    assert.equal(
      turns.reduce((sum, e) => sum + (e.type === 'turn' ? e.usage.input : 0), 0),
      6643 + 199 + 6820 + 504 + 366,
    );
  });

  it('forwards answer text deltas but drops thinking, tool-call deltas, and routing chatter', () => {
    assert.deepEqual(
      events.filter((e) => e.type === 'text').map((e) => (e.type === 'text' ? e.delta : '')),
      raw
        .filter((e) => e.type === 'message_update' && e.assistantMessageEvent.type === 'text_delta')
        .map((e) => e.assistantMessageEvent.delta),
    );
    assert.deepEqual(new Set(events.map((e) => e.type)), new Set(['text', 'tool_start', 'tool_end', 'turn']));
  });
});

describe('dispatch onEvent', () => {
  afterEach(() => {
    for (const key of ['FAKE_OMP_STREAM', 'FAKE_OMP_QUOTA', 'FAKE_OMP_STREAM_DELAY_MS']) {
      Reflect.deleteProperty(process.env, key);
    }
  });

  it('streams the fallback, tool calls, text, and per-turn usage, and totals usage across turns', async () => {
    process.env.FAKE_OMP_STREAM = '1';
    process.env.FAKE_OMP_QUOTA = 'openai-codex/gpt-5.6-sol';
    const home = await mkdtemp(path.join(tmpdir(), 'mmbridge-events-'));
    await writeFile(
      path.join(home, 'roles.json'),
      JSON.stringify({ roles: { worker: ['openai-codex/gpt-5.6-sol', 'xai-oauth/grok-4.7'] } }),
    );
    const events: WorkerEvent[] = [];
    const result = await dispatch({
      role: 'worker',
      task: 't',
      cwd: tmpdir(),
      binary: path.join(fixtures, 'fake-omp.mjs'),
      mmbridgeHome: home,
      ompConfigPath: path.join(home, 'missing.yml'),
      onEvent: (event) => events.push(event),
    });

    assert.deepEqual(
      events.map((e) => (e.type === 'attempt' ? `attempt:${e.attempt.modelId}:${e.attempt.outcome}` : e.type)),
      [
        'model',
        'ready',
        'attempt:gpt-5.6-sol:error',
        'model',
        'ready',
        'tool_start',
        'tool_end',
        'turn',
        'text',
        'text',
        'turn',
        'attempt:grok-4.7:ok',
      ],
    );
    assert.equal(result.text, 'streamed');
    assert.deepEqual(result.usage, { input: 110, output: 25, cacheRead: 0, cacheWrite: 0 });
    assert.equal(result.costUsd, 0.75);
  });

  it('steers a running worker: the answer comes from the steered turn', async () => {
    process.env.FAKE_OMP_STREAM = '1';
    process.env.FAKE_OMP_STREAM_DELAY_MS = '50';
    const result = await dispatch({
      role: 'worker',
      task: 't',
      cwd: tmpdir(),
      model: 'xai-oauth/grok-4.7',
      binary: path.join(fixtures, 'fake-omp.mjs'),
      mmbridgeHome: await mkdtemp(path.join(tmpdir(), 'mmbridge-events-')),
      onControl: (control) => control.steer('use (page - 1)'),
    });
    assert.equal(result.text, 'steered:use (page - 1)');
  });

  it('aborts a running worker: stopReason aborted, and no fallback to the next model', async () => {
    process.env.FAKE_OMP_STREAM = '1';
    process.env.FAKE_OMP_STREAM_DELAY_MS = '50';
    const home = await mkdtemp(path.join(tmpdir(), 'mmbridge-events-'));
    await writeFile(
      path.join(home, 'roles.json'),
      JSON.stringify({ roles: { worker: ['xai-oauth/grok-4.7', 'zai/glm-5.3'] } }),
    );
    const result = await dispatch({
      role: 'worker',
      task: 't',
      cwd: tmpdir(),
      binary: path.join(fixtures, 'fake-omp.mjs'),
      mmbridgeHome: home,
      ompConfigPath: path.join(home, 'missing.yml'),
      onControl: (control) => control.abort(),
    });
    assert.equal(result.stopReason, 'aborted');
    assert.equal(result.errorMessage, 'Interrupted by user');
    assert.deepEqual(
      result.attempts.map((a) => a.modelId),
      ['grok-4.7'],
    );
  });
});
