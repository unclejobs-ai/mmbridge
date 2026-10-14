import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SkillLoader } from '../dist/loader.js';

const HANDLER_MJS = [
  'export default async function handler(input) {',
  "  return `echo:${input?.input ?? ''}`;",
  '};',
  '',
].join('\n');

const HOOK_MJS = ['export default async function hook(context) {', '  return context?.ok === true;', '};', ''].join(
  '\n',
);

interface ManifestFixture {
  name?: string;
  version: string;
  description: string;
  tools?: Array<Record<string, unknown>>;
  hooks?: Array<Record<string, unknown>>;
}

async function writeSkill(
  baseDir: string,
  name: string,
  manifest: ManifestFixture,
  files: Record<string, string> = {},
): Promise<string> {
  const skillDir = path.join(baseDir, name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, 'skill.json'), JSON.stringify(manifest));
  for (const [fileName, contents] of Object.entries(files)) {
    await writeFile(path.join(skillDir, fileName), contents);
  }
  return skillDir;
}

function alphaManifest(): ManifestFixture {
  return {
    name: 'alpha',
    version: '1.0.0',
    description: 'Alpha test skill',
    tools: [
      {
        name: 'alpha-echo',
        description: 'Echo tool',
        inputSchema: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] },
        handler: './handler.mjs',
      },
    ],
    hooks: [{ event: 'SessionStart', handler: './hook.mjs' }],
  };
}

async function makeBaseDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'mmbridge-skills-'));
}

test('discover returns manifests for valid skill directories', async () => {
  const baseDir = await makeBaseDir();
  await writeSkill(baseDir, 'alpha', alphaManifest(), {
    'SKILL.md': '# Alpha\nAlpha prompt text',
    'handler.mjs': HANDLER_MJS,
    'hook.mjs': HOOK_MJS,
  });

  const loader = new SkillLoader([baseDir]);
  const manifests = await loader.discover();

  assert.equal(manifests.length, 1);
  assert.equal(manifests[0]?.name, 'alpha');
  assert.equal(manifests[0]?.version, '1.0.0');
  assert.equal(manifests[0]?.description, 'Alpha test skill');
});

test('discover skips skill directories without a manifest and missing roots', async () => {
  const baseDir = await makeBaseDir();
  await writeSkill(baseDir, 'alpha', alphaManifest());
  await mkdir(path.join(baseDir, 'empty'), { recursive: true });

  const loader = new SkillLoader([baseDir, path.join(baseDir, 'missing-root')]);
  const manifests = await loader.discover();

  assert.deepEqual(
    manifests.map((m) => m.name),
    ['alpha'],
  );
});

test('discover enforces manifest shape guardrails', async () => {
  const missingName = await makeBaseDir();
  await writeSkill(missingName, 'broken', { version: '1.0.0', description: 'no name' });
  await assert.rejects(new SkillLoader([missingName]).discover(), /missing required string field "name"/);

  const malformed = await makeBaseDir();
  await mkdir(path.join(malformed, 'broken'), { recursive: true });
  await writeFile(path.join(malformed, 'broken', 'skill.json'), '{ not json');
  await assert.rejects(new SkillLoader([malformed]).discover(), SyntaxError);
});

test('discover rejects YAML manifests with a rename hint', async () => {
  const baseDir = await makeBaseDir();
  await mkdir(path.join(baseDir, 'yaml-only'), { recursive: true });
  await writeFile(path.join(baseDir, 'yaml-only', 'skill.yaml'), 'name: yaml-only\n');

  await assert.rejects(new SkillLoader([baseDir]).discover(), /Rename to skill\.json/);
});

test('load exposes system prompt, executable tools, and hooks', async () => {
  const baseDir = await makeBaseDir();
  await writeSkill(baseDir, 'alpha', alphaManifest(), {
    'SKILL.md': '# Alpha\nAlpha prompt text',
    'handler.mjs': HANDLER_MJS,
    'hook.mjs': HOOK_MJS,
  });

  const loader = new SkillLoader([baseDir]);
  const skill = await loader.load('alpha');

  assert.equal(skill.directory, path.join(baseDir, 'alpha'));
  assert.match(skill.systemPrompt ?? '', /Alpha prompt text/);
  assert.deepEqual(
    skill.tools.map((t) => t.name),
    ['alpha-echo'],
  );
  assert.equal(await skill.tools[0]?.execute({ input: 'hi' }), 'echo:hi');
  assert.equal(skill.hooks[0]?.event, 'SessionStart');
  assert.equal(await skill.hooks[0]?.handler({ ok: true }), true);

  assert.equal(loader.get('alpha'), skill);
  assert.deepEqual(
    loader.list().map((s) => s.manifest.name),
    ['alpha'],
  );
});

test('load prefers project-local skills over global ones on name conflicts', async () => {
  const globalDir = await makeBaseDir();
  const projectDir = await makeBaseDir();
  const files = { 'handler.mjs': HANDLER_MJS, 'hook.mjs': HOOK_MJS };
  await writeSkill(globalDir, 'dup', { ...alphaManifest(), name: 'dup', description: 'global copy' }, files);
  await writeSkill(projectDir, 'dup', { ...alphaManifest(), name: 'dup', description: 'project copy' }, files);

  const loader = new SkillLoader([globalDir, projectDir]);
  const manifests = await loader.discover();
  assert.deepEqual(
    manifests.map((m) => m.description),
    ['project copy'],
  );

  const skill = await loader.load('dup');
  assert.equal(skill.manifest.description, 'project copy');
  assert.equal(skill.directory, path.join(projectDir, 'dup'));
});

test('load throws a descriptive error for unknown skills', async () => {
  const baseDir = await makeBaseDir();
  const loader = new SkillLoader([baseDir]);

  await assert.rejects(loader.load('nope'), /Skill "nope" not found/);
});
