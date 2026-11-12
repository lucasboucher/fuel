import { basename } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { defaultStateDbPath } from './session.js';

const TITLE_QUERY_CHUNK = 200;

export const UNASSIGNED_PROJECT_NAME = 'Sans projet';

export type ConversationLabel = {
  title?: string;
  projectName: string;
};

type ComposerLabel = {
  title?: string;
  projectName?: string;
};

/** Labels from composerHeaders (title, workspace folder). */
export function readConversationLabels(
  ids: ReadonlySet<string>,
  dbPath = defaultStateDbPath(),
): Map<string, ConversationLabel> {
  const labels = new Map<string, ConversationLabel>();
  for (const [id, composer] of readComposerLabels(ids, dbPath)) {
    labels.set(id, {
      ...(composer.title ? { title: composer.title } : {}),
      projectName: composer.projectName ?? UNASSIGNED_PROJECT_NAME,
    });
  }
  return labels;
}

export function readComposerLabels(
  ids: ReadonlySet<string>,
  dbPath = defaultStateDbPath(),
): Map<string, ComposerLabel> {
  const labels = new Map<string, ComposerLabel>();
  if (ids.size === 0) {
    return labels;
  }

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true, timeout: 1_000 });
  } catch {
    return labels;
  }

  try {
    const idList = [...ids];
    for (let offset = 0; offset < idList.length; offset += TITLE_QUERY_CHUNK) {
      const chunk = idList.slice(offset, offset + TITLE_QUERY_CHUNK);
      const placeholders = chunk.map(() => '?').join(', ');
      const rows = db
        .prepare(
          `SELECT composerId, value FROM composerHeaders WHERE composerId IN (${placeholders})`,
        )
        .all(...chunk) as Array<{ composerId: string; value: unknown }>;
      for (const row of rows) {
        const label = composerHeaderLabel(row.value);
        if (label.title || label.projectName) {
          labels.set(row.composerId, label);
        }
      }
    }
  } catch {
    return labels;
  } finally {
    db.close();
  }
  return labels;
}

function composerHeaderLabel(value: unknown): ComposerLabel {
  try {
    const text =
      typeof value === 'string'
        ? value
        : value instanceof Uint8Array
          ? Buffer.from(value).toString('utf8')
          : undefined;
    if (!text) {
      return {};
    }
    const parsed = JSON.parse(text) as {
      name?: unknown;
      workspaceIdentifier?: { uri?: { fsPath?: unknown } };
    };
    const title =
      typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : undefined;
    const fsPath = parsed.workspaceIdentifier?.uri?.fsPath;
    const projectName =
      typeof fsPath === 'string' && fsPath.trim()
        ? basename(fsPath.trim()) || undefined
        : undefined;
    return {
      ...(title ? { title } : {}),
      ...(projectName ? { projectName } : {}),
    };
  } catch {
    return {};
  }
}
