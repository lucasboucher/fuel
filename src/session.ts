import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ExtensionContext, SecretStorage } from 'vscode';

const API_KEY_SECRET = 'fuel.apiKey';
const EMAIL_KEY = 'cursorAuth/cachedEmail';

export function stateDbPath(home = homedir(), platform = process.platform): string {
  if (platform === 'darwin') {
    return join(
      home,
      'Library',
      'Application Support',
      'Cursor',
      'User',
      'globalStorage',
      'state.vscdb',
    );
  }
  if (platform === 'win32') {
    const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
    return join(appData, 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  }
  return join(home, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
}

export function readCachedEmail(dbPath = stateDbPath()): string | undefined {
  const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 1_000 });
  try {
    const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(EMAIL_KEY) as
      | { value: string | Uint8Array }
      | undefined;
    if (!row) {
      return undefined;
    }
    const value =
      typeof row.value === 'string' ? row.value : Buffer.from(row.value).toString('utf8');
    const email = value.trim();
    return email.length > 0 ? email : undefined;
  } finally {
    db.close();
  }
}

export async function withTimeout<T>(promise: Thenable<T> | Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export class ApiKeyStore {
  constructor(private readonly secrets: SecretStorage) {}

  static fromContext(context: ExtensionContext): ApiKeyStore {
    return new ApiKeyStore(context.secrets);
  }

  get(): Thenable<string | undefined> {
    return this.secrets.get(API_KEY_SECRET);
  }

  set(value: string): Thenable<void> {
    return this.secrets.store(API_KEY_SECRET, value.trim());
  }

  clear(): Thenable<void> {
    return this.secrets.delete(API_KEY_SECRET);
  }
}
