import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { LoadedSkill, SkillHookDef, SkillManifest, SkillToolDef } from './types.js';

/** Names checked in order when locating a skill manifest. */
const MANIFEST_NAMES = ['skill.json', 'skill.yaml', 'skill.yml'] as const;

function assertManifestShape(value: unknown, skillDir: string): asserts value is SkillManifest {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`Skill manifest in "${skillDir}" must be a JSON object`);
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.name !== 'string' || obj.name.length === 0) {
    throw new Error(`Skill manifest in "${skillDir}" is missing required string field "name"`);
  }
  if (typeof obj.version !== 'string' || obj.version.length === 0) {
    throw new Error(`Skill manifest in "${skillDir}" is missing required string field "version"`);
  }
  if (typeof obj.description !== 'string' || obj.description.length === 0) {
    throw new Error(`Skill manifest in "${skillDir}" is missing required string field "description"`);
  }
}

async function readManifest(skillDir: string): Promise<{ manifest: SkillManifest; manifestPath: string } | null> {
  for (const name of MANIFEST_NAMES) {
    const manifestPath = path.join(skillDir, name);
    try {
      const raw = await fs.readFile(manifestPath, 'utf8');
      if (name.endsWith('.json')) {
        const parsed: unknown = JSON.parse(raw);
        assertManifestShape(parsed, skillDir);
        return { manifest: parsed, manifestPath };
      }
      // YAML manifests require an external YAML parser (not included — zero-dep constraint).
      // Treat as unsupported and fall through to the next candidate.
      throw new Error(
        `Skill manifest "${manifestPath}" uses YAML format, which requires an external parser. Rename to skill.json or convert to JSON format.`,
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        continue; // file does not exist — try next name
      }
      throw err; // parse error or YAML-unsupported error
    }
  }
  return null; // no manifest found in this directory
}

async function loadToolHandler(
  skillDir: string,
  toolDef: SkillToolDef,
): Promise<(input: Record<string, unknown>) => Promise<string>> {
  const handlerPath = path.resolve(skillDir, toolDef.handler);
  const handlerUrl = pathToFileURL(handlerPath).href;
  const mod: unknown = await import(handlerUrl);
  if (typeof mod !== 'object' || mod === null || typeof (mod as Record<string, unknown>).default !== 'function') {
    throw new Error(`Tool handler "${toolDef.handler}" in skill "${skillDir}" must export a default function`);
  }
  return (mod as { default: (input: Record<string, unknown>) => Promise<string> }).default;
}

async function loadHookHandler(
  skillDir: string,
  hookDef: SkillHookDef,
): Promise<(context: Record<string, unknown>) => Promise<void>> {
  const handlerPath = path.resolve(skillDir, hookDef.handler);
  const handlerUrl = pathToFileURL(handlerPath).href;
  const mod: unknown = await import(handlerUrl);
  if (typeof mod !== 'object' || mod === null || typeof (mod as Record<string, unknown>).default !== 'function') {
    throw new Error(`Hook handler "${hookDef.handler}" in skill "${skillDir}" must export a default function`);
  }
  return (mod as { default: (ctx: Record<string, unknown>) => Promise<void> }).default;
}

export class SkillLoader {
  private readonly skillDirs: string[];
  private readonly loaded: Map<string, LoadedSkill> = new Map();

  constructor(skillDirs?: string[]) {
    // Default: ~/.mmbridge/skills/ (global) + .mmbridge/skills/ (project-local)
    this.skillDirs = skillDirs ?? [
      path.join(os.homedir(), '.mmbridge', 'skills'),
      path.join(process.cwd(), '.mmbridge', 'skills'),
    ];
  }

  /** Scan all skill directories and return manifests for discovered skills. */
  async discover(): Promise<SkillManifest[]> {
    const manifests: SkillManifest[] = [];
    const seen = new Set<string>(); // deduplicate by skill name (project-local wins)

    // Iterate dirs in reverse so project-local (last) overwrites global (first)
    const dirsInPrecedenceOrder = [...this.skillDirs].reverse();

    for (const baseDir of dirsInPrecedenceOrder) {
      let entries: string[];
      try {
        const dirEntries = await fs.readdir(baseDir, { withFileTypes: true });
        entries = dirEntries.filter((e) => e.isDirectory()).map((e) => path.join(baseDir, e.name));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          continue; // directory does not exist yet — skip silently
        }
        throw err;
      }

      for (const skillDir of entries) {
        const result = await readManifest(skillDir);
        if (result === null) continue;
        if (!seen.has(result.manifest.name)) {
          seen.add(result.manifest.name);
          manifests.push(result.manifest);
        }
      }
    }

    return manifests;
  }

  /** Load a skill by name and cache it. Throws if the skill cannot be found or is invalid. */
  async load(skillName: string): Promise<LoadedSkill> {
    const cached = this.loaded.get(skillName);
    if (cached !== undefined) return cached;

    // Search dirs in reverse precedence (project-local overrides global)
    const dirsInPrecedenceOrder = [...this.skillDirs].reverse();

    for (const baseDir of dirsInPrecedenceOrder) {
      const skillDir = path.join(baseDir, skillName);
      const result = await readManifest(skillDir);
      if (result === null) continue;

      const { manifest } = result;

      // Read optional system prompt from SKILL.md
      let systemPrompt: string | null = null;
      try {
        systemPrompt = await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }

      // Load tool handlers
      const tools: LoadedSkill['tools'] = [];
      for (const toolDef of manifest.tools ?? []) {
        const execute = await loadToolHandler(skillDir, toolDef);
        tools.push({
          name: toolDef.name,
          description: toolDef.description,
          inputSchema: toolDef.inputSchema,
          execute,
        });
      }

      // Load hook handlers
      const hooks: LoadedSkill['hooks'] = [];
      for (const hookDef of manifest.hooks ?? []) {
        const handler = await loadHookHandler(skillDir, hookDef);
        hooks.push({ event: hookDef.event, handler });
      }

      const skill: LoadedSkill = { manifest, directory: skillDir, systemPrompt, tools, hooks };
      this.loaded.set(skillName, skill);
      return skill;
    }

    throw new Error(`Skill "${skillName}" not found. Searched in: ${this.skillDirs.join(', ')}`);
  }

  /** Discover and load all available skills. */
  async loadAll(): Promise<LoadedSkill[]> {
    const manifests = await this.discover();
    const skills: LoadedSkill[] = [];
    for (const manifest of manifests) {
      const skill = await this.load(manifest.name);
      skills.push(skill);
    }
    return skills;
  }

  get(name: string): LoadedSkill | undefined {
    return this.loaded.get(name);
  }

  list(): LoadedSkill[] {
    return [...this.loaded.values()];
  }
}
