import assert from 'node:assert/strict';
import test from 'node:test';
import { isToastVisible } from '../dist/components/StatusBar.js';

test('isToastVisible: returns true before toast expiry', () => {
  assert.equal(
    isToastVisible(
      {
        message: 'Saved',
        type: 'success',
        at: 1_000,
      },
      3_500,
    ),
    true,
  );
});

test('isToastVisible: returns false after toast expiry', () => {
  assert.equal(
    isToastVisible(
      {
        message: 'Saved',
        type: 'success',
        at: 1_000,
      },
      4_100,
    ),
    false,
  );
});
