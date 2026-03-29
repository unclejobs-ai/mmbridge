import { defaultRegistry } from '@mmbridge/adapters';
import { ContextTree, projectKeyFromDir } from '@mmbridge/context-broker';
import { SessionStore } from '@mmbridge/session-store';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListResourcesRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const store = new SessionStore();
const contextTree = new ContextTree();

export function registerResourceHandlers(server: Server): void {
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: 'sessions://list',
        name: 'Recent review sessions',
        description: 'List of recent mmbridge review sessions with metadata',
        mimeType: 'application/json',
      },
      {
        uri: 'adapters://status',
        name: 'Adapter installation status',
        description: 'Shows which AI review tools are installed and available',
        mimeType: 'application/json',
      },
      {
        uri: 'context-tree://recent',
        name: 'Recent context tree nodes',
        description: 'Returns recent context-tree nodes for the current project',
        mimeType: 'application/json',
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;

    if (uri === 'sessions://list') {
      const sessions = await store.list();
      const result = sessions.slice(0, 20).map((s) => ({
        id: s.id,
        tool: s.tool,
        mode: s.mode,
        createdAt: s.createdAt,
        findingCount: (s.findings ?? []).length,
        summary: s.summary?.slice(0, 100),
      }));
      return {
        contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(result, null, 2) }],
      };
    }

    if (uri.startsWith('sessions://') && uri !== 'sessions://list') {
      const sessionId = uri.replace('sessions://', '');
      const session = await store.get(sessionId);
      if (!session) {
        return {
          contents: [
            {
              uri,
              mimeType: 'application/json',
              text: JSON.stringify({ error: 'Session not found' }),
            },
          ],
        };
      }
      return {
        contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(session, null, 2) }],
      };
    }

    if (uri === 'adapters://status') {
      const names = defaultRegistry.list();
      const installed = await defaultRegistry.listInstalled();
      const result = names.map((name) => ({
        name,
        installed: installed.includes(name),
        binary: defaultRegistry.get(name)?.binary ?? name,
      }));
      return {
        contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(result, null, 2) }],
      };
    }

    if (uri === 'context-tree://recent') {
      const projectDir = process.cwd();
      const projectKey = projectKeyFromDir(projectDir);
      const nodes = await contextTree.getRecent(projectKey, 20);
      const result = nodes.map((n) => ({
        id: n.id,
        parentId: n.parentId,
        type: n.type,
        summary: n.summary,
        timestamp: n.timestamp,
        projectKey: n.projectKey,
      }));
      return {
        contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(result, null, 2) }],
      };
    }

    return {
      contents: [{ uri, mimeType: 'text/plain', text: `Unknown resource: ${uri}` }],
    };
  });
}
