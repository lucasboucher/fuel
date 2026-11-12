import { execFile } from 'node:child_process';
import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function defaultStateDbPath(): string {
  return join(
    homedir(),
    'Library',
    'Application Support',
    'Cursor',
    'User',
    'globalStorage',
    'state.vscdb',
  );
}

const STATE_DB_PATH = defaultStateDbPath();
const CACHED_EMAIL_KEY = 'cursorAuth/cachedEmail';
const CACHED_PROFILE_KEY = 'cursorAuth/cachedScopedProfile';
const CACHED_TEAM_KEY = 'cursorAuth/cachedTeam';
const ACCESS_TOKEN_KEY = 'cursorAuth/accessToken';
const SAFE_STORAGE_PREFIX = 'cursor-safe-storage:v1:';
const CHROMIUM_V10_PREFIX = 'v10';
const CHROMIUM_SALT = 'saltysalt';
const CHROMIUM_ITERATIONS = 1003;
const KEYCHAIN_TIMEOUT_MS = 20_000;
const TOKEN_EXPIRY_MARGIN_SECONDS = 60;

export type CursorAccount = {
  email: string;
  displayName: string;
  teamName: string;
};

export function parseCursorAccount(
  email: string | undefined,
  profileJson: string | undefined,
  teamJson: string | undefined,
): CursorAccount | undefined {
  const trimmedEmail = email?.trim();
  const displayName = jsonText(profileJson, 'displayName');
  const teamName = jsonText(teamJson, 'name');
  if (!trimmedEmail || !displayName || !teamName) {
    return undefined;
  }
  return { email: trimmedEmail, displayName, teamName };
}

export function readCachedAccount(): CursorAccount | undefined {
  try {
    return parseCursorAccount(
      readStateItem(CACHED_EMAIL_KEY),
      readStateItem(CACHED_PROFILE_KEY),
      readStateItem(CACHED_TEAM_KEY),
    );
  } catch {
    return undefined;
  }
}

export type SessionCookie =
  | { status: 'ready'; value: string }
  | { status: 'missing' }
  | { status: 'expired' };

export async function readSessionCookie(): Promise<SessionCookie> {
  const read = await readAccessToken();
  if (read.status !== 'ready') {
    return read;
  }
  const value = buildSessionCookie(read.accessToken);
  return value ? { status: 'ready', value } : { status: 'missing' };
}

export function decryptAccessToken(sealed: string, password: string): string | undefined {
  if (!sealed.startsWith(SAFE_STORAGE_PREFIX)) {
    return undefined;
  }
  try {
    const decoded = Buffer.from(sealed.slice(SAFE_STORAGE_PREFIX.length), 'base64');
    if (decoded.subarray(0, CHROMIUM_V10_PREFIX.length).toString('utf8') !== CHROMIUM_V10_PREFIX) {
      return undefined;
    }
    const key = pbkdf2Sync(password, CHROMIUM_SALT, CHROMIUM_ITERATIONS, 16, 'sha1');
    const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '));
    const accessToken = Buffer.concat([
      decipher.update(decoded.subarray(CHROMIUM_V10_PREFIX.length)),
      decipher.final(),
    ]).toString('utf8');
    return decodeJwtPayload(accessToken) ? accessToken : undefined;
  } catch {
    return undefined;
  }
}

export function buildSessionCookie(accessToken: string): string | undefined {
  const userId = decodeJwtPayload(accessToken)?.sub;
  if (typeof userId !== 'string' || userId.trim().length === 0) {
    return undefined;
  }
  return `WorkosCursorSessionToken=${encodeURIComponent(`${userId}::${accessToken}`)}`;
}

let accessTokenCache: { stored: string; accessToken: string } | undefined;

type AccessTokenRead = { status: 'ready'; accessToken: string } | { status: 'missing' | 'expired' };

async function readAccessToken(): Promise<AccessTokenRead> {
  let stored: string | undefined;
  try {
    stored = readStateItem(ACCESS_TOKEN_KEY);
  } catch {
    return { status: 'missing' };
  }
  if (!stored) {
    return { status: 'missing' };
  }
  if (accessTokenCache?.stored === stored && isJwtUnexpired(accessTokenCache.accessToken)) {
    return { status: 'ready', accessToken: accessTokenCache.accessToken };
  }
  let accessToken: string | undefined;
  if (stored.startsWith(SAFE_STORAGE_PREFIX)) {
    const password = await readSafeStoragePassword();
    accessToken = password ? decryptAccessToken(stored, password) : undefined;
  } else {
    accessToken = decodeJwtPayload(stored) ? stored : undefined;
  }
  if (!accessToken) {
    return { status: 'missing' };
  }
  if (!isJwtUnexpired(accessToken)) {
    return { status: 'expired' };
  }
  accessTokenCache = { stored, accessToken };
  return { status: 'ready', accessToken };
}

function readStateItem(key: string): string | undefined {
  const db = new DatabaseSync(STATE_DB_PATH, { readOnly: true, timeout: 1_000 });
  try {
    const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    const value = row?.value.trim();
    return value ? value : undefined;
  } finally {
    db.close();
  }
}

function jsonText(value: string | undefined, field: string): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      return undefined;
    }
    const text = (parsed as Record<string, unknown>)[field];
    return typeof text === 'string' && text.trim().length > 0 ? text.trim() : undefined;
  } catch {
    return undefined;
  }
}

function readSafeStoragePassword(): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      '/usr/bin/security',
      ['find-generic-password', '-s', 'Cursor Safe Storage', '-a', 'Cursor Key', '-w'],
      { encoding: 'utf8', timeout: KEYCHAIN_TIMEOUT_MS },
      (error: Error | null, stdout: string) => {
        if (error) {
          resolve(undefined);
          return;
        }
        const password = stdout.trim();
        resolve(password.length > 0 ? password : undefined);
      },
    );
  });
}

function isJwtUnexpired(token: string): boolean {
  const expiresAt = decodeJwtPayload(token)?.exp;
  return (
    typeof expiresAt === 'number' &&
    Number.isFinite(expiresAt) &&
    expiresAt > Date.now() / 1000 + TOKEN_EXPIRY_MARGIN_SECONDS
  );
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) {
    return undefined;
  }
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as unknown;
    if (!payload || typeof payload !== 'object') {
      return undefined;
    }
    return payload as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
