import { exec } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execAsync = promisify(exec);
const SERVICE_NAME = 'com.mmbridge.auth';
const FALLBACK_PATH = join(homedir(), '.mmbridge', '.credentials');
const ALGORITHM = 'aes-256-gcm';
const SCRYPT_SALT = 'mmbridge-keychain-v1';
const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;

function deriveKey(password: string): Buffer {
  return scryptSync(password, SCRYPT_SALT, KEY_LEN) as Buffer;
}

function getMachineId(): string {
  return process.env.MMBRIDGE_MACHINE_ID ?? process.env.USER ?? 'mmbridge';
}

function encrypt(plaintext: string): string {
  const key = deriveKey(getMachineId());
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function decrypt(ciphertext: string): string {
  const key = deriveKey(getMachineId());
  const buf = Buffer.from(ciphertext, 'base64');
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const encrypted = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(encrypted) + decipher.final('utf-8');
}

interface CredentialStore {
  [key: string]: string;
}

async function readFallbackStore(): Promise<CredentialStore> {
  try {
    const raw = await readFile(FALLBACK_PATH, 'utf-8');
    const decrypted = decrypt(raw.trim());
    const parsed: unknown = JSON.parse(decrypted);
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed as CredentialStore;
    }
    return {};
  } catch {
    return {};
  }
}

async function writeFallbackStore(store: CredentialStore): Promise<void> {
  await mkdir(join(homedir(), '.mmbridge'), { recursive: true });
  const encrypted = encrypt(JSON.stringify(store));
  await writeFile(FALLBACK_PATH, encrypted, { encoding: 'utf-8', mode: 0o600 });
  await chmod(FALLBACK_PATH, 0o600);
}

export class KeychainStorage {
  private readonly isMacOS: boolean;

  constructor() {
    this.isMacOS = process.platform === 'darwin';
  }

  async store(service: string, account: string, password: string): Promise<void> {
    if (this.isMacOS) {
      try {
        await this.macosStore(service, account, password);
        return;
      } catch {
        // fall through to encrypted file
      }
    }
    await this.fallbackStore(service, account, password);
  }

  async retrieve(service: string, account: string): Promise<string | null> {
    if (this.isMacOS) {
      try {
        return await this.macosRetrieve(service, account);
      } catch {
        // fall through to encrypted file
      }
    }
    return this.fallbackRetrieve(service, account);
  }

  async remove(service: string, account: string): Promise<void> {
    if (this.isMacOS) {
      try {
        await this.macosRemove(service, account);
      } catch {
        // ignore if not found
      }
    }
    await this.fallbackRemove(service, account);
  }

  private async macosStore(service: string, account: string, password: string): Promise<void> {
    // Delete first to avoid duplicate errors
    try {
      await execAsync(
        `security delete-generic-password -s ${shellEscape(service)} -a ${shellEscape(account)} 2>/dev/null`,
      );
    } catch {
      // ignore if not found
    }
    await execAsync(
      `security add-generic-password -s ${shellEscape(service)} -a ${shellEscape(account)} -w ${shellEscape(password)}`,
    );
  }

  private async macosRetrieve(service: string, account: string): Promise<string | null> {
    try {
      const { stdout } = await execAsync(
        `security find-generic-password -s ${shellEscape(service)} -a ${shellEscape(account)} -w`,
      );
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  private async macosRemove(service: string, account: string): Promise<void> {
    await execAsync(`security delete-generic-password -s ${shellEscape(service)} -a ${shellEscape(account)}`);
  }

  private async fallbackStore(service: string, account: string, password: string): Promise<void> {
    const store = await readFallbackStore();
    store[`${service}:${account}`] = password;
    await writeFallbackStore(store);
  }

  private async fallbackRetrieve(service: string, account: string): Promise<string | null> {
    const store = await readFallbackStore();
    return store[`${service}:${account}`] ?? null;
  }

  private async fallbackRemove(service: string, account: string): Promise<void> {
    const store = await readFallbackStore();
    delete store[`${service}:${account}`];
    await writeFallbackStore(store);
  }
}

export const keychain = new KeychainStorage();

export function storeProviderToken(provider: string, token: string): Promise<void> {
  return keychain.store(SERVICE_NAME, provider, token);
}

export function retrieveProviderToken(provider: string): Promise<string | null> {
  return keychain.retrieve(SERVICE_NAME, provider);
}

export function removeProviderToken(provider: string): Promise<void> {
  return keychain.remove(SERVICE_NAME, provider);
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
