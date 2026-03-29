import {
  getHead,
  getDiff,
  getChangedFiles,
  getDefaultBaseRef,
  shortDigest,
} from '@mmbridge/core';
import type { SessionStore } from '@mmbridge/session-store';
import type { Session } from '@mmbridge/session-store';
import { ContextTree, projectKeyFromDir } from './context-tree.js';
import { RecallEngine } from './recall-engine.js';
import type {
  AssembleOptions,
  ContextPacket,
  RecallEntry,
} from './types.js';
import { BrokerEventBus } from './events.js';

interface ContextAssemblerDeps {
  contextTree: ContextTree;
  recallEngine: RecallEngine;
  sessionStore?: SessionStore;
  projectDir?: string;
  eventBus?: BrokerEventBus;
}

interface ProjectState {
  branch: string;
  recentDiff: string;
  fileHotspots: string[];
}

interface GateSignals {
  gateWarnings: string[];
  freshness: 'fresh' | 'stale' | 'expired';
}

const DIFF_TRUNCATE = 2000;

export class ContextAssembler {
  private readonly contextTree: ContextTree;
  private readonly recallEngine: RecallEngine;
  private readonly sessionStore: SessionStore | undefined;
  private readonly defaultProjectDir: string | undefined;
  private readonly eventBus: BrokerEventBus | undefined;

  constructor(deps: ContextAssemblerDeps) {
    this.contextTree = deps.contextTree;
    this.recallEngine = deps.recallEngine;
    this.sessionStore = deps.sessionStore;
    this.defaultProjectDir = deps.projectDir;
    this.eventBus = deps.eventBus;
  }

  async assemble(options: AssembleOptions): Promise<ContextPacket> {
    const projectDir = options.projectDir || this.defaultProjectDir || '.';
    const { task, command, parentNodeId, recallBudget } = options;

    // Emit before_context event (best-effort)
    if (this.eventBus) {
      try {
        await this.eventBus.emit('before_context', { task, command, projectDir });
      } catch {
        // best-effort — don't fail assembly
      }
    }

    // 1. Build project state
    const projectState = await this.getProjectState(projectDir);

    // 2. Get gate signals
    const { gateWarnings, freshness } = await this.getGateSignals(projectDir);

    // 3. Create tree node for this task
    const projectKey = projectKeyFromDir(projectDir);
    let treeLeafId: string;
    try {
      const node = await this.contextTree.append({
        parentId: parentNodeId ?? null,
        type: 'task',
        summary: task.slice(0, 200),
        data: { command, branch: projectState.branch },
        projectKey,
      });
      treeLeafId = node.id;
    } catch {
      // If tree write fails, use a placeholder
      treeLeafId = 'unknown';
    }

    // 4. Run recall engine
    const recall = await this.recallEngine.recall({
      projectDir,
      task,
      command,
      treeLeafId: parentNodeId ?? treeLeafId,
      budget: recallBudget,
    });

    // Emit on_recall event (best-effort)
    if (this.eventBus) {
      try {
        const entryCount =
          recall.recalledSessions.length +
          recall.recalledHandoffs.length +
          recall.recalledMemory.length;
        await this.eventBus.emit('on_recall', {
          budget: recallBudget ?? 2000,
          totalTokens: recall.totalRecallTokens,
          entryCount,
        });
      } catch {
        // best-effort — don't fail assembly
      }
    }

    // 5. Determine suggested command and adapters
    const suggestedCommand = this.suggestCommand(task, gateWarnings);
    const suggestedAdapters = this.suggestAdapters(command);

    // Emit after_context event (best-effort)
    if (this.eventBus) {
      try {
        await this.eventBus.emit('after_context', {
          treeLeafId,
          freshness,
          suggestedCommand,
        });
      } catch {
        // best-effort — don't fail assembly
      }
    }

    // 6. Return complete ContextPacket
    return {
      project: projectDir,
      task,
      treeLeafId,
      projectState,
      alwaysOnMemory: recall.alwaysOnMemory,
      recalledSessions: recall.recalledSessions,
      recalledHandoffs: recall.recalledHandoffs,
      recalledMemory: recall.recalledMemory,
      totalRecallTokens: recall.totalRecallTokens,
      recallBudget: recallBudget ?? 2000,
      gateWarnings,
      freshness,
      suggestedCommand,
      suggestedAdapters,
    };
  }

