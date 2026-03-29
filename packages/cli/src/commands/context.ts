import { exitWithError, importSessionStore, jsonOutput, resolveProjectDir } from './helpers.js';

export interface ContextTreeCommandOptions {
  project?: string;
  limit?: string;
  json?: boolean;
}

export interface ContextPacketCommandOptions {
  project?: string;
  task?: string;
  command?: string;
  budget?: string;
  json?: boolean;
}

const importContextBroker = () => import('@mmbridge/context-broker');

export async function runContextTreeCommand(options: ContextTreeCommandOptions): Promise<void> {
  const projectDir = resolveProjectDir(options.project);
  const limit = options.limit ? Number(options.limit) : 10;

  const { ContextTree, projectKeyFromDir } = await importContextBroker();
  const { SessionStore } = await importSessionStore();

  const sessionStore = new SessionStore();
  const tree = new ContextTree(sessionStore.baseDir);
  const projectKey = projectKeyFromDir(projectDir);

  const nodes = await tree.getRecent(projectKey, limit);

  if (options.json) {
    jsonOutput(nodes);
    return;
  }

  if (nodes.length === 0) {
    process.stdout.write('[mmbridge] No context tree nodes found for this project.\n');
    return;
  }

  const C = {
    RESET: '\x1b[0m',
    BOLD: '\x1b[1m',
    DIM: '\x1b[2m',
    ACCENT: '\x1b[38;2;180;190;254m',
    GREEN: '\x1b[38;2;166;227;161m',
    YELLOW: '\x1b[38;2;249;226;175m',
  } as const;

  process.stdout.write(
    `\n${C.BOLD}${C.ACCENT}Context Tree${C.RESET}  ${C.DIM}(${nodes.length} recent nodes)${C.RESET}\n\n`,
  );

  for (const node of nodes) {
    const date = new Date(node.timestamp).toISOString().replace('T', ' ').slice(0, 19);
    const parent = node.parentId ? `${C.DIM}← ${node.parentId.slice(0, 8)}${C.RESET}` : `${C.DIM}(root)${C.RESET}`;
    process.stdout.write(
      `  ${C.GREEN}●${C.RESET} ${C.BOLD}${node.type}${C.RESET}  ${C.DIM}${node.id.slice(0, 8)}${C.RESET}  ${parent}\n` +
        `    ${node.summary}\n` +
        `    ${C.DIM}${date}${C.RESET}\n\n`,
    );
  }
}

export async function runContextPacketCommand(options: ContextPacketCommandOptions): Promise<void> {
  const projectDir = resolveProjectDir(options.project);
  const task = options.task ?? 'preview context packet';
  const command = options.command ?? 'mmbridge context packet';
  const budget = options.budget ? Number(options.budget) : undefined;

  const { ContextTree, RecallEngine, ContextAssembler, projectKeyFromDir } = await importContextBroker();
  const { SessionStore, ProjectMemoryStore } = await importSessionStore();

  const sessionStore = new SessionStore();
  const memoryStore = new ProjectMemoryStore(sessionStore.baseDir);
  const tree = new ContextTree(sessionStore.baseDir);
  const recallEngine = new RecallEngine({
    sessionStore,
    memoryStore,
    contextTree: tree,
  });
  const assembler = new ContextAssembler({
    contextTree: tree,
    recallEngine,
    sessionStore,
    projectDir,
  });

  let packet;
  try {
    packet = await assembler.assemble({
      projectDir,
      task,
      command,
      recallBudget: budget,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    exitWithError(`Failed to assemble context packet: ${message}`);
  }

  if (options.json) {
    jsonOutput(packet);
    return;
  }

  const C = {
    RESET: '\x1b[0m',
    BOLD: '\x1b[1m',
    DIM: '\x1b[2m',
    ACCENT: '\x1b[38;2;180;190;254m',
    GREEN: '\x1b[38;2;166;227;161m',
    YELLOW: '\x1b[38;2;249;226;175m',
    BLUE: '\x1b[38;2;137;220;235m',
    RED: '\x1b[38;2;243;139;168m',
  } as const;

  const freshnessColor =
    packet.freshness === 'fresh' ? C.GREEN : packet.freshness === 'stale' ? C.YELLOW : C.RED;

  process.stdout.write(
    `\n${C.BOLD}${C.ACCENT}Context Packet${C.RESET}  ${C.DIM}task: ${task}${C.RESET}\n\n`,
  );

  process.stdout.write(`  ${C.BOLD}Project${C.RESET}     ${packet.project}\n`);
  process.stdout.write(`  ${C.BOLD}Branch${C.RESET}      ${packet.projectState.branch}\n`);
  process.stdout.write(`  ${C.BOLD}Freshness${C.RESET}   ${freshnessColor}${packet.freshness}${C.RESET}\n`);
  process.stdout.write(`  ${C.BOLD}Tree Leaf${C.RESET}   ${C.DIM}${packet.treeLeafId.slice(0, 12)}${C.RESET}\n`);
  process.stdout.write(
    `  ${C.BOLD}Tokens${C.RESET}      ${packet.totalRecallTokens} / ${packet.recallBudget} budget\n`,
  );
  process.stdout.write('\n');

  if (packet.projectState.fileHotspots.length > 0) {
    process.stdout.write(`  ${C.BLUE}${C.BOLD}File Hotspots${C.RESET} ${C.DIM}(${packet.projectState.fileHotspots.length})${C.RESET}\n`);
    for (const file of packet.projectState.fileHotspots.slice(0, 10)) {
      process.stdout.write(`    ${C.DIM}${file}${C.RESET}\n`);
    }
    if (packet.projectState.fileHotspots.length > 10) {
      process.stdout.write(`    ${C.DIM}... +${packet.projectState.fileHotspots.length - 10} more${C.RESET}\n`);
    }
    process.stdout.write('\n');
  }

  const recallSections: [string, typeof packet.recalledSessions][] = [
    ['Sessions', packet.recalledSessions],
    ['Handoffs', packet.recalledHandoffs],
    ['Memory', packet.recalledMemory],
  ];

  for (const [label, entries] of recallSections) {
    if (entries.length === 0) continue;
    process.stdout.write(`  ${C.GREEN}${C.BOLD}Recalled ${label}${C.RESET} ${C.DIM}(${entries.length})${C.RESET}\n`);
    for (const entry of entries) {
      process.stdout.write(
        `    ${C.GREEN}●${C.RESET} ${entry.summary.slice(0, 80)}${entry.summary.length > 80 ? '…' : ''}\n` +
          `      ${C.DIM}relevance: ${entry.relevance.toFixed(2)} · ${entry.tokenCount} tokens${C.RESET}\n`,
      );
    }
    process.stdout.write('\n');
  }

  if (packet.gateWarnings.length > 0) {
    process.stdout.write(`  ${C.YELLOW}${C.BOLD}Gate Warnings${C.RESET}\n`);
    for (const warning of packet.gateWarnings) {
      process.stdout.write(`    ${C.YELLOW}▲${C.RESET} ${warning}\n`);
    }
    process.stdout.write('\n');
  }

  process.stdout.write(`  ${C.BOLD}Suggested${C.RESET}   ${packet.suggestedCommand}\n`);
  process.stdout.write(`  ${C.BOLD}Adapters${C.RESET}    ${packet.suggestedAdapters.join(', ')}\n\n`);
}
