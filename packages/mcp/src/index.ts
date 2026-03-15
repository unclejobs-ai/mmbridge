#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerPromptHandlers } from './prompts.js';
import { registerResourceHandlers } from './resources.js';
import { registerToolHandlers } from './tools.js';

const server = new Server(
  { name: 'mmbridge', version: '0.5.0' },
  { capabilities: { tools: {}, resources: {}, prompts: {} } },
);

registerToolHandlers(server);
registerResourceHandlers(server);
registerPromptHandlers(server);

const transport = new StdioServerTransport();
await server.connect(transport);
