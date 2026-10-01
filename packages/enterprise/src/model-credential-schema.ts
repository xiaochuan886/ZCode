import { DatabaseSync } from "node:sqlite";

/** Upgrade v2 credential rows without parsing or rewriting legacy fixed-provider records. */
export function ensureModelCredentialMetadataColumns(db: DatabaseSync): void {
  if (
    !db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='model_credentials'")
      .get()
  )
    return;
  const columns = new Set(
    (db.prepare("PRAGMA table_info(model_credentials)").all() as Record<string, unknown>[]).map(
      (column) => String(column.name),
    ),
  );
  const additions = [
    ["provider_name", "TEXT"],
    ["api_type", "TEXT"],
    ["base_url", "TEXT"],
    ["model_id", "TEXT"],
  ] as const;
  const missing = additions.filter(([name]) => !columns.has(name));
  if (!missing.length) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const [name, definition] of missing) {
      db.exec(`ALTER TABLE model_credentials ADD COLUMN ${name} ${definition}`);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
