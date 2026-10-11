#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Each invocation consumes one scripted response and records its exact argv.
const statePath = process.env.FAKE_HERDR_STATE;
if (!statePath) throw new Error('FAKE_HERDR_STATE is required');
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const args = process.argv.slice(2);
state.calls ??= [];
state.calls.push(args);
const step = state.steps.shift();
fs.writeFileSync(statePath, JSON.stringify(state));
assert.ok(step, `unexpected herdr call: ${JSON.stringify(args)}`);
assert.deepEqual(args, step.args);
if (step.delayMs) await new Promise((resolve) => setTimeout(resolve, step.delayMs));
if (step.stderr) process.stderr.write(step.stderr);
process.stdout.write(typeof step.stdout === 'string' ? step.stdout : `${JSON.stringify(step.stdout)}\n`);
process.exitCode = step.exit ?? 0;
