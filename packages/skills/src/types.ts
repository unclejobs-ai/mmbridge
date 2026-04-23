export interface SkillManifest {
  name: string;
  version: string;
  description: string;
  author?: string;

  // What the skill provides
  systemPrompt?: string; // Additional system prompt text
  tools?: SkillToolDef[]; // Tools the skill adds
  hooks?: SkillHookDef[]; // Hooks the skill registers
  commands?: SkillCommandDef[]; // Slash commands the skill adds
}

export interface SkillToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: string; // relative path to handler file
}

export interface SkillHookDef {
  event: string; // e.g. 'PreToolUse', 'PostToolUse', 'SessionStart'
  handler: string; // relative path to handler file
}

export interface SkillCommandDef {
  name: string;
  description: string;
  handler: string; // relative path to handler file
}

export interface LoadedSkill {
  manifest: SkillManifest;
  directory: string;
  systemPrompt: string | null;
  tools: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    execute: (input: Record<string, unknown>) => Promise<string>;
  }>;
  hooks: Array<{
    event: string;
    handler: (context: Record<string, unknown>) => Promise<void>;
  }>;
}
