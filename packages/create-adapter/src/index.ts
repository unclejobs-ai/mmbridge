#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const TEMPLATE = `import type { AdapterDefinition, ReviewOptions, FollowupOptions, AdapterResult } from '@mmbridge/adapters';

export const adapter: AdapterDefinition = {
  name: '{{name}}',
  binary: '{{name}}',

  async review(options: ReviewOptions): Promise<AdapterResult> {
    throw new Error('Not implemented: review for {{name}}');
  },

  async followup(options: FollowupOptions): Promise<AdapterResult> {
    throw new Error('Not implemented: followup for {{name}}');
  },
};

export default adapter;
`;

const PACKAGE_JSON_TEMPLATE = `{
  "name": "mmbridge-adapter-{{name}}",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": ["dist"],
  "scripts": {
    "build": "tsc",
    "test": "node --test test/*.test.ts"
  },
  "peerDependencies": {
    "@mmbridge/adapters": ">=0.1.0"
  },
  "devDependencies": {
    "@mmbridge/adapters": "^0.1.0",
    "typescript": "^5.7.0"
  }
}
`;

const TSCONFIG_TEMPLATE = `{
  "compilerOptions": {
    "strict": true,
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src",
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
`;

async function main(): Promise<void> {
  const name = process.argv[2];
  if (!name) {
    console.error('Usage: create-mmbridge-adapter <adapter-name>');
    console.error('Example: create-mmbridge-adapter deepseek');
    process.exit(1);
  }

  const dir = `mmbridge-adapter-${name}`;
  const srcDir = path.join(dir, 'src');
  const testDir = path.join(dir, 'test');

  await fs.mkdir(srcDir, { recursive: true });
  await fs.mkdir(testDir, { recursive: true });

  const render = (template: string): string => template.replace(/\{\{name\}\}/g, name);

  await Promise.all([
    fs.writeFile(path.join(srcDir, 'index.ts'), render(TEMPLATE)),
    fs.writeFile(path.join(dir, 'package.json'), render(PACKAGE_JSON_TEMPLATE)),
    fs.writeFile(path.join(dir, 'tsconfig.json'), TSCONFIG_TEMPLATE),
    fs.writeFile(
      path.join(testDir, 'adapter.test.ts'),
      `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { adapter } from '../src/index.js';\n\ntest('adapter has correct name', () => {\n  assert.equal(adapter.name, '${name}');\n});\n`,
    ),
  ]);

  console.log(`Created ${dir}/`);
  console.log(`  src/index.ts      - adapter implementation`);
  console.log(`  test/adapter.test.ts - basic test`);
  console.log(`  package.json      - npm package config`);
  console.log(`  tsconfig.json     - TypeScript config`);
  console.log('');
  console.log(`Next: cd ${dir} && npm install && npm run build`);
}

main().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
