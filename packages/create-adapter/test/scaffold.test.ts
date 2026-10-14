import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string): Promise<CliResult> {
  const { promise, resolve } = Promise.withResolvers<CliResult>();
  execFile(process.execPath, [cliPath, ...args], { cwd, encoding: 'utf8' }, (error, stdout, stderr) => {
    const code = error === null ? 0 : ((error.code as number | undefined) ?? -1);
    resolve({ code, stdout, stderr });
  });
  return promise;
}

async function makeTempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'mmbridge-create-adapter-'));
}

test('scaffold output contains the expected files with placeholders rendered', async () => {
  const cwd = await makeTempDir();
  const { code, stdout } = await runCli(['deepseek'], cwd);

  assert.equal(code, 0);
  assert.match(stdout, /Created mmbridge-adapter-deepseek\//);

  const adapterDir = path.join(cwd, 'mmbridge-adapter-deepseek');
  assert.deepEqual((await readdir(adapterDir)).sort(), ['package.json', 'src', 'test', 'tsconfig.json']);
  assert.deepEqual((await readdir(path.join(adapterDir, 'src'))).sort(), ['index.ts']);
  assert.deepEqual((await readdir(path.join(adapterDir, 'test'))).sort(), ['adapter.test.ts']);

  const pkgJson = JSON.parse(await readFile(path.join(adapterDir, 'package.json'), 'utf8')) as {
    name?: string;
    scripts?: Record<string, string>;
  };
  assert.equal(pkgJson.name, 'mmbridge-adapter-deepseek');
  assert.equal(pkgJson.scripts?.build, 'tsc');
  assert.equal(pkgJson.scripts?.test, 'node --test test/*.test.ts');

  const indexSrc = await readFile(path.join(adapterDir, 'src', 'index.ts'), 'utf8');
  assert.match(indexSrc, /name: 'deepseek'/);
  assert.match(indexSrc, /binary: 'deepseek'/);
  assert.doesNotMatch(indexSrc, /\{\{name\}\}/);

  const generatedTest = await readFile(path.join(adapterDir, 'test', 'adapter.test.ts'), 'utf8');
  assert.match(generatedTest, /adapter\.name, 'deepseek'/);
  assert.doesNotMatch(generatedTest, /\{\{name\}\}/);

  const tsconfig = JSON.parse(await readFile(path.join(adapterDir, 'tsconfig.json'), 'utf8')) as {
    compilerOptions?: { strict?: boolean };
  };
  assert.equal(tsconfig.compilerOptions?.strict, true);
});

test('missing adapter name fails with a usage message and writes nothing', async () => {
  const cwd = await makeTempDir();
  const { code, stderr } = await runCli([], cwd);

  assert.notEqual(code, 0);
  assert.match(stderr, /Usage: create-mmbridge-adapter <adapter-name>/);
  assert.deepEqual(await readdir(cwd), []);
});
