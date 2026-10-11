import path from 'node:path';

export function resolveProjectDir(option: string | undefined): string {
  return option ? path.resolve(option) : process.cwd();
}

export function jsonOutput(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

export function exitWithError(message: string, code = 1): never {
  process.stderr.write(`[mmbridge] ${message}\n`);
  process.exit(code);
  throw new Error('unreachable');
}

// Lazy dependency loaders — keeps `mmbridge --help` fast
export const importCore = () => import('@mmbridge/core');
export const importAdapters = async (projectDir = process.cwd()) => {
  const adapters = await import('@mmbridge/adapters');
  await adapters.initRegistry(projectDir);
  return adapters;
};
export const importSessionStore = () => import('@mmbridge/session-store');
export const importTui = () => import('@mmbridge/tui');
export const importIntegrations = () => import('@mmbridge/integrations');
export const importAps = () => import('@mmbridge/aps');
