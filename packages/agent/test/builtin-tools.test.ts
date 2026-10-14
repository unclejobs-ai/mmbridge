import assert from 'node:assert/strict';
import test from 'node:test';
import { mmbridge_research } from '../dist/builtin-tools.js';

test('mmbridge_research rejects an empty topic without calling adapters', async () => {
  assert.equal(await mmbridge_research.execute({}), 'Research failed: topic is required.');
  assert.equal(await mmbridge_research.execute({ topic: '   ' }), 'Research failed: topic is required.');
});

test('mmbridge_research points the caller to the CLI for full research', async () => {
  const result = await mmbridge_research.execute({ topic: 'property-based testing' });
  assert.match(result, /Research topic: "property-based testing"/);
  assert.match(result, /mmbridge research "property-based testing"/);
});
