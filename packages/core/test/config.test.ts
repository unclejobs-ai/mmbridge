import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DEFAULT_CLASSIFIERS, classifyFileWithRules, loadConfig, resolveClassifiers } from '../dist/config.js';
import type { FileClassifierRule, MmbridgeConfig } from '../dist/types.js';

// DEFAULT_CLASSIFIERS
test('DEFAULT_CLASSIFIERS contains expected categories', () => {
  const categories = DEFAULT_CLASSIFIERS.map((r) => r.category);
  assert.ok(categories.includes('API'));
  assert.ok(categories.includes('Routes'));
  assert.ok(categories.includes('Component'));
  assert.ok(categories.includes('Library'));
  assert.ok(categories.includes('Hook'));
  assert.ok(categories.includes('Test'));
  assert.ok(categories.includes('State'));
  assert.ok(categories.includes('Utility'));
  assert.ok(categories.includes('CI/CD'));
  assert.ok(categories.includes('Script'));
  assert.ok(categories.includes('Documentation'));
});

test('DEFAULT_CLASSIFIERS is a non-empty array of rules', () => {
  assert.ok(Array.isArray(DEFAULT_CLASSIFIERS));
  assert.ok(DEFAULT_CLASSIFIERS.length > 0);
  for (const rule of DEFAULT_CLASSIFIERS) {
    assert.equal(typeof rule.pattern, 'string');
    assert.equal(typeof rule.category, 'string');
  }
});

// classifyFileWithRules
test('classifyFileWithRules: matches by prefix', () => {
  const rules: FileClassifierRule[] = [
    { pattern: 'src/api/', category: 'API' },
    { pattern: 'src/components/', category: 'Component' },
  ];
  assert.equal(classifyFileWithRules('src/api/users.ts', rules), 'API');
  assert.equal(classifyFileWithRules('src/components/Button.tsx', rules), 'Component');
});

test('classifyFileWithRules: returns Other for no match', () => {
  const rules: FileClassifierRule[] = [{ pattern: 'src/api/', category: 'API' }];
  assert.equal(classifyFileWithRules('src/something/else.ts', rules), 'Other');
});

test('classifyFileWithRules: first matching rule wins', () => {
  const rules: FileClassifierRule[] = [
    { pattern: 'src/api/', category: 'API' },
    { pattern: 'src/', category: 'Source' },
  ];
  assert.equal(classifyFileWithRules('src/api/route.ts', rules), 'API');
});

test('classifyFileWithRules: empty rules returns Other', () => {
  assert.equal(classifyFileWithRules('anything.ts', []), 'Other');
});

test('classifyFileWithRules: exact prefix match required', () => {
  const rules: FileClassifierRule[] = [{ pattern: 'lib/', category: 'Library' }];
  // Does not start with 'lib/'
  assert.equal(classifyFileWithRules('packages/lib/foo.ts', rules), 'Other');
  // Starts with 'lib/'
  assert.equal(classifyFileWithRules('lib/helpers.ts', rules), 'Library');
});

// resolveClassifiers
test('resolveClassifiers: returns DEFAULT_CLASSIFIERS when no classifiers in config', () => {
  const config: MmbridgeConfig = {};
  const result = resolveClassifiers(config);
  assert.deepEqual(result, DEFAULT_CLASSIFIERS);
});

test('resolveClassifiers: prepends custom classifiers when extendDefaultClassifiers is true', () => {
  const custom: FileClassifierRule[] = [{ pattern: 'custom/', category: 'Custom' }];
  const config: MmbridgeConfig = { classifiers: custom, extendDefaultClassifiers: true };
  const result = resolveClassifiers(config);
  assert.equal(result[0].pattern, 'custom/');
  assert.equal(result[0].category, 'Custom');
  // Default classifiers follow
  assert.ok(result.length > 1);
});

test('resolveClassifiers: prepends custom classifiers when extendDefaultClassifiers is undefined (default)', () => {
  const custom: FileClassifierRule[] = [{ pattern: 'custom/', category: 'Custom' }];
  const config: MmbridgeConfig = { classifiers: custom };
  const result = resolveClassifiers(config);
  assert.equal(result[0].pattern, 'custom/');
  assert.ok(result.length > 1);
});

test('resolveClassifiers: replaces classifiers when extendDefaultClassifiers is false', () => {
  const custom: FileClassifierRule[] = [{ pattern: 'custom/', category: 'Custom' }];
  const config: MmbridgeConfig = { classifiers: custom, extendDefaultClassifiers: false };
  const result = resolveClassifiers(config);
  assert.deepEqual(result, custom);
  assert.equal(result.length, 1);
});

// loadConfig
test('loadConfig: returns empty object when no config file exists', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mmbridge-cfg-test-'));
  try {
    const config = await loadConfig(tmpDir);
    assert.deepEqual(config, {});
  } finally {
    await fs.rm(tmpDir, { recursive: true });
  }
});

test('loadConfig: reads .mmbridge.config.json', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mmbridge-cfg-test-'));
  try {
    const configData: MmbridgeConfig = { extendDefaultClassifiers: false };
    await fs.writeFile(path.join(tmpDir, '.mmbridge.config.json'), JSON.stringify(configData), 'utf8');
    const config = await loadConfig(tmpDir);
    assert.equal(config.extendDefaultClassifiers, false);
  } finally {
    await fs.rm(tmpDir, { recursive: true });
  }
});

test('loadConfig: reads mmbridge.config.json (without dot prefix)', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mmbridge-cfg-test-'));
  try {
    const configData: MmbridgeConfig = { extendDefaultClassifiers: true };
    await fs.writeFile(path.join(tmpDir, 'mmbridge.config.json'), JSON.stringify(configData), 'utf8');
    const config = await loadConfig(tmpDir);
    assert.equal(config.extendDefaultClassifiers, true);
  } finally {
    await fs.rm(tmpDir, { recursive: true });
  }
});

test('loadConfig: throws on invalid JSON', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mmbridge-cfg-test-'));
  try {
    await fs.writeFile(path.join(tmpDir, '.mmbridge.config.json'), '{ invalid json }', 'utf8');
    await assert.rejects(
      () => loadConfig(tmpDir),
      (err: unknown) => err instanceof SyntaxError,
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true });
  }
});

test('loadConfig: throws on invalid config shape (classifiers not array)', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mmbridge-cfg-test-'));
  try {
    await fs.writeFile(
      path.join(tmpDir, '.mmbridge.config.json'),
      JSON.stringify({ classifiers: 'not-an-array' }),
      'utf8',
    );
    await assert.rejects(() => loadConfig(tmpDir), /Invalid mmbridge config/);
  } finally {
    await fs.rm(tmpDir, { recursive: true });
  }
});
