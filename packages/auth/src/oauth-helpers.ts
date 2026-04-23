import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface OAuthCallbackResult {
  code: string;
  state: string;
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

export function isTokenResponse(value: unknown): value is TokenResponse {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.access_token === 'string';
}

export function waitForCallback(port: number, expectedState: string): Promise<OAuthCallbackResult> {
  return new Promise((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`);
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><h1>Authorization failed</h1><p>You may close this tab.</p></body></html>');
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (!code || !state || state !== expectedState) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<html><body><h1>Bad request</h1></body></html>');
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        '<html><body><h1>Authorization successful</h1><p>You may close this tab and return to mmbridge.</p></body></html>',
      );
      server.close();
      resolve({ code, state });
    });

    server.listen(port, '127.0.0.1', () => {});
    server.on('error', (err) => {
      reject(new Error(`Local server error: ${err.message}`));
    });
    setTimeout(
      () => {
        server.close();
        reject(new Error('OAuth flow timed out after 5 minutes'));
      },
      5 * 60 * 1000,
    );
  });
}

export async function getEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      server.close(() => resolve(address.port));
    });
    server.on('error', reject);
  });
}

export async function openBrowser(url: string): Promise<void> {
  const { exec } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execAsync = promisify(exec);

  const platform = process.platform;
  const command =
    platform === 'darwin'
      ? `open ${shellEscape(url)}`
      : platform === 'win32'
        ? `start "" ${shellEscape(url)}`
        : `xdg-open ${shellEscape(url)}`;

  try {
    await execAsync(command);
  } catch {
    process.stderr.write(`\nOpen this URL to authenticate:\n  ${url}\n\n`);
  }
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
