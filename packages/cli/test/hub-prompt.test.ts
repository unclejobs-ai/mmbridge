import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveHubTaskAnswer } from '../src/commands/hub.ts';

test('a bare role name at the task prompt is asked again, not dispatched as the task', () => {
  // Typing "worker" sent the word as the task; the model found nothing to do and
  // went digging through handoffs and context packets for one.
  assert.deepEqual(resolveHubTaskAnswer('worker'), {
    retry: '"worker" is a role, not a task. Pick roles with -r (mmbridge hub -r worker); type the task.',
  });
  assert.ok('retry' in resolveHubTaskAnswer(' Reviewer '));
  assert.ok('retry' in resolveHubTaskAnswer('   '));
  assert.deepEqual(resolveHubTaskAnswer('  fix the flaky gate test '), { task: 'fix the flaky gate test' });
});
