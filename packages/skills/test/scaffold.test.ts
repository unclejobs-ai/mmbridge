import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SkillLoader } from '../dist/loader.js';
import { scaffoldSkill } from '../dist/scaffold.js';

async function makeBaseDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'mmbridge-skills-scaffold-'));
}

test('scaffoldSkill creates manifest, prompt, and handler files', async () => {
  const baseDir = await makeBaseDir();
  const skillDir = await scaffoldSkill('greet', baseDir);

  assert.equal(skillDir, path.join(baseDir, 'greet'));
  assert.deepEqual((await readdir(skillDir)).sort(), ['SKILL.md', 'handler.ts', 'skill.json']);

  const manifest = JSON.parse(await readFile(path.join(skillDir, 'skill.json'), 'utf8')) as {
    name?: string;
    version?: string;
    description?: string;
    tools?: Array<{ name?: string; handler?: string }>;
  };
  assert.equal(manifest.name, 'greet');
  assert.equal(manifest.version, '0.1.0');
  assert.equal(manifest.description, 'greet skill');
  assert.equal(manifest.tools?.[0]?.name, 'greet-example');
  assert.equal(manifest.tools?.[0]?.handler, './handler.js');
});

test('scaffoldSkill refuses empty names and existing directories', async () => {
  const baseDir = await makeBaseDir();

  await assert.rejects(scaffoldSkill('', baseDir), /non-empty string/);
  await assert.rejects(scaffoldSkill('   ', baseDir), /non-empty string/);

  await scaffoldSkill('dupe', baseDir);
  await assert.rejects(scaffoldSkill('dupe', baseDir), /already exists/);
});

test('scaffolded manifests round-trip through the loader', async () => {
  const baseDir = await makeBaseDir();
  await scaffoldSkill('roundtrip', baseDir);

  const loader = new SkillLoader([baseDir]);
  const manifests = await loader.discover();

  assert.equal(manifests.length, 1);
  assert.equal(manifests[0]?.name, 'roundtrip');
  assert.equal(manifests[0]?.version, '0.1.0');
  assert.equal(manifests[0]?.description, 'roundtrip skill');
  assert.equal(manifests[0]?.tools?.[0]?.name, 'roundtrip-example');
});
