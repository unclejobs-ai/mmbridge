#!/usr/bin/env node
import { main } from '../index.js';

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[mmbridge] ${message}`);
  process.exit(1);
});
