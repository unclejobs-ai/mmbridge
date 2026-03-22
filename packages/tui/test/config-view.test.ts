import assert from 'node:assert/strict';
import test from 'node:test';
import { canBeginConfigInteraction } from '../dist/views/ConfigView.js';

test('canBeginConfigInteraction: blocks edits while config is loading', () => {
  assert.equal(
    canBeginConfigInteraction({
      configStatus: 'loading',
      saving: false,
      testing: false,
    }),
    false,
  );
});

test('canBeginConfigInteraction: blocks edits after config load failure', () => {
  assert.equal(
    canBeginConfigInteraction({
      configStatus: 'error',
      saving: false,
      testing: false,
    }),
    false,
  );
});

test('canBeginConfigInteraction: allows edits when config is ready and idle', () => {
  assert.equal(
    canBeginConfigInteraction({
      configStatus: 'ready',
      saving: false,
      testing: false,
    }),
    true,
  );
});