  private async getProjectState(
    projectDir: string,
  ): Promise<ProjectState> {
    let branch = 'unknown';
    let recentDiff = '';
    let fileHotspots: string[] = [];

    try {
      const head = await getHead(projectDir);
      branch = head.branch;
    } catch {
      // git unavailable or not a repo — keep defaults
    }

    // Single baseRef call shared between diff and changed files
    try {
      const baseRef = await getDefaultBaseRef(projectDir);
      const [diff, files] = await Promise.all([
        getDiff(baseRef, projectDir).catch(() => ''),
        getChangedFiles(baseRef, projectDir).catch(() => [] as string[]),
      ]);
      recentDiff = diff.slice(0, DIFF_TRUNCATE);
      fileHotspots = files.slice(0, 20);
    } catch {
      // git diff/files unavailable
    }

    // Augment hotspots from recent sessions if sessionStore is available
    if (this.sessionStore) {
      try {
        const recentSessions: Session[] = await this.sessionStore.list({
          projectDir,
          limit: 5,
        });
        const sessionFiles = new Set<string>();
        for (const session of recentSessions) {
          for (const finding of session.findings ?? []) {
            if (finding.file) sessionFiles.add(finding.file);
          }
          for (const topFile of session.resultIndex?.topFiles ?? []) {
            sessionFiles.add(topFile.file);
          }
        }
        // Merge with existing hotspots, keeping unique
        const merged = new Set([...fileHotspots, ...sessionFiles]);
        fileHotspots = Array.from(merged).slice(0, 30);
      } catch {
        // sessions unavailable
      }
    }

    return { branch, recentDiff, fileHotspots };
  }

  private async getGateSignals(
    projectDir: string,
  ): Promise<GateSignals> {
    const gateWarnings: string[] = [];
    let freshness: 'fresh' | 'stale' | 'expired' = 'expired';

    if (!this.sessionStore) {
      return { gateWarnings, freshness };
    }

    try {
      // Get current diff digest
      let currentDiffDigest: string | null = null;
      try {
        const baseRef = await getDefaultBaseRef(projectDir);
        const diff = await getDiff(baseRef, projectDir);
        currentDiffDigest = diff ? shortDigest(diff) : null;
      } catch {
        // can't compute diff digest
      }

      const sessions: Session[] = await this.sessionStore.list({
        projectDir,
        limit: 10,
      });

      if (sessions.length === 0) {
        gateWarnings.push('no_prior_sessions');
        return { gateWarnings, freshness };
      }

      const now = Date.now();
      const oneDay = 24 * 60 * 60 * 1000;
      const oneWeek = 7 * oneDay;

      // Check if any recent session covers the current diff
      let freshFound = false;
      let staleFound = false;

      for (const session of sessions) {
        const age = now - new Date(session.createdAt).getTime();
        const sameDigest =
          currentDiffDigest != null &&
          session.diffDigest != null &&
          session.diffDigest === currentDiffDigest;

        if (age <= oneDay && sameDigest) {
          freshFound = true;
          break;
        }
        if (age <= oneWeek && sameDigest) {
          staleFound = true;
        }
      }

      if (freshFound) {
        freshness = 'fresh';
      } else if (staleFound) {
        freshness = 'stale';
        gateWarnings.push('session_stale');
      } else {
        freshness = 'expired';
        gateWarnings.push('session_expired');
      }

      // Check for unresolved blockers
      const latestSession = sessions[0];
      if (latestSession) {
        const criticalFindings = (latestSession.findings ?? []).filter(
          (f: { severity?: string }) => f.severity === 'CRITICAL',
        );
        if (criticalFindings.length > 0) {
          gateWarnings.push(
            `unresolved_critical:${criticalFindings.length}`,
          );
        }
      }
    } catch {
      gateWarnings.push('gate_check_failed');
    }

    return { gateWarnings, freshness };
  }

  private suggestCommand(
    task: string,
    gateWarnings: string[],
  ): string {
    const taskLower = task.toLowerCase();

    // If gate warns about expired sessions, suggest a full review
    if (gateWarnings.includes('session_expired')) {
      return 'mmbridge review --tool all';
    }

    // Keyword-based heuristics
    if (/secur|vuln|cve|attack|cwe/i.test(taskLower)) {
      return 'mmbridge security';
    }
    if (/research|investigat|explor|analyz/i.test(taskLower)) {
      return 'mmbridge research';
    }
    if (/debate|discuss|compar|trade-?off/i.test(taskLower)) {
      return 'mmbridge debate';
    }
    if (/embrac|comprehensive|full.*review|deep/i.test(taskLower)) {
      return 'mmbridge embrace';
    }
    if (/follow-?up|continue|resume/i.test(taskLower)) {
      return 'mmbridge followup';
    }

    // Default to review
    return 'mmbridge review';
  }

  private suggestAdapters(command: string): string[] {
    const commandLower = command.toLowerCase();

    if (commandLower.includes('security')) {
      return ['claude', 'codex'];
    }
    if (commandLower.includes('research')) {
      return ['claude', 'gemini'];
    }
    if (commandLower.includes('debate')) {
      return ['claude', 'codex', 'gemini'];
    }
    if (commandLower.includes('embrace')) {
      return ['claude', 'codex', 'gemini'];
    }
    if (commandLower.includes('--tool all') || commandLower.includes('bridge')) {
      return ['claude', 'codex', 'gemini'];
    }
    if (commandLower.includes('--tool claude')) {
      return ['claude'];
    }
    if (commandLower.includes('--tool codex')) {
      return ['codex'];
    }
    if (commandLower.includes('--tool gemini')) {
      return ['gemini'];
    }

    // Default: suggest all adapters
    return ['claude', 'codex', 'gemini'];
  }
}
