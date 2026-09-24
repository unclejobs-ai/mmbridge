#!/usr/bin/env node
// Minimal stand-in for `omp --mode rpc`. Behaviour is chosen by FAKE_OMP_MODE.
import { createInterface } from 'node:readline';

const mode = process.env.FAKE_OMP_MODE ?? 'ok';
// Comma-separated provider/model selectors that hit a quota error or are unknown to omp.
const quotaModels = (process.env.FAKE_OMP_QUOTA ?? '').split(',').filter(Boolean);
const unknownModels = (process.env.FAKE_OMP_UNKNOWN ?? '').split(',').filter(Boolean);
const spawnLog = process.env.FAKE_OMP_SPAWN_LOG;
const forbiddenModels = (process.env.FAKE_OMP_FORBIDDEN ?? '').split(',').filter(Boolean);
// Like real omp with retry.modelFallback on: silently answers from another model unless an overlay turns it off.
const internalFallback = process.env.FAKE_OMP_INTERNAL_FALLBACK;
const configArg = process.argv.indexOf('--config');
const fs = await import('node:fs');
const fallbackDisabled =
  configArg !== -1 && /modelFallback: false/.test(fs.readFileSync(process.argv[configArg + 1], 'utf8'));
if (spawnLog) (await import('node:fs')).appendFileSync(spawnLog, `spawn ${process.argv.slice(2).join(' ')}\n`);
// Worker simulation: with tools on (`--approval-mode yolo`, no `--no-tools`), FAKE_OMP_EDIT="path=content" edits cwd.
const toolsEnabled = !process.argv.includes('--no-tools') && process.argv.includes('yolo');
const edit = process.env.FAKE_OMP_EDIT;
// Reviewer simulation: the text a reviewer-role prompt gets back.
const reviewText = process.env.FAKE_OMP_REVIEW;
const out = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
// Live-view simulation: FAKE_OMP_STREAM=1 runs two turns (a `read` tool call, then the answer) with per-turn usage,
// FAKE_OMP_STREAM_DELAY_MS spaces the events out.
const stream = process.env.FAKE_OMP_STREAM === '1';
const streamDelayMs = Number(process.env.FAKE_OMP_STREAM_DELAY_MS ?? 0);
const pause = () => new Promise((resolve) => setTimeout(resolve, streamDelayMs));
const turnUsage = (input, output, cost) => ({ input, output, cacheRead: 0, cacheWrite: 0, cost: { total: cost } });
// Like real omp: `steer` is answered in a later turn, `abort` ends the turn at once with stopReason "aborted".
let steered = null;
let aborted = false;
let model = null;
let thinking = null;

if (process.argv[2] === 'models') {
  if (mode === 'models-fail') process.exit(3);
  out({
    models: [
      { provider: 'zai', id: 'glm-5.3' },
      { provider: 'zai', id: 'glm-5.3-flash' },
      { provider: 'xai-oauth', id: 'grok-4.6' },
    ],
  });
  process.exit(0);
}

