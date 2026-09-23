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
if (spawnLog) (await import('node:fs')).appendFileSync(spawnLog, 'spawn\n');
// Worker simulation: with tools on (`--approval-mode yolo`, no `--no-tools`), FAKE_OMP_EDIT="path=content" edits cwd.
const toolsEnabled = !process.argv.includes('--no-tools') && process.argv.includes('yolo');
const edit = process.env.FAKE_OMP_EDIT;
// Reviewer simulation: the text a reviewer-role prompt gets back.
const reviewText = process.env.FAKE_OMP_REVIEW;
const out = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
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
createInterface({ input: process.stdin }).on('line', (line) => {
  const cmd = JSON.parse(line);
  if (cmd.type === 'set_model') {
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
