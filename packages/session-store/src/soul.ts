import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_SOUL = `# mmbridge SOUL

## Identity
mmbridge is a conversational multi-model orchestrator for coding work.

## Preferences
- Respond in the user's language
- Be concise and direct
- Use tools proactively when they can help
- Synthesize multi-model results into clear recommendations

## Observations
(Observations are added automatically as mmbridge learns about the user)
`;

/**
 * Manages the SOUL.md file — mmbridge's persistent agent identity document.
 *
 * SOUL.md lives at `~/.mmbridge/SOUL.md` by default and captures the agent's
 * accumulated preferences, observations, and working style. It is loaded into
 * context at the start of REPL sessions to give mmbridge continuity across
 * conversations.
 */
export class SoulStore {
  private readonly soulPath: string;

  constructor(baseDir?: string) {
    this.soulPath = join(baseDir ?? join(homedir(), '.mmbridge'), 'SOUL.md');
  }

  /** The absolute path to the SOUL.md file. */
  get path(): string {
    return this.soulPath;
  }

  /**
   * Load the current SOUL.md content. Returns the default soul if the file
   * does not exist yet.
   */
  async load(): Promise<string> {
    try {
      return await fs.readFile(this.soulPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return this.getDefaultSoul();
      }
      throw error;
    }
  }

  /**
   * Overwrite the entire SOUL.md with new content.
   */
  async save(content: string): Promise<void> {
    await fs.writeFile(this.soulPath, content, { encoding: 'utf8', mode: 0o600 });
  }

  /**
   * Append an observation to the Observations section of SOUL.md. If the
   * section is not found, the observation is appended at the end of the file.
   *
   * @param observation - A single observation line (no leading "- " required;
   *   one will be prepended automatically).
   */
  async appendObservation(observation: string): Promise<void> {
    const current = await this.load();
    const trimmed = observation.trim();
    if (!trimmed) return;

    const bullet = `- ${trimmed}`;
    const observationsHeader = '## Observations';

    if (current.includes(observationsHeader)) {
      // Insert the bullet right after the section header (and its trailing blank
      // line if present), before the next section or end of file.
      const headerIndex = current.indexOf(observationsHeader);
      const afterHeader = current.indexOf('\n', headerIndex) + 1;

      // Skip a single blank line that typically follows the header.
      const nextLine = current.slice(afterHeader);
      const insertAt =
        nextLine.startsWith('\n') || nextLine.startsWith('(') ? afterHeader + nextLine.indexOf('\n') + 1 : afterHeader;

      const updated = `${current.slice(0, insertAt) + bullet}\n${current.slice(insertAt)}`;
      await this.save(updated);
    } else {
      // No Observations section — append at end of file.
      const separator = current.endsWith('\n') ? '' : '\n';
      await this.save(`${current + separator}\n${observationsHeader}\n${bullet}\n`);
    }
  }

  /**
   * Returns true if a SOUL.md file exists on disk (i.e., it has been
   * explicitly initialised and is not just the default).
   */
  async exists(): Promise<boolean> {
    try {
      await fs.access(this.soulPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Write the default SOUL.md to disk if it does not already exist.
   * Returns true if the file was created, false if it already existed.
   */
  async initIfAbsent(): Promise<boolean> {
    if (await this.exists()) return false;
    await this.save(this.getDefaultSoul());
    return true;
  }

  /** The default SOUL.md content used when no file exists yet. */
  getDefaultSoul(): string {
    return DEFAULT_SOUL;
  }
}
