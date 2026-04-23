import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { MemoryEntryType } from './types.js';

export interface SessionData {
  id: string;
  tool: string;
  mode: string;
  projectDir: string;
  status: string;
  summary?: string | null;
  findingsJson?: string | null;
  resultIndexJson?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationMessage {
  id?: number;
  sessionId?: string | null;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCallsJson?: string | null;
  tokensInput: number;
  tokensOutput: number;
  createdAt: string;
}

export interface GlobalMemoryEntry {
  id: string;
  projectDir: string;
  type: MemoryEntryType;
  title: string;
  content?: string | null;
  metadataJson?: string | null;
  createdAt: string;
}

function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function rowToSessionData(row: Record<string, unknown>): SessionData {
  return {
    id: String(row.id),
    tool: String(row.tool),
    mode: String(row.mode),
    projectDir: String(row.project_dir),
    status: String(row.status ?? 'complete'),
    summary: row.summary ? String(row.summary) : null,
    findingsJson: row.findings_json ? String(row.findings_json) : null,
    resultIndexJson: row.result_index_json ? String(row.result_index_json) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function rowToConversationMessage(row: Record<string, unknown>): ConversationMessage {
  return {
    id: typeof row.id === 'number' ? row.id : undefined,
    sessionId: row.session_id ? String(row.session_id) : null,
    role: String(row.role) as ConversationMessage['role'],
    content: String(row.content),
    toolCallsJson: row.tool_calls_json ? String(row.tool_calls_json) : null,
    tokensInput: typeof row.tokens_input === 'number' ? row.tokens_input : 0,
    tokensOutput: typeof row.tokens_output === 'number' ? row.tokens_output : 0,
    createdAt: String(row.created_at),
  };
}

function rowToGlobalMemoryEntry(row: Record<string, unknown>): GlobalMemoryEntry {
  return {
    id: String(row.id),
    projectDir: String(row.project_dir),
    type: String(row.type) as MemoryEntryType,
    title: String(row.title),
    content: row.content ? String(row.content) : null,
    metadataJson: row.metadata_json ? String(row.metadata_json) : null,
    createdAt: String(row.created_at),
  };
}

/**
 * A global SQLite-backed store for sessions, REPL conversation history, and
 * cross-project memory. Persists to `~/.mmbridge/state.db` by default.
 *
 * Requires Node.js 22.5+ for the built-in `node:sqlite` module.
 */
export class SqliteStore {
  private readonly db: DatabaseSync;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath ?? join(homedir(), '.mmbridge', 'state.db');
    mkdirSync(dirname(resolvedPath), { recursive: true });
    this.db = new DatabaseSync(resolvedPath);
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        tool TEXT NOT NULL,
        mode TEXT NOT NULL,
        project_dir TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'complete',
        summary TEXT,
        findings_json TEXT,
        result_index_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_dir);
      CREATE INDEX IF NOT EXISTS idx_sessions_created ON sessions(created_at DESC);

      CREATE TABLE IF NOT EXISTS conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_calls_json TEXT,
        tokens_input INTEGER NOT NULL DEFAULT 0,
        tokens_output INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_conversations_session ON conversations(session_id);
      CREATE INDEX IF NOT EXISTS idx_conversations_created ON conversations(created_at DESC);

      CREATE TABLE IF NOT EXISTS memory (
        id TEXT PRIMARY KEY,
        project_dir TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_memory_project ON memory(project_dir);
      CREATE INDEX IF NOT EXISTS idx_memory_type ON memory(type);
      CREATE INDEX IF NOT EXISTS idx_memory_created ON memory(created_at DESC);
    `);
  }

  // ---------------------------------------------------------------------------
  // Session methods
  // ---------------------------------------------------------------------------

  saveSession(
    data: Omit<SessionData, 'createdAt' | 'updatedAt'> & Partial<Pick<SessionData, 'createdAt' | 'updatedAt'>>,
  ): string {
    const now = new Date().toISOString();
    const createdAt = data.createdAt ?? now;
    const updatedAt = data.updatedAt ?? now;

    this.db
      .prepare(`
        INSERT OR REPLACE INTO sessions (
          id, tool, mode, project_dir, status, summary, findings_json, result_index_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        data.id,
        data.tool,
        data.mode,
        data.projectDir,
        data.status ?? 'complete',
        data.summary ?? null,
        data.findingsJson ?? null,
        data.resultIndexJson ?? null,
        createdAt,
        updatedAt,
      );

    return data.id;
  }

  getSession(id: string): SessionData | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ? LIMIT 1').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToSessionData(row) : null;
  }

  listSessions(projectDir: string, limit = 50): SessionData[] {
    const rows = this.db
      .prepare('SELECT * FROM sessions WHERE project_dir = ? ORDER BY created_at DESC LIMIT ?')
      .all(projectDir, limit) as Array<Record<string, unknown>>;
    return rows.map(rowToSessionData);
  }

  deleteSession(id: string): boolean {
    const result = this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    return (result as { changes: number }).changes > 0;
  }

  // ---------------------------------------------------------------------------
  // Conversation methods
  // ---------------------------------------------------------------------------

  saveMessage(
    sessionId: string | null,
    message: Omit<ConversationMessage, 'id' | 'createdAt'> & Partial<Pick<ConversationMessage, 'createdAt'>>,
  ): void {
    const now = new Date().toISOString();
    this.db
      .prepare(`
        INSERT INTO conversations (
          session_id, role, content, tool_calls_json, tokens_input, tokens_output, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        sessionId ?? null,
        message.role,
        message.content,
        message.toolCallsJson ?? null,
        message.tokensInput ?? 0,
        message.tokensOutput ?? 0,
        message.createdAt ?? now,
      );
  }

  getConversation(sessionId: string): ConversationMessage[] {
    const rows = this.db
      .prepare('SELECT * FROM conversations WHERE session_id = ? ORDER BY id ASC')
      .all(sessionId) as Array<Record<string, unknown>>;
    return rows.map(rowToConversationMessage);
  }

  getRecentMessages(limit = 20): ConversationMessage[] {
    const rows = this.db.prepare('SELECT * FROM conversations ORDER BY id DESC LIMIT ?').all(limit) as Array<
      Record<string, unknown>
    >;
    return rows.map(rowToConversationMessage).reverse();
  }

  deleteConversation(sessionId: string): number {
    const result = this.db.prepare('DELETE FROM conversations WHERE session_id = ?').run(sessionId);
    return (result as { changes: number }).changes;
  }

  // ---------------------------------------------------------------------------
  // Memory methods
  // ---------------------------------------------------------------------------

  saveMemory(entry: GlobalMemoryEntry): void {
    this.db
      .prepare(`
        INSERT OR REPLACE INTO memory (
          id, project_dir, type, title, content, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        entry.id,
        entry.projectDir,
        entry.type,
        entry.title,
        entry.content ?? null,
        entry.metadataJson ?? null,
        entry.createdAt ?? new Date().toISOString(),
      );
  }

  searchMemory(query: string, projectDir: string, limit = 10): GlobalMemoryEntry[] {
    const pattern = `%${query}%`;
    const rows = this.db
      .prepare(`
        SELECT * FROM memory
        WHERE project_dir = ?
          AND (title LIKE ? OR content LIKE ?)
        ORDER BY created_at DESC
        LIMIT ?
      `)
      .all(projectDir, pattern, pattern, limit) as Array<Record<string, unknown>>;
    return rows.map(rowToGlobalMemoryEntry);
  }

  listMemory(projectDir: string, type?: MemoryEntryType, limit = 20): GlobalMemoryEntry[] {
    const rows = type
      ? (this.db
          .prepare('SELECT * FROM memory WHERE project_dir = ? AND type = ? ORDER BY created_at DESC LIMIT ?')
          .all(projectDir, type, limit) as Array<Record<string, unknown>>)
      : (this.db
          .prepare('SELECT * FROM memory WHERE project_dir = ? ORDER BY created_at DESC LIMIT ?')
          .all(projectDir, limit) as Array<Record<string, unknown>>);
    return rows.map(rowToGlobalMemoryEntry);
  }

  deleteMemory(id: string): boolean {
    const result = this.db.prepare('DELETE FROM memory WHERE id = ?').run(id);
    return (result as { changes: number }).changes > 0;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  close(): void {
    this.db.close();
  }

  /** Parse a stored findings_json field back to an object array, or return empty. */
  static parseFindings<T>(findingsJson: string | null | undefined): T[] {
    return safeJsonParse<T[]>(findingsJson ?? null, []);
  }

  /** Parse a stored metadata_json field back to an object, or return empty object. */
  static parseMetadata(metadataJson: string | null | undefined): Record<string, unknown> {
    return safeJsonParse<Record<string, unknown>>(metadataJson ?? null, {});
  }
}
