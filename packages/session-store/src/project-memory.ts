import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ContextIndex } from '@mmbridge/core';
import { SessionStore } from './stores.js';
import type {
  HandoffArtifact,
  HandoffDocument,
  MemoryEntry,
  MemoryEntryType,
  MemorySearchOptions,
  MemoryTimelineOptions,
  RecallEntrySummary,
  RecallResult,
  Session,
} from './types.js';

function toProjectKey(projectDir: string): string {
  return path
    .resolve(projectDir)
    .replace(/[\\/]/g, '-')
    .replace(/^(?!-)/, '-');
}

function safeJsonParse<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function toFtsQuery(query: string): string {
  const tokens = query
    .split(/[^a-zA-Z0-9_]+/)
    .map((token) => token.trim())
    .filter(Boolean);
  return tokens.join(' ');
}

function toSearchTerms(query: string): string[] {
  return query
    .split(/[^a-zA-Z0-9_]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function isMissingFtsModule(error: unknown): boolean {
  return error instanceof Error && /no such module:\s*fts5/i.test(error.message);
}

function contextDigestFromSession(session: Session): string {
  if (session.contextDigest) return session.contextDigest;

  const contextIndex = session.contextIndex;
  if (!contextIndex) return 'No context digest recorded';

  const bits = [
    `${contextIndex.changedFiles} changed`,
    `${contextIndex.copiedFiles} copied`,
    contextIndex.redaction ? `${contextIndex.redaction.usedRuleCount} redactions` : '0 redactions',
  ];
  return bits.join(' · ');
}

function summarizeInterpretation(session: Session): string | null {
  if (!session.interpretation) return null;
  return [
    `${session.interpretation.validated.length} valid`,
    `${session.interpretation.falsePositives.length} false+`,
    `${session.interpretation.promoted.length} promoted`,
  ].join(' · ');
}

function summarizeContext(contextIndex: ContextIndex | null | undefined): string | null {
  if (!contextIndex) return null;
  const changed = contextIndex.changedFiles;
  const copied = contextIndex.copiedFiles;
  const redaction = contextIndex.redaction ? `${contextIndex.redaction.usedRuleCount} redaction rules` : 'no redaction';
  return `${changed} changed file(s) · ${copied} copied file(s) · ${redaction}`;
}

function collectOpenBlockers(session: Session): string[] {
  const topFindings = (session.findings ?? [])
    .filter((finding) => finding.severity === 'CRITICAL' || finding.severity === 'WARNING')
    .slice(0, 5)
    .map((finding) => {
      const location = finding.line != null ? `${finding.file}:${finding.line}` : finding.file;
      return `[${finding.severity}] ${location} - ${finding.message}`;
    });

  const actionBlockers = session.interpretation?.actionPlan
    ? session.interpretation.actionPlan
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => /block|follow-?up|todo|next/i.test(line))
        .slice(0, 3)
    : [];

  return [...topFindings, ...actionBlockers].slice(0, 6);
}

function deriveNextPrompt(session: Session, blockers: string[]): string {
  if (blockers[0]) {
    return `Re-open the latest session, validate the top blocker, and propose the smallest safe fix.\n\nFocus on: ${blockers[0]}`;
  }
  if ((session.findings ?? []).length > 0) {
    const finding = session.findings?.[0];
    if (finding) {
      const location = finding.line != null ? `${finding.file}:${finding.line}` : finding.file;
      return `Re-check this finding, tighten the wording if needed, and suggest the minimum patch.\n\n[${finding.severity}] ${location} - ${finding.message}`;
    }
  }
  return 'Resume this review, confirm no unresolved issues remain, and propose the next most valuable follow-up.';
}

function deriveNextCommand(session: Session, nextPrompt: string): string {
  if (session.followupSupported && session.externalSessionId) {
    return `mmbridge followup --tool ${session.tool} --project ${session.projectDir} --session ${session.externalSessionId} --prompt ${JSON.stringify(nextPrompt)}`;
  }

  if (session.tool === 'bridge') {
    return `mmbridge review --tool all --project ${session.projectDir}${session.baseRef ? ` --base-ref ${session.baseRef}` : ''}`;
  }

  return `mmbridge review --tool ${session.tool} --project ${session.projectDir}${session.baseRef ? ` --base-ref ${session.baseRef}` : ''}`;
}

function makeMemoryEntry(input: {
  projectKey: string;
  sessionId?: string | null;
  handoffId?: string | null;
  type: MemoryEntryType;
  title: string;
  content: string;
  createdAt: string;
  file?: string | null;
  line?: number | null;
  severity?: string | null;
  branch?: string | null;
  metadata?: Record<string, unknown>;
}): MemoryEntry {
  return {
    id: randomUUID(),
    projectKey: input.projectKey,
    sessionId: input.sessionId ?? null,
    handoffId: input.handoffId ?? null,
    type: input.type,
    title: input.title,
    content: input.content,
    createdAt: input.createdAt,
    file: input.file ?? null,
    line: input.line ?? null,
    severity: input.severity ?? null,
    branch: input.branch ?? null,
    metadata: input.metadata ?? {},
  };
}

function deriveSessionMemoryEntries(session: Session, projectKey: string): MemoryEntry[] {
  const createdAt = session.createdAt ?? new Date().toISOString();
  const branch = session.head?.branch ?? null;
  const entries: MemoryEntry[] = [];

  if (session.summary) {
    entries.push(
      makeMemoryEntry({
        projectKey,
        sessionId: session.id,
        type: 'decision',
        title: `${session.tool} ${session.mode} summary`,
        content: session.summary,
        createdAt,
        branch,
        metadata: { tool: session.tool, mode: session.mode },
      }),
    );
  }

  if (session.command) {
    entries.push(
      makeMemoryEntry({
        projectKey,
        sessionId: session.id,
        type: 'command',
        title: `${session.tool} command`,
        content: [session.command, ...(session.args ?? [])].join(' '),
        createdAt,
        branch,
      }),
    );
  }

  for (const finding of session.findings ?? []) {
    entries.push(
      makeMemoryEntry({
        projectKey,
        sessionId: session.id,
        type: 'finding',
        title: `[${finding.severity}] ${finding.file}${finding.line != null ? `:${finding.line}` : ''}`,
        content: finding.message,
        createdAt,
        file: finding.file,
        line: finding.line,
        severity: finding.severity,
        branch,
      }),
    );
  }

  for (const file of session.resultIndex?.topFiles ?? []) {
    entries.push(
      makeMemoryEntry({
        projectKey,
        sessionId: session.id,
        type: 'file_hotspot',
        title: `${file.file} hotspot`,
        content: `${file.count} findings in ${file.file}`,
        createdAt,
        file: file.file,
        branch,
      }),
    );
  }

  if (session.mode === 'followup' && session.summary) {
    entries.push(
      makeMemoryEntry({
        projectKey,
        sessionId: session.id,
        type: 'followup_goal',
        title: `${session.tool} followup goal`,
        content: session.summary.split('\n').slice(0, 4).join(' ').trim(),
        createdAt,
        branch,
      }),
    );
  }

  if (session.interpretation?.actionPlan) {
    for (const rawLine of session.interpretation.actionPlan.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      entries.push(
        makeMemoryEntry({
          projectKey,
          sessionId: session.id,
          type: /block|follow-?up|todo|risk/i.test(line) ? 'blocker' : 'fix',
          title: `${session.tool} action plan`,
          content: line,
          createdAt,
          branch,
        }),
      );
    }
  }

  return entries;
}

function summarizeRecallEntries(entries: RecallEntrySummary[], blockers: RecallEntrySummary[]): string {
  if (entries.length === 0 && blockers.length === 0) {
    return 'No prior memory found for this project.';
  }

  const parts: string[] = [];
  if (entries.length > 0) parts.push(`${entries.length} memory hit(s)`);
  if (blockers.length > 0) parts.push(`${blockers.length} active blocker(s)`);
  return parts.join(' · ');
}

function toRecallSummary(entry: MemoryEntry): RecallEntrySummary {
  return {
    id: entry.id,
    type: entry.type,
    title: entry.title,
    file: entry.file ?? null,
    severity: entry.severity ?? null,
  };
}

function rowToMemoryEntry(row: Record<string, unknown>): MemoryEntry {
  return {
    id: String(row.id),
    projectKey: String(row.project_key),
    sessionId: row.session_id ? String(row.session_id) : null,
    handoffId: row.handoff_id ? String(row.handoff_id) : null,
    type: row.type as MemoryEntryType,
    title: String(row.title),
    content: String(row.content),
    file: row.file ? String(row.file) : null,
    line: typeof row.line === 'number' ? row.line : null,
    severity: row.severity ? String(row.severity) : null,
    branch: row.branch ? String(row.branch) : null,
    createdAt: String(row.created_at),
    metadata: safeJsonParse<Record<string, unknown>>(String(row.metadata_json ?? '{}'), {}),
  };
}

function normalizeHandoffDocument(document: HandoffDocument): HandoffDocument {
  return {
    ...document,
    recalledMemoryIds: document.recalledMemoryIds ?? [],
    recalledMemorySummary: document.recalledMemorySummary ?? null,
    recalledMemory: document.recalledMemory ?? [],
  };
}

export class ProjectMemoryStore {
  private readonly baseDir: string;
  private readonly sessionStore: SessionStore;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? new SessionStore().baseDir;
    this.sessionStore = new SessionStore(this.baseDir);
  }

  projectKey(projectDir: string): string {
    return toProjectKey(projectDir);
  }

  projectRoot(projectDir: string): string {
    return path.join(this.baseDir, 'projects', this.projectKey(projectDir));
  }

  handoffsDir(projectDir: string): string {
    return path.join(this.projectRoot(projectDir), 'handoffs');
  }

  dbPath(projectDir: string): string {
    return path.join(this.projectRoot(projectDir), 'memory.sqlite');
  }

  async ensureProject(projectDir: string): Promise<void> {
    await fs.mkdir(this.handoffsDir(projectDir), { recursive: true });
  }

  private withDb<T>(projectDir: string, fn: (db: DatabaseSync, projectKey: string) => T): T {
    const projectKey = this.projectKey(projectDir);
    const db = new DatabaseSync(this.dbPath(projectDir));
    try {
      db.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS handoffs (
          id TEXT PRIMARY KEY,
          project_key TEXT NOT NULL,
          session_id TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          markdown_path TEXT NOT NULL,
          json_path TEXT NOT NULL,
          summary TEXT NOT NULL,
          objective TEXT NOT NULL,
          next_prompt TEXT NOT NULL,
          next_command TEXT NOT NULL,
          open_blockers_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS memory_entries (
          id TEXT PRIMARY KEY,
          project_key TEXT NOT NULL,
          session_id TEXT,
          handoff_id TEXT,
          type TEXT NOT NULL,
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          file TEXT,
          line INTEGER,
          severity TEXT,
          branch TEXT,
          created_at TEXT NOT NULL,
          metadata_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS indexed_sessions (
          session_id TEXT PRIMARY KEY,
          indexed_at TEXT NOT NULL
        );
      `);
      try {
        db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS memory_entries_fts USING fts5(
            id UNINDEXED,
            title,
            content,
            tokenize = 'unicode61 remove_diacritics 2'
          );
        `);
      } catch (error) {
        if (!isMissingFtsModule(error)) throw error;
      }

      return fn(db, projectKey);
    } finally {
      db.close();
    }
  }

  async backfillProject(projectDir: string): Promise<void> {
    await this.ensureProject(projectDir);
    const sessions = await this.sessionStore.list({ projectDir });

    this.withDb(projectDir, (db, projectKey) => {
      const supportsFts = Boolean(
        db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'memory_entries_fts' LIMIT 1").get() as
          | Record<string, unknown>
          | undefined,
      );
      const indexedStmt = db.prepare('SELECT 1 FROM indexed_sessions WHERE session_id = ?');
      const insertIndexed = db.prepare(
        'INSERT OR REPLACE INTO indexed_sessions (session_id, indexed_at) VALUES (?, ?)',
      );
      const insertEntry = db.prepare(`
        INSERT OR REPLACE INTO memory_entries (
          id, project_key, session_id, handoff_id, type, title, content, file, line, severity, branch, created_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const deleteSessionEntries = db.prepare('DELETE FROM memory_entries WHERE session_id = ?');
      const deleteFts = supportsFts ? db.prepare('DELETE FROM memory_entries_fts WHERE id = ?') : null;
      const insertFts = supportsFts
        ? db.prepare('INSERT INTO memory_entries_fts (id, title, content) VALUES (?, ?, ?)')
        : null;

      for (const session of sessions) {
        const isIndexed = indexedStmt.get(session.id);
        if (isIndexed) continue;

        deleteSessionEntries.run(session.id);
        const entries = deriveSessionMemoryEntries(session, projectKey);
        for (const entry of entries) {
          insertEntry.run(
            entry.id,
            entry.projectKey,
            entry.sessionId ?? null,
            entry.handoffId ?? null,
            entry.type,
            entry.title,
            entry.content,
            entry.file ?? null,
            entry.line ?? null,
            entry.severity ?? null,
            entry.branch ?? null,
            entry.createdAt,
            JSON.stringify(entry.metadata ?? {}),
          );
          deleteFts?.run(entry.id);
          insertFts?.run(entry.id, entry.title, entry.content);
        }
        insertIndexed.run(session.id, new Date().toISOString());
      }
    });
  }

  async createOrUpdateHandoff(
    projectDir: string,
    sessionId: string,
    recalledMemoryIds: string[] = [],
  ): Promise<HandoffDocument> {
    await this.ensureProject(projectDir);
    await this.backfillProject(projectDir);

    const session = await this.sessionStore.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const projectKey = this.projectKey(projectDir);
    const blockers = collectOpenBlockers(session);
    const nextPrompt = deriveNextPrompt(session, blockers);
    const nextCommand = deriveNextCommand(session, nextPrompt);
    const recalledMemory = recalledMemoryIds.length > 0 ? await this.showMemory(projectDir, recalledMemoryIds) : [];
    const artifact: HandoffArtifact = {
      id: session.handoffId ?? randomUUID(),
      sessionId: session.id,
      projectKey,
      createdAt: new Date().toISOString(),
      markdownPath: path.join(this.handoffsDir(projectDir), `${session.id}.md`),
      jsonPath: path.join(this.handoffsDir(projectDir), `${session.id}.json`),
      summary: session.handoffSummary ?? session.summary ?? `${(session.findings ?? []).length} findings`,
      objective: `${session.mode} ${session.tool} handoff`,
      nextPrompt,
      nextCommand,
      openBlockers: blockers,
    };

    const document: HandoffDocument = {
      artifact,
      tool: session.tool,
      mode: session.mode,
      status: session.status,
      projectDir: session.projectDir,
      baseRef: session.baseRef,
      head: session.head,
      summary: session.summary ?? `${(session.findings ?? []).length} findings`,
      findings: session.findings ?? [],
      contextDigest: contextDigestFromSession(session),
      contextSummary: summarizeContext(session.contextIndex),
      bridgeSummary: session.resultIndex?.bridgeSummary ?? null,
      interpretationSummary: summarizeInterpretation(session),
      recalledMemoryIds,
      recalledMemory,
      recalledMemorySummary:
        recalledMemoryIds.length > 0 ? `${recalledMemoryIds.length} recalled memory entry(ies)` : null,
      recommendedNextPrompt: nextPrompt,
      recommendedNextCommand: nextCommand,
    };

    const markdownLines = [
      '# MMBridge Handoff',
      '',
      `- Session: ${document.artifact.sessionId}`,
      `- Created: ${document.artifact.createdAt}`,
      `- Tool: ${document.tool}`,
      `- Mode: ${document.mode}`,
      `- Status: ${document.status ?? 'complete'}`,
      `- Project: ${document.projectDir}`,
      ...(document.baseRef ? [`- Base ref: ${document.baseRef}`] : []),
      ...(document.head ? [`- Head: ${document.head.branch} (${document.head.sha})`] : []),
      '',
      '## Objective',
      '',
      document.artifact.objective,
      '',
      '## Recall',
      '',
      document.recalledMemorySummary ?? 'No recalled memory was attached to this session.',
      '',
      ...(document.recalledMemory.length > 0
        ? [
            '### Recalled Entries',
            '',
            ...document.recalledMemory.flatMap((entry) => {
              const meta = [
                entry.type,
                entry.severity ?? null,
                entry.file ? `${entry.file}${entry.line != null ? `:${entry.line}` : ''}` : null,
                entry.createdAt,
              ]
                .filter((part): part is string => Boolean(part))
                .join(' · ');
              return [`- ${entry.title}`, ...(meta ? [`  ${meta}`] : []), `  ${entry.content}`];
            }),
            '',
          ]
        : []),
      '## Context',
      '',
      document.contextSummary ?? document.contextDigest ?? 'No context summary available.',
      '',
      '## Summary',
      '',
      document.summary,
      '',
      ...(document.bridgeSummary ? ['## Bridge', '', document.bridgeSummary, ''] : []),
      ...(document.interpretationSummary ? ['## Interpretation', '', document.interpretationSummary, ''] : []),
      '## Findings',
      '',
      ...(document.findings.length > 0
        ? document.findings.map((finding) => {
            const location = finding.line != null ? `${finding.file}:${finding.line}` : finding.file;
            return `- [${finding.severity}] ${location} - ${finding.message}`;
          })
        : ['- No findings']),
      '',
      '## Open Blockers',
      '',
      ...(artifact.openBlockers.length > 0 ? artifact.openBlockers.map((line) => `- ${line}`) : ['- None']),
      '',
      '## Next Prompt',
      '',
      '```text',
      document.recommendedNextPrompt,
      '```',
      '',
      '## Next Command',
      '',
      '```bash',
      document.recommendedNextCommand,
      '```',
      '',
    ];

    await fs.writeFile(artifact.markdownPath, markdownLines.join('\n'), 'utf8');
    await fs.writeFile(artifact.jsonPath, JSON.stringify(document, null, 2), 'utf8');

    this.withDb(projectDir, (db, currentProjectKey) => {
      const insertHandoff = db.prepare(`
        INSERT OR REPLACE INTO handoffs (
          id, project_key, session_id, created_at, markdown_path, json_path, summary, objective, next_prompt, next_command, open_blockers_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insertHandoff.run(
        artifact.id,
        currentProjectKey,
        artifact.sessionId,
        artifact.createdAt,
        artifact.markdownPath,
        artifact.jsonPath,
        artifact.summary,
        artifact.objective,
        artifact.nextPrompt,
        artifact.nextCommand,
        JSON.stringify(artifact.openBlockers),
      );
    });

    await this.sessionStore.save({
      ...session,
      handoffId: artifact.id,
      handoffPath: artifact.markdownPath,
      handoffSummary: artifact.summary,
      recalledMemoryIds,
      contextDigest: document.contextDigest ?? null,
    });

    const handoffEntries = [
      makeMemoryEntry({
        projectKey,
        sessionId: session.id,
        handoffId: artifact.id,
        type: 'decision',
        title: `${session.tool} handoff summary`,
        content: artifact.summary,
        createdAt: artifact.createdAt,
        branch: session.head?.branch ?? null,
      }),
      makeMemoryEntry({
        projectKey,
        sessionId: session.id,
        handoffId: artifact.id,
        type: 'followup_goal',
        title: `${session.tool} next prompt`,
        content: artifact.nextPrompt,
        createdAt: artifact.createdAt,
        branch: session.head?.branch ?? null,
      }),
      makeMemoryEntry({
        projectKey,
        sessionId: session.id,
        handoffId: artifact.id,
        type: 'command',
        title: `${session.tool} next command`,
        content: artifact.nextCommand,
        createdAt: artifact.createdAt,
        branch: session.head?.branch ?? null,
      }),
      ...artifact.openBlockers.map((blocker) =>
        makeMemoryEntry({
          projectKey,
          sessionId: session.id,
          handoffId: artifact.id,
          type: 'blocker',
          title: `${session.tool} blocker`,
          content: blocker,
          createdAt: artifact.createdAt,
          branch: session.head?.branch ?? null,
        }),
      ),
    ];

    this.withDb(projectDir, (db) => {
      const supportsFts = Boolean(
        db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'memory_entries_fts' LIMIT 1").get() as
          | Record<string, unknown>
          | undefined,
      );
      const insertEntry = db.prepare(`
        INSERT OR REPLACE INTO memory_entries (
          id, project_key, session_id, handoff_id, type, title, content, file, line, severity, branch, created_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const deleteFts = supportsFts ? db.prepare('DELETE FROM memory_entries_fts WHERE id = ?') : null;
      const insertFts = supportsFts
        ? db.prepare('INSERT INTO memory_entries_fts (id, title, content) VALUES (?, ?, ?)')
        : null;
      for (const entry of handoffEntries) {
        insertEntry.run(
          entry.id,
          entry.projectKey,
          entry.sessionId ?? null,
          entry.handoffId ?? null,
          entry.type,
          entry.title,
          entry.content,
          entry.file ?? null,
          entry.line ?? null,
          entry.severity ?? null,
          entry.branch ?? null,
          entry.createdAt,
          JSON.stringify(entry.metadata ?? {}),
        );
        deleteFts?.run(entry.id);
        insertFts?.run(entry.id, entry.title, entry.content);
      }
    });

    return document;
  }

  async getLatestHandoff(projectDir: string): Promise<HandoffArtifact | null> {
    await this.ensureProject(projectDir);
    return this.withDb(projectDir, (db, projectKey) => {
      const row = db
        .prepare(`
          SELECT id, session_id, project_key, created_at, markdown_path, json_path, summary, objective, next_prompt, next_command, open_blockers_json
          FROM handoffs
          WHERE project_key = ?
          ORDER BY created_at DESC
          LIMIT 1
        `)
        .get(projectKey) as Record<string, unknown> | undefined;

      if (!row) return null;
      return {
        id: String(row.id),
        sessionId: String(row.session_id),
        projectKey: String(row.project_key),
        createdAt: String(row.created_at),
        markdownPath: String(row.markdown_path),
        jsonPath: String(row.json_path),
        summary: String(row.summary),
        objective: String(row.objective),
        nextPrompt: String(row.next_prompt),
        nextCommand: String(row.next_command),
        openBlockers: safeJsonParse<string[]>(String(row.open_blockers_json ?? '[]'), []),
      } satisfies HandoffArtifact;
    });
  }

  async getHandoffBySession(projectDir: string, sessionId: string): Promise<HandoffDocument | null> {
    await this.ensureProject(projectDir);
    const latest = await this.getLatestHandoff(projectDir);
    if (latest && latest.sessionId === sessionId) {
      const raw = await fs.readFile(latest.jsonPath, 'utf8').catch(() => null);
      return raw ? normalizeHandoffDocument(JSON.parse(raw) as HandoffDocument) : null;
    }

    const handoff = this.withDb(projectDir, (db, projectKey) => {
      const row = db
        .prepare(`
          SELECT json_path
          FROM handoffs
          WHERE project_key = ? AND session_id = ?
          LIMIT 1
        `)
        .get(projectKey, sessionId) as { json_path?: string } | undefined;
      return row?.json_path ?? null;
    });

    if (!handoff) return null;
    const raw = await fs.readFile(handoff, 'utf8').catch(() => null);
    return raw ? normalizeHandoffDocument(JSON.parse(raw) as HandoffDocument) : null;
  }

  async searchMemory(options: MemorySearchOptions): Promise<MemoryEntry[]> {
    await this.backfillProject(options.projectDir);
    const limit = options.limit ?? 8;
    const type = options.type ?? null;

    return this.withDb(options.projectDir, (db, projectKey) => {
      const query = toFtsQuery(options.query.trim());
      const terms = toSearchTerms(options.query.trim());
      const supportsFts = Boolean(
        db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'memory_entries_fts' LIMIT 1").get() as
          | Record<string, unknown>
          | undefined,
      );
      const rows =
        query && supportsFts
          ? (db
              .prepare(`
              SELECT e.*
              FROM memory_entries_fts f
              JOIN memory_entries e ON e.id = f.id
              WHERE e.project_key = ?
                AND memory_entries_fts MATCH ?
                AND (? IS NULL OR e.type = ?)
              ORDER BY e.created_at DESC
              LIMIT ?
            `)
              .all(projectKey, query, type, type, limit) as Array<Record<string, unknown>>)
          : terms.length > 0
            ? (() => {
                const clauses = terms.map(() => '(title LIKE ? OR content LIKE ?)').join(' AND ');
                const params = terms.flatMap((term) => {
                  const value = `%${term}%`;
                  return [value, value];
                });

                return db
                  .prepare(`
                  SELECT *
                  FROM memory_entries
                  WHERE project_key = ?
                    AND (? IS NULL OR type = ?)
                    AND ${clauses}
                  ORDER BY created_at DESC
                  LIMIT ?
                `)
                  .all(projectKey, type, type, ...params, limit) as Array<Record<string, unknown>>;
              })()
            : (db
                .prepare(`
              SELECT *
              FROM memory_entries
              WHERE project_key = ?
                AND (? IS NULL OR type = ?)
              ORDER BY created_at DESC
              LIMIT ?
            `)
                .all(projectKey, type, type, limit) as Array<Record<string, unknown>>);

      return rows.map(rowToMemoryEntry);
    });
  }

  private async resolveFamilySessionIds(projectDir: string, sessionIds: string[]): Promise<string[]> {
    const normalized = Array.from(new Set(sessionIds.filter(Boolean)));
    if (normalized.length === 0) return [];

    const families = await Promise.all(
      normalized.map((sessionId) => this.sessionStore.getFamily(projectDir, sessionId)),
    );
    return Array.from(new Set(families.flat().map((session) => session.id)));
  }

  async timelineMemory(options: MemoryTimelineOptions): Promise<MemoryEntry[]> {
    await this.backfillProject(options.projectDir);
    const limit = options.limit ?? 12;
    if (options.sessionId) {
      const familySessionIds = await this.resolveFamilySessionIds(options.projectDir, [options.sessionId]);
      if (familySessionIds.length === 0) return [];

      return this.withDb(options.projectDir, (db, projectKey) => {
        const placeholders = familySessionIds.map(() => '?').join(', ');
        const rows = db
          .prepare(`
            SELECT *
            FROM memory_entries
            WHERE project_key = ?
              AND session_id IN (${placeholders})
            ORDER BY created_at DESC
            LIMIT ?
          `)
          .all(projectKey, ...familySessionIds, limit * 3) as Array<Record<string, unknown>>;
        return rows.map(rowToMemoryEntry);
      }).slice(0, limit);
    }

    if (!options.query?.trim()) {
      return this.searchMemory({
        projectDir: options.projectDir,
        query: '',
        limit,
      });
    }

    const hits = await this.searchMemory({
      projectDir: options.projectDir,
      query: options.query,
      limit: Math.min(limit, 6),
    });
    const directSessionIds = Array.from(
      new Set(hits.map((entry) => entry.sessionId).filter((id): id is string => Boolean(id))),
    );
    const sessionIds = await this.resolveFamilySessionIds(options.projectDir, directSessionIds);
    if (sessionIds.length === 0) {
      return hits;
    }

    return this.withDb(options.projectDir, (db, projectKey) => {
      const placeholders = sessionIds.map(() => '?').join(', ');
      const rows = db
        .prepare(`
          SELECT *
          FROM memory_entries
          WHERE project_key = ?
            AND session_id IN (${placeholders})
          ORDER BY created_at DESC
          LIMIT ?
        `)
        .all(projectKey, ...sessionIds, limit * 3) as Array<Record<string, unknown>>;

      const contextual = rows.map(rowToMemoryEntry);
      const merged = [...hits, ...contextual];
      return Array.from(new Map(merged.map((entry) => [entry.id, entry])).values())
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, limit);
    });
  }

  async showMemory(projectDir: string, ids: string[]): Promise<MemoryEntry[]> {
    await this.backfillProject(projectDir);
    if (ids.length === 0) return [];
    return this.withDb(projectDir, (db, projectKey) => {
      const placeholders = ids.map(() => '?').join(', ');
      const rows = db
        .prepare(`
          SELECT *
          FROM memory_entries
          WHERE project_key = ?
            AND id IN (${placeholders})
        `)
        .all(projectKey, ...ids) as Array<Record<string, unknown>>;

      return rows.map(rowToMemoryEntry);
    });
  }

  async buildRecall(
    projectDir: string,
    options: { changedFiles?: string[]; mode?: string; tool?: string; queryText?: string; sessionId?: string },
  ): Promise<RecallResult> {
    await this.backfillProject(projectDir);
    const pinnedSessionId = options.sessionId?.trim() || null;
    const latestProjectHandoff = pinnedSessionId ? null : await this.getLatestHandoff(projectDir);
    const latestHandoffDocument = pinnedSessionId
      ? await this.getHandoffBySession(projectDir, pinnedSessionId)
      : latestProjectHandoff
        ? await this.getHandoffBySession(projectDir, latestProjectHandoff.sessionId)
        : null;
    const latestHandoff = latestHandoffDocument?.artifact ?? null;
    const scopedEntries = pinnedSessionId
      ? await this.timelineMemory({ projectDir, sessionId: pinnedSessionId, limit: 16 })
      : [];

    const fileQueries = pinnedSessionId ? [] : (options.changedFiles?.slice(0, 5) ?? []);
    const fileEntries = fileQueries.length
      ? await Promise.all(
          fileQueries.map((file) =>
            this.searchMemory({
              projectDir,
              query: file,
              type: 'finding',
              limit: 2,
            }),
          ),
        )
      : [];

    const blockerEntries = pinnedSessionId
      ? scopedEntries.filter((entry) => entry.type === 'blocker').slice(0, 4)
      : await this.searchMemory({
          projectDir,
          query: '',
          type: 'blocker',
          limit: 4,
        });

    const recentDecisions = pinnedSessionId
      ? scopedEntries.filter((entry) => entry.type === 'decision').slice(0, 4)
      : await this.searchMemory({
          projectDir,
          query: '',
          type: 'decision',
          limit: 4,
        });
    const queryHits =
      !pinnedSessionId && options.queryText?.trim()
        ? await this.timelineMemory({
            projectDir,
            query: options.queryText,
            limit: 4,
          })
        : [];

    const merged = pinnedSessionId
      ? scopedEntries
      : [...recentDecisions, ...fileEntries.flat(), ...blockerEntries, ...queryHits];
    const deduped = Array.from(new Map(merged.map((entry) => [entry.id, entry])).values()).slice(0, 8);
    const memoryHits = deduped.map(toRecallSummary);
    const blockers = blockerEntries.slice(0, 4).map(toRecallSummary);
    const recalledMemoryIds = memoryHits.map((entry) => entry.id);
    const summary = summarizeRecallEntries(memoryHits, blockers);

    const promptSections = [
      latestHandoffDocument ? `Latest handoff: ${latestHandoffDocument.summary}` : null,
      memoryHits.length > 0
        ? `Relevant memory:\n${memoryHits.map((entry) => `- [${entry.type}] ${entry.title}`).join('\n')}`
        : null,
      blockers.length > 0 ? `Active blockers:\n${blockers.map((entry) => `- ${entry.title}`).join('\n')}` : null,
    ].filter((section): section is string => section != null);

    return {
      projectKey: this.projectKey(projectDir),
      latestHandoff,
      latestHandoffDocument,
      recalledMemoryIds,
      memoryHits,
      blockers,
      summary,
      promptContext: promptSections.join('\n\n'),
    };
  }
}
