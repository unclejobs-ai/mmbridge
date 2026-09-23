import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadCatalog } from '../dist/catalog.js';

const fakeOmp = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-omp.mjs');

afterEach(() => {
  Reflect.deleteProperty(process.env, 'FAKE_OMP_MODE');
});

describe('loadCatalog', () => {
  it('counts models per authenticated provider and caches the result', async () => {
    const mmbridgeHome = await mkdtemp(path.join(tmpdir(), 'mmbridge-catalog-'));
    const first = await loadCatalog({ mmbridgeHome, binary: fakeOmp });
    assert.deepEqual(first.providers, { zai: 2, 'xai-oauth': 1 });
    assert.equal(first.stale, false);
    process.env.FAKE_OMP_MODE = 'models-fail';
    const second = await loadCatalog({ mmbridgeHome, binary: fakeOmp });
    assert.equal(second.fetchedAt, first.fetchedAt);
  });

  it('falls back to an expired cache when omp fails, and says so', async () => {
    const mmbridgeHome = await mkdtemp(path.join(tmpdir(), 'mmbridge-catalog-'));
    await writeFile(path.join(mmbridgeHome, 'catalog.json'), JSON.stringify({ fetchedAt: 1, providers: { zai: 5 } }));
    process.env.FAKE_OMP_MODE = 'models-fail';
    const catalog = await loadCatalog({ mmbridgeHome, binary: fakeOmp });
    assert.deepEqual(catalog, { fetchedAt: 1, providers: { zai: 5 }, stale: true });
  });

  it('throws when omp fails and there is no cache', async () => {
    const mmbridgeHome = await mkdtemp(path.join(tmpdir(), 'mmbridge-catalog-'));
    process.env.FAKE_OMP_MODE = 'models-fail';
    await assert.rejects(loadCatalog({ mmbridgeHome, binary: fakeOmp }));
  });
});
