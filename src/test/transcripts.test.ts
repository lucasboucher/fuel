import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { readConversationLabels } from '../transcripts.js';

function writeComposerDb(
  dbPath: string,
  rows: Array<{ id: string; name?: string; fsPath?: string }>,
): void {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE composerHeaders (
      composerId TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  const insert = db.prepare(`INSERT INTO composerHeaders (composerId, value) VALUES (?, ?)`);
  for (const row of rows) {
    insert.run(
      row.id,
      JSON.stringify({
        ...(row.name !== undefined ? { name: row.name } : {}),
        ...(row.fsPath ? { workspaceIdentifier: { uri: { fsPath: row.fsPath } } } : {}),
      }),
    );
  }
  db.close();
}

test('readConversationLabels uses workspace folder from composerHeaders', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fuel-labels-'));
  const dbPath = join(dir, 'state.vscdb');
  const id = '8f2e4a1b-6c3d-4e5f-9a7b-2d1c8e6f4a3b';
  writeComposerDb(dbPath, [
    {
      id,
      name: 'Integration of cursor packages',
      fsPath: '/Users/lucas/dev/bpifrance/ai-design-ops/skills-hub',
    },
  ]);

  const labels = readConversationLabels(new Set([id, 'missing-id']), dbPath);
  assert.deepEqual(labels.get(id), {
    title: 'Integration of cursor packages',
    projectName: 'skills-hub',
  });
  assert.equal(labels.has('missing-id'), false);
});
