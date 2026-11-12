import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createCipheriv, pbkdf2Sync } from 'node:crypto';
import sqlite from 'node:sqlite';
import { test } from 'node:test';
import {
  buildSessionCookie,
  decryptAccessToken,
  parseCursorAccount,
  readSessionCookie,
} from '../session.js';

test('opens a sealed v10 editor access token', () => {
  const token = jwt({ sub: 'user_1', exp: 4_102_444_800 });
  const sealed = sealCursorToken(token, 'secret');
  assert.equal(decryptAccessToken(sealed, 'secret'), token);
  assert.equal(decryptAccessToken(sealed, 'wrong'), undefined);
  assert.equal(decryptAccessToken(token, 'secret'), undefined);
});

test('reads plaintext sessions without the keychain and rejects invalid tokens', async (t) => {
  let stored = jwt({ sub: 'auth0|user_1', exp: 4_102_444_800 });
  t.mock.method(
    sqlite,
    'DatabaseSync',
    class extends sqlite.DatabaseSync {
      constructor() {
        super(':memory:');
        this.exec('CREATE TABLE ItemTable (key TEXT, value TEXT)');
        this.prepare('INSERT INTO ItemTable VALUES (?, ?)').run('cursorAuth/accessToken', stored);
      }
    },
  );
  const keychain = t.mock.method(childProcess, 'execFile', () => {
    throw new Error('Unexpected Keychain call');
  });

  assert.deepEqual(await readSessionCookie(), {
    status: 'ready',
    value: buildSessionCookie(stored),
  });
  stored = 'not-a-token';
  assert.deepEqual(await readSessionCookie(), { status: 'missing' });
  stored = jwt({ sub: 'auth0|user_1', exp: 1 });
  assert.deepEqual(await readSessionCookie(), { status: 'expired' });
  assert.equal(keychain.mock.callCount(), 0);
});

test('reads an account only when email, name, and team are present', () => {
  const profile = JSON.stringify({ displayName: ' Ada Lovelace ' });
  const team = JSON.stringify({ name: 'Analytical' });
  assert.deepEqual(parseCursorAccount(' ada@example.com ', profile, team), {
    email: 'ada@example.com',
    displayName: 'Ada Lovelace',
    teamName: 'Analytical',
  });
  assert.equal(parseCursorAccount(undefined, profile, team), undefined);
  assert.equal(parseCursorAccount('ada@example.com', '{', team), undefined);
  assert.equal(
    parseCursorAccount('ada@example.com', JSON.stringify({ displayName: ' ' }), team),
    undefined,
  );
  assert.equal(
    parseCursorAccount('ada@example.com', profile, JSON.stringify({ name: 1 })),
    undefined,
  );
});

test('builds the dashboard session cookie from the token subject', () => {
  const token = jwt({ sub: 'user_1' });
  assert.equal(
    buildSessionCookie(token),
    `WorkosCursorSessionToken=${encodeURIComponent(`user_1::${token}`)}`,
  );
  assert.equal(buildSessionCookie(jwt({})), undefined);
});

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode(payload)}.sig`;
}

function sealCursorToken(plain: string, password: string): string {
  const key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '));
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `cursor-safe-storage:v1:${Buffer.concat([Buffer.from('v10'), body]).toString('base64')}`;
}