out({ type: 'ready' });
createInterface({ input: process.stdin }).on('line', async (line) => {
  const cmd = JSON.parse(line);
  if (cmd.type === 'steer') {
    steered = cmd.message;
    out({ id: cmd.id, type: 'response', command: 'steer', success: true });
  } else if (cmd.type === 'abort') {
    aborted = true;
    out({ id: cmd.id, type: 'response', command: 'abort', success: true });
  } else if (cmd.type === 'set_model') {
    if (mode === 'reject-model' || unknownModels.includes(`${cmd.provider}/${cmd.modelId}`)) {
      out({ id: cmd.id, type: 'response', command: 'set_model', success: false, error: 'Model not found' });
      return;
    }
    model = cmd;
    out({ id: cmd.id, type: 'response', command: 'set_model', success: true });
  } else if (cmd.type === 'set_thinking_level') {
    thinking = cmd.level;
    out({ id: cmd.id, type: 'response', command: 'set_thinking_level', success: true });
  } else if (cmd.type === 'extension_ui_response') {
    // Only a refusal ends the turn; any other answer would spend something on the user's behalf.
    out({
      type: 'agent_end',
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'text', text: `ui:${cmd.cancelled === true ? 'cancelled' : 'answered'}` }],
          stopReason: 'error',
          errorMessage: 'usage_limit_reached',
        },
      ],
    });
  } else if (cmd.type === 'prompt') {
    out({ id: cmd.id, type: 'response', command: 'prompt', success: true });
    if (mode === 'dialog') {
      out({ type: 'extension_ui_request', id: 'w1', method: 'setWidget', widgetKey: 'x' });
      out({
        type: 'extension_ui_request',
        id: 'd1',
        method: 'select',
        title: 'Spend a saved rate-limit reset?',
        options: ['Yes', 'No'],
      });
      return;
    }
    if (internalFallback && !fallbackDisabled) {
      const [provider, modelId] = internalFallback.split('/');
      model = { provider, modelId };
    }
    if (forbiddenModels.includes(`${model.provider}/${model.modelId}`)) {
      out({
        type: 'agent_end',
        messages: [
          {
            role: 'assistant',
            content: [],
            provider: model.provider,
            model: model.modelId,
            stopReason: 'error',
            errorMessage:
              '403 {"error":{"type":"permission_error","message":"Your current subscription does not have access"}}',
          },
        ],
      });
      return;
    }
    if (quotaModels.includes(`${model.provider}/${model.modelId}`)) {
      out({
        type: 'auto_retry_end',
        success: false,
        attempt: 1,
        finalError:
          'Provider requested 3600000ms wait, exceeds retry.maxDelayMs (300000ms). Original error: usage limit reached',
      });
      out({
        type: 'agent_end',
        messages: [
          {
            role: 'assistant',
            content: [],
            provider: model.provider,
            model: model.modelId,
            stopReason: 'error',
            errorMessage: 'The usage limit has been reached (code=usage_limit_reached)',
          },
        ],
      });
      return;
    }
    if (edit && toolsEnabled) {
      const eq = edit.indexOf('=');
      fs.writeFileSync(edit.slice(0, eq), edit.slice(eq + 1));
    }
    if (stream && mode !== 'model-error') {
      const abortedEnd = () => {
        const end = { role: 'assistant', content: [], stopReason: 'aborted', errorMessage: 'Interrupted by user' };
        out({ type: 'turn_end', message: end });
        out({ type: 'agent_end', messages: [end] });
      };
      out({ type: 'turn_start' });
      await pause();
      out({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'read', args: {}, intent: 'Reading task' });
      await pause();
      if (aborted) return abortedEnd();
      out({ type: 'tool_execution_end', toolCallId: 't1', toolName: 'read', result: {}, isError: false });
      out({ type: 'turn_end', message: { role: 'assistant', content: [], usage: turnUsage(100, 20, 0.5) } });
      await pause();
      if (edit && toolsEnabled) {
        const eq = edit.indexOf('=');
        fs.writeFileSync(edit.slice(0, eq), edit.slice(eq + 1));
      }
      const reviewing = reviewText !== undefined && cmd.message.includes('You are the reviewer');
      const answer = steered !== null ? `steered:${steered}` : reviewing ? reviewText : 'streamed';
      for (const delta of [answer.slice(0, 3), answer.slice(3)]) {
        if (aborted) return abortedEnd();
        out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta } });
        await pause();
      }
      const final = {
        role: 'assistant',
        content: [{ type: 'text', text: answer }],
        provider: model.provider,
        model: model.modelId,
        stopReason: 'stop',
        usage: turnUsage(10, 5, 0.25),
      };
      out({ type: 'turn_end', message: final });
      out({ type: 'agent_end', messages: [final] });
      return;
    }
    const text =
      reviewText !== undefined && cmd.message.includes('You are the reviewer')
        ? reviewText
        : `echo:${thinking ?? 'none'}:${cmd.message}`;
    const assistant =
      mode === 'model-error'
        ? {
            role: 'assistant',
            content: [],
            provider: model.provider,
            model: model.modelId,
            stopReason: 'error',
            errorMessage: 'usage_limit_reached',
          }
        : {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'hidden' },
              { type: 'text', text },
            ],
            provider: model.provider,
            model: model.modelId,
            stopReason: 'stop',
            usage: { input: 10, output: 5, cacheRead: 1, cacheWrite: 0, cost: { total: 0.25 } },
          };
    out({ type: 'agent_end', messages: [{ role: 'user', content: [{ type: 'text', text: cmd.message }] }, assistant] });
  }
});
