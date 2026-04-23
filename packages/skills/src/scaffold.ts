import fs from 'node:fs/promises';
import path from 'node:path';

import type { SkillManifest } from './types.js';

const MANIFEST_TEMPLATE = (name: string): SkillManifest => ({
  name,
  version: '0.1.0',
  description: `${name} skill`,
  tools: [
    {
      name: `${name}-example`,
      description: `Example tool provided by the ${name} skill`,
      inputSchema: {
        type: 'object',
        properties: {
          input: { type: 'string', description: 'Input value' },
        },
        required: ['input'],
      },
      handler: './handler.js',
    },
  ],
  hooks: [],
  commands: [],
});

const SKILL_MD_TEMPLATE = (name: string): string =>
  `# ${name} Skill

Add your system prompt extension here. This text is appended to the agent's system prompt
when this skill is loaded.
`;

const HANDLER_TEMPLATE = `/**
 * Example tool handler. Replace with your implementation.
 *
 * @param input - Validated input matching the tool's inputSchema
 * @returns A string result that will be returned to the agent
 */
export default async function handler(input: Record<string, unknown>): Promise<string> {
  const value = typeof input['input'] === 'string' ? input['input'] : '';
  return \`Received: \${value}\`;
}
`;

/**
 * Scaffold a new skill directory with a manifest, system prompt template, and example handler.
 *
 * @param name      - The skill name (used as directory name and in manifest)
 * @param directory - Parent directory to create the skill in. Defaults to the current working directory.
 * @returns         The absolute path to the created skill directory.
 */
export async function scaffoldSkill(name: string, directory?: string): Promise<string> {
  if (!name || name.trim().length === 0) {
    throw new Error('Skill name must be a non-empty string');
  }

  const baseDir = path.resolve(directory ?? process.cwd());
  const skillDir = path.join(baseDir, name);

  // Fail fast if the directory already exists to avoid overwriting an existing skill
  try {
    await fs.access(skillDir);
    throw new Error(`Skill directory already exists: "${skillDir}"`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }

  await fs.mkdir(skillDir, { recursive: true });

  await Promise.all([
    fs.writeFile(path.join(skillDir, 'skill.json'), `${JSON.stringify(MANIFEST_TEMPLATE(name), null, 2)}\n`, 'utf8'),
    fs.writeFile(path.join(skillDir, 'SKILL.md'), SKILL_MD_TEMPLATE(name), 'utf8'),
    fs.writeFile(path.join(skillDir, 'handler.ts'), HANDLER_TEMPLATE, 'utf8'),
  ]);

  return skillDir;
}
